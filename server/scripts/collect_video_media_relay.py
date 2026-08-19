"""Read public, rendered video metadata through the attached Browser Relay.

The persisted artifact intentionally excludes signed query strings. A temporary
runtime media URL is returned only in the single JSON object written to stdout
so the calling process can consume it in memory and immediately process it.
"""

import argparse
import hashlib
import hmac
import json
import math
import os
import pathlib
import re
import sys
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit


LOGIN_MARKERS = (
    "\u767b\u5f55\u540e\u67e5\u770b",
    "\u624b\u673a\u53f7\u767b\u5f55",
    "\u8bf7\u767b\u5f55",
    "\u767b\u5f55\u5373\u53ef",
    "\u767b\u5f55\u67e5\u770b\u66f4\u591a",
)
VERIFICATION_MARKERS = (
    "\u4eba\u673a\u9a8c\u8bc1",
    "\u5b89\u5168\u9a8c\u8bc1",
    "\u8bf7\u5b8c\u6210\u9a8c\u8bc1",
    "\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41",
    "\u5f02\u5e38\u8bbf\u95ee",
)
PLATFORM_DOMAINS = {
    "douyin": "douyin.com",
    "xiaohongshu": "xiaohongshu.com",
}

EXIT_SUCCESS = 0
EXIT_LOGIN_REQUIRED = 2
EXIT_VERIFICATION_REQUIRED = 3
EXIT_MEDIA_NOT_RENDERED = 4
EXIT_INVALID_INPUT = 5
EXIT_RELAY_ERROR = 6


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def is_platform_url(platform: str, value: Any) -> bool:
    """Return whether value is an HTTPS URL on the selected public platform."""
    if platform not in PLATFORM_DOMAINS or not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return False
    domain = PLATFORM_DOMAINS[platform]
    host = (parsed.hostname or "").lower()
    return parsed.scheme.lower() == "https" and bool(host) and (host == domain or host.endswith(f".{domain}"))


def scrub_https_url(value: Any) -> str:
    """Keep only a public HTTPS origin and path; drop all query and fragment data."""
    if not isinstance(value, str):
        return ""
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return ""
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        return ""
    try:
        port = parsed.port
    except ValueError:
        return ""
    host = parsed.hostname.lower()
    host_part = f"[{host}]" if ":" in host and not host.startswith("[") else host
    netloc = f"{host_part}:{port}" if port is not None else host_part
    return urlunsplit(("https", netloc, parsed.path or "/", "", ""))


