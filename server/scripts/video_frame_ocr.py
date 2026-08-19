"""Extract visible text evidence from locally sampled video frames.

This wrapper uses RapidOCR's packaged ONNX models. It reads only local frame
files produced by the video pipeline and writes one compact JSON artifact.
"""

import argparse
import json
import pathlib
import sys
from typing import Any


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_FRAMES = 12
MAX_LINES = 80
MAX_TEXT = 1200
SCHEMA_VERSION = 2


def clean_text(value: Any, maximum: int = 240) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split()).strip()[:maximum]


def finite_score(value: Any) -> float | None:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    return round(score, 4) if 0 <= score <= 1 else None


def normalize_box(value: Any) -> list[list[int]]:
    if not isinstance(value, (list, tuple)):
        return []
    points: list[list[int]] = []
    for point in value[:4]:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        try:
            points.append([int(round(float(point[0]))), int(round(float(point[1])))])
        except (TypeError, ValueError):
            continue
    return points


def normalize_modern_result(result: Any) -> list[dict[str, Any]]:
    texts = getattr(result, "txts", None)
    if not isinstance(texts, (list, tuple)):
        return []
    boxes = getattr(result, "boxes", None)
    scores = getattr(result, "scores", None)
    lines: list[dict[str, Any]] = []
    for index, raw_text in enumerate(texts[:MAX_LINES]):
        value = clean_text(raw_text)
        if not value:
            continue
        line: dict[str, Any] = {"text": value}
        score = finite_score(scores[index] if isinstance(scores, (list, tuple)) and index < len(scores) else None)
        if score is not None:
            line["score"] = score
        try:
            raw_box = boxes[index] if boxes is not None and index < len(boxes) else None
        except (TypeError, IndexError):
            raw_box = None
        box = normalize_box(raw_box.tolist() if hasattr(raw_box, "tolist") else raw_box)
        if box:
            line["box"] = box
        lines.append(line)
    return lines


def normalize_result(result: Any) -> list[dict[str, Any]]:
    modern_lines = normalize_modern_result(result)
    if modern_lines:
        return modern_lines
    rows = result[0] if isinstance(result, tuple) and result else result
    if not isinstance(rows, list):
        return []
    lines: list[dict[str, Any]] = []
    for row in rows[:MAX_LINES]:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        value = clean_text(row[1])
        if not value:
            continue
        line: dict[str, Any] = {"text": value}
        score = finite_score(row[2] if len(row) > 2 else None)
        if score is not None:
            line["score"] = score
        box = normalize_box(row[0])
        if box:
            line["box"] = box
        lines.append(line)
    return lines


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run RapidOCR over sampled video frames.")
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-file", required=True)
    return parser.parse_args()


