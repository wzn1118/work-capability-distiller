import argparse
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


PLATFORM_DOMAINS = {
    "xiaohongshu": "xiaohongshu.com",
    "douyin": "douyin.com",
    "bilibili": "bilibili.com",
}

# These checks are deliberately narrow. They classify an already open platform
# tab without retaining page text, cookies, storage state, or credentials.
LOGIN_MARKERS = (
    "\u8bf7\u767b\u5f55",
    "\u7acb\u5373\u767b\u5f55",
    "\u626b\u7801\u767b\u5f55",
    "\u624b\u673a\u53f7\u767b\u5f55",
    "\u767b\u5f55\u540e\u67e5\u770b",
    "\u767b\u5f55\u540e\u53ef\u89c1",
)
VERIFICATION_MARKERS = (
    "\u5b89\u5168\u9a8c\u8bc1",
    "\u6ed1\u52a8\u9a8c\u8bc1",
    "\u4eba\u673a\u9a8c\u8bc1",
    "\u5b8c\u6210\u9a8c\u8bc1",
    "\u5f02\u5e38\u8bbf\u95ee",
    "\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41",
)


def get_gateway_token() -> str:
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    if token:
        return token

    config_path = pathlib.Path.home() / ".openclaw" / "openclaw.json"
    if config_path.exists():
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
            token = payload.get("gateway", {}).get("auth", {}).get("token", "").strip()
            if token:
                return token
        except Exception:
            pass

    gateway_cmd = pathlib.Path.home() / ".openclaw" / "gateway.cmd"
    if gateway_cmd.exists():
        text = gateway_cmd.read_text(encoding="utf-8", errors="ignore")
        match = re.search(r"OPENCLAW_GATEWAY_TOKEN=([^\"\r\n]+)", text)
        if match:
            return match.group(1).strip()
    raise RuntimeError("OpenClaw gateway token is not available in the local profile.")


def relay_headers(port: int) -> dict[str, str]:
    relay_token = hmac.new(
        get_gateway_token().encode("utf-8"),
        f"openclaw-extension-relay-v1:{port}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {"x-openclaw-relay-token": relay_token}


def is_platform_page(url: str, domain: str) -> bool:
    try:
        hostname = (urlsplit(url).hostname or "").lower()
    except (TypeError, ValueError):
        return False
    return hostname == domain or hostname.endswith(f".{domain}")


def page_access_state(page) -> str:
    try:
        text = page.locator("body").inner_text(timeout=1_500)[:3_000]
    except Exception:
        return "unknown"
    if any(marker in text for marker in VERIFICATION_MARKERS):
        return "verification_required"
    if any(marker in text for marker in LOGIN_MARKERS):
        return "login_required"
    return "ready"


def relay_snapshot(contexts, platform: str, relay_port: int) -> dict:
    domain = PLATFORM_DOMAINS[platform]
    pages = [page for context in contexts for page in context.pages]
    platform_pages = [page for page in pages if is_platform_page(page.url or "", domain)]
    states = [page_access_state(page) for page in platform_pages]
    if "verification_required" in states:
        platform_state = "verification_required"
    elif "login_required" in states:
        platform_state = "login_required"
    elif platform_pages:
        platform_state = "ready"
    else:
        # A reusable browser context can be logged in even before the platform
        # has a visible tab. The collector will verify that state on its own page.
        platform_state = "not_checked"
    return {
        "reachable": True,
        "page_count": len(pages),
        "platform_tab_count": len(platform_pages),
        "platform_session_state": platform_state,
        "session_persistence": "attached_browser_profile",
        "credential_handling": "browser_managed_not_exported",
        "relay_port": relay_port,
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_session_state(path_value: str, platform: str, snapshot: dict) -> bool:
    """Persist only connection metadata, atomically, without browser auth material."""
    if not path_value:
        return False
    path = pathlib.Path(path_value)
    prior = {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        prior = parsed if isinstance(parsed, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass

    platform_states = prior.get("platforms") if isinstance(prior.get("platforms"), dict) else {}
    platform_states = dict(platform_states)
    platform_states[platform] = {
        "observedAt": utc_now(),
        "tabCount": int(snapshot.get("platform_tab_count") or 0),
        "state": snapshot.get("platform_session_state") or "not_checked",
    }
    safe_state = {
        "schemaVersion": 2,
        "updatedAt": utc_now(),
        "relayPort": int(snapshot.get("relay_port") or 0),
        "persistence": "attached_browser_profile",
        "credentialHandling": "browser_managed_not_exported",
        "pageCount": int(snapshot.get("page_count") or 0),
        "platforms": platform_states,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(safe_state, ensure_ascii=True, indent=2), encoding="utf-8")
    os.replace(temporary, path)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--relay-port", type=int, default=18792)
    parser.add_argument("--platform", choices=sorted(PLATFORM_DOMAINS), default="xiaohongshu")
    parser.add_argument(
        "--state-file",
        default="",
        help="Optional local status file. It stores no cookies, tokens, URLs, or credentials.",
    )
    args = parser.parse_args()

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{args.relay_port}",
                headers=relay_headers(args.relay_port),
                timeout=8_000,
            )
            result = relay_snapshot(browser.contexts, args.platform, args.relay_port)
            try:
                result["session_state_persisted"] = write_session_state(
                    args.state_file,
                    args.platform,
                    result,
                )
            except OSError:
                # The status file is diagnostic only. A file-system problem must
                # not make an already attached browser profile unusable.
                result["session_state_persisted"] = False
            # Do not call browser.close() here. This is a client attached to the
            # user's persistent browser profile; leaving the context disconnects
            # the CDP client while preserving that profile and its login state.
    except Exception as error:
        result = {"reachable": False, "error": str(error)[:240]}

    print(json.dumps(result, ensure_ascii=True))
    return 0 if result["reachable"] else 2


if __name__ == "__main__":
    sys.exit(main())