def finite_number(value: Any, maximum: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    if maximum is not None and number > maximum:
        return None
    return number


def non_negative_int(value: Any, maximum: int = 20000) -> int | None:
    number = finite_number(value, maximum)
    if number is None:
        return None
    return int(number) if number > 0 else None


def access_state(page_url: Any, visible_text: Any) -> str:
    """Classify visible login and verification walls without retaining page text."""
    url = page_url.lower() if isinstance(page_url, str) else ""
    text = visible_text.lower() if isinstance(visible_text, str) else ""
    if any(marker in url for marker in ("/captcha", "/security/verify", "/website-login/captcha")):
        return "verification_required"
    if any(marker.lower() in text for marker in VERIFICATION_MARKERS):
        return "verification_required"
    if any(marker.lower() in text for marker in LOGIN_MARKERS):
        return "login_required"
    return ""


def candidate_runtime_urls(candidate: dict[str, Any]) -> list[str]:
    values = [candidate.get("currentSrc"), candidate.get("src")]
    source_urls = candidate.get("sourceUrls")
    if isinstance(source_urls, list):
        values.extend(source_urls)
    urls: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        value = value.strip()
        if not scrub_https_url(value) or value in seen:
            continue
        seen.add(value)
        urls.append(value)
    return urls


def clean_candidate(candidate: Any) -> dict[str, Any] | None:
    """Validate rendered video data and produce a transient media descriptor."""
    if not isinstance(candidate, dict) or not candidate.get("visible"):
        return None
    runtime_urls = candidate_runtime_urls(candidate)
    if not runtime_urls:
        return None
    runtime_media_url = runtime_urls[0]
    return {
        "runtimeMediaUrl": runtime_media_url,
        "mediaUrl": scrub_https_url(runtime_media_url),
        "posterUrl": scrub_https_url(candidate.get("poster")),
        "durationSeconds": finite_number(candidate.get("duration"), 86400),
        "dimensions": {
            "width": non_negative_int(candidate.get("width")),
            "height": non_negative_int(candidate.get("height")),
        },
        "readyState": non_negative_int(candidate.get("readyState"), 4),
        "evidence": "rendered_visible_video_element",
    }


def select_media_candidate(candidates: Any) -> dict[str, Any] | None:
    """Prefer the rendered candidate with the most usable media metadata."""
    if not isinstance(candidates, list):
        return None
    cleaned = [item for item in (clean_candidate(candidate) for candidate in candidates) if item]
    if not cleaned:
        return None
    return max(
        cleaned,
        key=lambda item: (
            1 if item["durationSeconds"] else 0,
            1 if item["dimensions"]["width"] and item["dimensions"]["height"] else 0,
            item["readyState"] or 0,
        ),
    )


def artifact_payload(platform: str, content_url: str, status: str, observed_at: str, media: dict[str, Any] | None = None, error_code: str = "") -> dict[str, Any]:
    """Create the persistent payload. runtimeMediaUrl is deliberately omitted."""
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "platform": platform,
        "contentUrl": scrub_https_url(content_url),
        "status": status,
        "observedAt": observed_at,
    }
    if error_code:
        payload["errorCode"] = error_code
    if media:
        payload["media"] = {
            "mediaUrl": media["mediaUrl"],
            "posterUrl": media["posterUrl"],
            "durationSeconds": media["durationSeconds"],
            "dimensions": media["dimensions"],
            "readyState": media["readyState"],
            "evidence": media["evidence"],
        }
    return payload


