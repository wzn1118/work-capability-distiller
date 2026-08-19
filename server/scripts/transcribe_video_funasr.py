"""Run a local FunASR model over one locally stored media file.

The sidecar deliberately accepts filesystem paths only.  It forces common model
hubs into offline mode and blocks socket connections before loading FunASR, so a
missing dependency or model produces a stable local error artifact instead of a
download attempt.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import re
import socket
import sys
from typing import Any, Iterable


LOCAL_PATH_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
SAFE_DEVICE = re.compile(r"^(?:cpu|cuda(?::\d+)?|mps|auto)$", re.IGNORECASE)
SAFE_LANGUAGE = re.compile(r"^[A-Za-z0-9_-]{1,24}$")


def clean_text(value: Any, maximum: int = 0) -> str:
    if not isinstance(value, str):
        return ""
    normalized = " ".join(value.split()).strip()
    return normalized[:maximum] if maximum > 0 else normalized


def write_output(output_file: str, payload: dict[str, Any]) -> None:
    path = pathlib.Path(output_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=True, separators=(",", ":")),
        encoding="utf-8",
    )


def failure(output_file: str, error_code: str) -> int:
    try:
        write_output(
            output_file,
            {
                "schemaVersion": 1,
                "status": "failed",
                "text": "",
                "segments": [],
                "errorCode": error_code,
            },
        )
    except OSError:
        pass
    return 2


def local_file(value: str) -> pathlib.Path | None:
    if not value or LOCAL_PATH_SCHEME.match(value) or value.replace("/", "\\").startswith("\\\\"):
        return None
    try:
        path = pathlib.Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return path if path.is_file() and not str(path).replace("/", "\\").startswith("\\\\") else None


def local_directory(value: str) -> pathlib.Path | None:
    if not value or LOCAL_PATH_SCHEME.match(value) or value.replace("/", "\\").startswith("\\\\"):
        return None
    try:
        path = pathlib.Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return path if path.is_dir() and not str(path).replace("/", "\\").startswith("\\\\") else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe one local media file with a local FunASR model.")
    parser.add_argument("--input-file", required=True)
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--language", default="zh")
    return parser.parse_args()


def block_network() -> None:
    """Keep imports and model loading from reaching model hubs or remote services."""

    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE", "MODELSCOPE_OFFLINE"):
        os.environ[key] = "1"

    def denied(*_args: Any, **_kwargs: Any) -> Any:
        raise OSError("network disabled for local transcription")

    socket.create_connection = denied
    socket.socket.connect = denied
    socket.socket.connect_ex = denied


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def seconds(value: Any, unit: str = "milliseconds") -> float | None:
    number = finite_number(value)
    if number is None or number < 0:
        return None
    if unit == "milliseconds":
        number /= 1000
    return round(number, 2)


def range_from_timestamp(value: Any, unit: str = "milliseconds") -> tuple[float | None, float | None]:
    pairs: list[tuple[Any, Any]] = []
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        if not isinstance(value[0], (list, tuple)):
            pairs.append((value[0], value[1]))
        else:
            for item in value:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    pairs.append((item[0], item[1]))
    if not pairs:
        return None, None
    starts = [seconds(start, unit) for start, _end in pairs]
    ends = [seconds(end, unit) for _start, end in pairs]
    start = next((item for item in starts if item is not None), None)
    end = next((item for item in reversed(ends) if item is not None), None)
    return start, end


def record_range(record: dict[str, Any]) -> tuple[float | None, float | None]:
    timestamp = record.get("timestamp") or record.get("timestamps")
    start, end = range_from_timestamp(timestamp)
    if start is not None or end is not None:
        return start, end

    start_value = next((record.get(key) for key in ("start", "begin", "start_time", "start_ms") if key in record), None)
    end_value = next((record.get(key) for key in ("end", "finish", "end_time", "end_ms") if key in record), None)
    # FunASR sentence_info uses millisecond offsets.  Explicit *Seconds keys
    # are retained as seconds for wrappers that already normalize values.
    unit = "seconds" if "startSeconds" in record or "endSeconds" in record else "milliseconds"
    if "startSeconds" in record:
        start_value = record.get("startSeconds")
    if "endSeconds" in record:
        end_value = record.get("endSeconds")
    return seconds(start_value, unit), seconds(end_value, unit)


def record_text(record: dict[str, Any]) -> str:
    for key in ("text", "sentence", "transcription", "content"):
        value = clean_text(record.get(key))
        if value:
            return value
    return ""


def records_from_result(result: Any) -> Iterable[dict[str, Any]]:
    if isinstance(result, dict):
        yield result
    elif isinstance(result, (list, tuple)):
        for item in result:
            if isinstance(item, dict):
                yield item


def collect_segments(result: Any) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for row in records_from_result(result):
        sentence_info = row.get("sentence_info") or row.get("sentences") or row.get("segments")
        source_records = sentence_info if isinstance(sentence_info, list) else [row]
        for source in source_records:
            if not isinstance(source, dict):
                continue
            segment_text = record_text(source)
            if not segment_text:
                continue
            start, end = record_range(source)
            if start is None and end is None and source is not row:
                start, end = record_range(row)
            if start is None or end is None or end < start:
                continue
            segments.append(
                {
                    "startSeconds": start,
                    "endSeconds": end,
                    "text": segment_text,
                }
            )
    return segments


def transcript_text(result: Any, segments: list[dict[str, Any]]) -> str:
    values = [record_text(row) for row in records_from_result(result)]
    output = " ".join(value for value in values if value).strip()
    if not output:
        output = " ".join(segment["text"] for segment in segments)
    # Preserve the complete local transcript artifact. The Node analysis layer
    # derives its own bounded evidence window for prompt and UI performance.
    return clean_text(output)


def run_model(input_file: pathlib.Path, model_dir: pathlib.Path, device: str, language: str) -> Any:
    block_network()
    from funasr import AutoModel  # Imported only after offline guards are active.

    model = AutoModel(model=str(model_dir), device=device)
    try:
        return model.generate(input=str(input_file), language=language)
    except TypeError:
        # Some local FunASR models do not expose a language argument.
        return model.generate(input=str(input_file))


def main() -> int:
    args = parse_args()
    if not SAFE_DEVICE.fullmatch(args.device or ""):
        return failure(args.output_file, "INVALID_DEVICE")
    if not SAFE_LANGUAGE.fullmatch(args.language or ""):
        return failure(args.output_file, "INVALID_LANGUAGE")

    input_file = local_file(args.input_file)
    if input_file is None:
        return failure(args.output_file, "LOCAL_INPUT_UNAVAILABLE")
    model_dir = local_directory(args.model_dir)
    if model_dir is None:
        return failure(args.output_file, "MODEL_UNAVAILABLE")

    try:
        result = run_model(input_file, model_dir, args.device, args.language)
    except ModuleNotFoundError:
        return failure(args.output_file, "FUNASR_UNAVAILABLE")
    except Exception:
        return failure(args.output_file, "TRANSCRIPTION_FAILED")

    segments = collect_segments(result)
    payload = {
        "schemaVersion": 1,
        "status": "completed",
        "text": transcript_text(result, segments),
        "segments": segments,
    }
    try:
        write_output(args.output_file, payload)
    except OSError:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