def write_output(output_file: str, payload: dict[str, Any]) -> None:
    path = pathlib.Path(output_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")


def availability(
    state: str,
    code: str,
    engine: str = "",
    processed_frame_count: int = 0,
    recognized_frame_count: int = 0,
    failed_frame_count: int = 0,
) -> dict[str, Any]:
    """Return only stable, non-sensitive OCR runtime diagnostics."""
    return {
        "state": state,
        "code": code,
        "engine": engine,
        "processedFrameCount": processed_frame_count,
        "recognizedFrameCount": recognized_frame_count,
        "failedFrameCount": failed_frame_count,
    }


def module_error_code(error: BaseException) -> str:
    module_name = str(getattr(error, "name", "") or "").lower()
    if module_name.startswith("onnxruntime"):
        return "ONNXRUNTIME_UNAVAILABLE"
    if module_name.startswith("cv2"):
        return "OPENCV_UNAVAILABLE"
    if module_name.startswith("numpy"):
        return "NUMPY_UNAVAILABLE"
    if module_name.startswith("rapidocr"):
        return "RAPIDOCR_PACKAGE_UNAVAILABLE"
    return "RAPIDOCR_DEPENDENCY_UNAVAILABLE"


def model_error(error: BaseException) -> bool:
    if isinstance(error, FileNotFoundError):
        return True
    message = str(error).lower()
    return "model" in message and any(token in message for token in ("not found", "no such", "missing", "download"))


def create_engine() -> tuple[Any, str, dict[str, Any] | None]:
    """Resolve both supported RapidOCR distributions without downloading anything."""
    import_failures: list[BaseException] = []
    try:
        from rapidocr import RapidOCR

        return RapidOCR(), "rapidocr", None
    except (ModuleNotFoundError, ImportError) as error:
        import_failures.append(error)
    except Exception as error:
        state = "model_unavailable" if model_error(error) else "ocr_failed"
        code = "RAPIDOCR_MODEL_UNAVAILABLE" if state == "model_unavailable" else "RAPIDOCR_ENGINE_INIT_FAILED"
        return None, "", availability(state, code)

    try:
        from rapidocr_onnxruntime import RapidOCR

        return RapidOCR(), "rapidocr_onnxruntime", None
    except (ModuleNotFoundError, ImportError) as error:
        import_failures.append(error)
    except Exception as error:
        state = "model_unavailable" if model_error(error) else "ocr_failed"
        code = "RAPIDOCR_MODEL_UNAVAILABLE" if state == "model_unavailable" else "RAPIDOCR_ENGINE_INIT_FAILED"
        return None, "", availability(state, code)

    dependency_codes = {module_error_code(error) for error in import_failures}
    code = next((candidate for candidate in (
        "ONNXRUNTIME_UNAVAILABLE",
        "OPENCV_UNAVAILABLE",
        "NUMPY_UNAVAILABLE",
        "RAPIDOCR_PACKAGE_UNAVAILABLE",
    ) if candidate in dependency_codes), "RAPIDOCR_DEPENDENCY_UNAVAILABLE")
    return None, "", availability("dependency_unavailable", code)


def main() -> int:
    args = parse_args()
    input_dir = pathlib.Path(args.input_dir)
    frames = sorted(
        path for path in input_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )[:MAX_FRAMES] if input_dir.is_dir() else []
    if not frames:
        write_output(args.output_file, {
            "schemaVersion": SCHEMA_VERSION,
            "status": "completed",
            "frames": [],
            "availability": availability("ready", "RAPIDOCR_NOT_APPLICABLE"),
        })
        return 0
    engine, engine_name, diagnostic = create_engine()
    if engine is None:
        diagnostic = diagnostic or availability("ocr_failed", "RAPIDOCR_ENGINE_INIT_FAILED")
        write_output(args.output_file, {
            "schemaVersion": SCHEMA_VERSION,
            "status": diagnostic["state"],
            "frames": [],
            "availability": diagnostic,
        })
        return 2

    output_frames = []
    failed_frame_count = 0
    recognized_frame_count = 0
    for frame in frames:
        try:
            lines = normalize_result(engine(str(frame)))
        except Exception:
            # Preserve other sampled frames. A transient decode/model issue on one
            # frame must not erase OCR evidence from the remainder of the video.
            lines = []
            failed_frame_count += 1
        frame_text = clean_text(" ".join(line["text"] for line in lines), MAX_TEXT)
        if frame_text:
            recognized_frame_count += 1
        output_frames.append({
            "file": frame.name,
            "text": frame_text,
            "lines": lines,
        })

    if failed_frame_count == len(frames):
        state = "ocr_failed"
        code = "RAPIDOCR_FRAME_EXECUTION_FAILED"
        exit_code = 2
    elif failed_frame_count:
        state = "completed"
        code = "RAPIDOCR_PARTIAL_FRAME_FAILURE"
        exit_code = 0
    else:
        state = "completed"
        code = "RAPIDOCR_READY"
        exit_code = 0
    write_output(args.output_file, {
        "schemaVersion": SCHEMA_VERSION,
        "status": state,
        "frames": output_frames,
        "availability": availability(
            "failed" if failed_frame_count == len(frames) else ("degraded" if failed_frame_count else "ready"),
            code,
            engine_name,
            len(frames),
            recognized_frame_count,
            failed_frame_count,
        ),
    })
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