def write_artifact(output_file: str, payload: dict[str, Any]) -> None:
    path = pathlib.Path(output_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")


def get_gateway_token() -> str:
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    if token:
        return token
    config_path = pathlib.Path.home() / ".openclaw" / "openclaw.json"
    if config_path.exists():
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
            token = (payload.get("gateway") or {}).get("auth", {}).get("token", "").strip()
            if token:
                return token
        except (OSError, ValueError, TypeError):
            pass
    gateway_cmd = pathlib.Path.home() / ".openclaw" / "gateway.cmd"
    if gateway_cmd.exists():
        try:
            text = gateway_cmd.read_text(encoding="utf-8", errors="ignore")
            match = re.search(r"OPENCLAW_GATEWAY_TOKEN=([^\"\r\n]+)", text)
            if match:
                return match.group(1).strip()
        except OSError:
            pass
    raise RuntimeError("Browser Relay gateway token is unavailable.")


def relay_headers(port: int) -> dict[str, str]:
    relay_token = hmac.new(
        get_gateway_token().encode("utf-8"),
        f"openclaw-extension-relay-v1:{port}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {"x-openclaw-relay-token": relay_token}


def read_rendered_videos(page: Any) -> list[dict[str, Any]]:
    """Return only metadata from visible <video> elements, never page HTML."""
    return page.evaluate(
        """() => {
          const visible = (node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none' && style.visibility !== 'hidden'
              && Number(style.opacity || 1) > 0;
          };
          return Array.from(document.querySelectorAll('video')).map((video) => ({
            visible: visible(video),
            currentSrc: video.currentSrc || '',
            src: video.src || '',
            sourceUrls: Array.from(video.querySelectorAll('source')).map((source) => source.src || '').filter(Boolean),
            poster: video.poster || '',
            duration: Number.isFinite(video.duration) ? video.duration : null,
            width: Number.isFinite(video.videoWidth) ? video.videoWidth : null,
            height: Number.isFinite(video.videoHeight) ? video.videoHeight : null,
            readyState: Number.isFinite(video.readyState) ? video.readyState : null,
          })).filter((candidate) => candidate.visible);
        }"""
    )


def read_access_state(page: Any) -> str:
    try:
        visible_text = page.locator("body").inner_text(timeout=3000)[:8000]
    except Exception:
        visible_text = ""
    return access_state(page.url or "", visible_text)


def stdout_payload(status: str, output_file: str, media: dict[str, Any] | None = None, error_code: str = "") -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": status,
        "outputFile": str(pathlib.Path(output_file)),
    }
    if error_code:
        payload["errorCode"] = error_code
    if media:
        payload.update({
            "runtimeMediaUrl": media["runtimeMediaUrl"],
            "mediaUrl": media["mediaUrl"],
            "durationSeconds": media["durationSeconds"],
            "dimensions": media["dimensions"],
        })
    return payload


def complete(output_file: str, artifact: dict[str, Any], runtime: dict[str, Any], exit_code: int) -> int:
    write_artifact(output_file, artifact)
    print(json.dumps(runtime, ensure_ascii=True, separators=(",", ":")))
    return exit_code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read rendered public video media through Browser Relay.")
    parser.add_argument("--platform", choices=sorted(PLATFORM_DOMAINS), required=True)
    parser.add_argument("--content-url", required=True)
    parser.add_argument("--relay-port", type=int, default=18800)
    parser.add_argument("--output-file", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    observed_at = utc_now()
    if not is_platform_url(args.platform, args.content_url):
        artifact = artifact_payload(args.platform, args.content_url, "invalid_input", observed_at, error_code="INVALID_PLATFORM_CONTENT_URL")
        return complete(args.output_file, artifact, stdout_payload("invalid_input", args.output_file, error_code="INVALID_PLATFORM_CONTENT_URL"), EXIT_INVALID_INPUT)

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{args.relay_port}",
                headers=relay_headers(args.relay_port),
                timeout=20000,
            )
            if not browser.contexts:
                raise RuntimeError("Browser Relay has no reusable context.")
            context = browser.contexts[0]
            page = context.new_page()
            try:
                page.bring_to_front()
                page.goto(args.content_url, wait_until="domcontentloaded", timeout=60000)
                page.bring_to_front()
                page.wait_for_timeout(5000)
                state = read_access_state(page)
                if state:
                    exit_code = EXIT_LOGIN_REQUIRED if state == "login_required" else EXIT_VERIFICATION_REQUIRED
                    artifact = artifact_payload(args.platform, args.content_url, state, observed_at, error_code=state.upper())
                    return complete(args.output_file, artifact, stdout_payload(state, args.output_file, error_code=state.upper()), exit_code)
                media = select_media_candidate(read_rendered_videos(page))
                if not media:
                    artifact = artifact_payload(args.platform, args.content_url, "media_not_rendered", observed_at, error_code="MEDIA_NOT_RENDERED")
                    return complete(args.output_file, artifact, stdout_payload("media_not_rendered", args.output_file, error_code="MEDIA_NOT_RENDERED"), EXIT_MEDIA_NOT_RENDERED)
                artifact = artifact_payload(args.platform, args.content_url, "media_ready", observed_at, media=media)
                return complete(args.output_file, artifact, stdout_payload("media_ready", args.output_file, media=media), EXIT_SUCCESS)
            finally:
                page.close()
                browser.close()
    except Exception:
        artifact = artifact_payload(args.platform, args.content_url, "relay_error", observed_at, error_code="BROWSER_RELAY_ERROR")
        return complete(args.output_file, artifact, stdout_payload("relay_error", args.output_file, error_code="BROWSER_RELAY_ERROR"), EXIT_RELAY_ERROR)


if __name__ == "__main__":
    sys.exit(main())
