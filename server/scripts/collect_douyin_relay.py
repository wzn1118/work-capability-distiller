import argparse
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
import time
from datetime import datetime
from urllib.parse import quote, urlsplit, urlunsplit

from playwright.sync_api import sync_playwright

from public_profile_fields import enrich_profile_records


# A real Relay session remains interactive, so discovery remains finite. The
# product normally shards a 10,000-candidate channel target across routes; this
# cap also makes an explicitly configured single route deterministic.
MAX_SEARCH_RESULTS = 10_000
MAX_AUTOMATIC_SCROLLS = 1_800
MAX_IDLE_SCROLLS = 8
PROFILE_SAMPLE_LIMIT = 10000
MAX_PROFILE_SAMPLE_LIMIT = 10000
MIN_PROFILE_CONTENT_SCROLLS = 6
MAX_PROFILE_CONTENT_SCROLLS = 2500
PROFILE_TARGET_CARDS_PER_SCROLL = 4
MIN_PROFILE_IDLE_SCROLLS = 2
MAX_PROFILE_IDLE_SCROLLS = 5
PROFILE_HEADER_POLL_ATTEMPTS = 5
PROFILE_HEADER_POLL_INTERVAL_MS = 650


LOGIN_MARKERS = (
    "登录后查看",
    "登录即可",
    "请登录",
    "手机号登录",
    "扫码登录",
    "验证码登录",
    "登录后可查看",
)

VERIFICATION_MARKERS = (
    "安全验证",
    "滑动验证",
    "人机验证",
    "请完成验证",
    "系统检测到异常访问",
    "访问过于频繁",
    "访问频繁",
    "网络环境异常",
)


def get_gateway_token():
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


def relay_headers(port):
    relay_token = hmac.new(
        get_gateway_token().encode("utf-8"),
        f"openclaw-extension-relay-v1:{port}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {"x-openclaw-relay-token": relay_token}


def page_access_state(page):
    try:
        frame_urls = [frame.url.lower() for frame in page.frames]
        if any(
            marker in url
            for url in frame_urls
            for marker in ("captcha", "security/verify", "rc-verifycenter")
        ):
            return "verification"
    except Exception:
        pass
    try:
        text = page.locator("body").inner_text(timeout=3000)[:8000]
    except Exception:
        return ""
    if any(marker in text for marker in VERIFICATION_MARKERS):
        return "verification"
    if any(marker in text for marker in LOGIN_MARKERS):
        return "login"
    return ""


def has_login_wall(page):
    return page_access_state(page) == "login"


def decode_chunked_body(raw):
    """Decode the chunked payload returned by Douyin's streamed search endpoint."""
    position = 0
    chunks = []
    saw_chunk = False
    while position < len(raw):
        line_end = raw.find(b"\r\n", position)
        if line_end < 0:
            return raw
        size_text = raw[position:line_end].split(b";", 1)[0].strip()
        if not re.fullmatch(rb"[0-9A-Fa-f]+", size_text):
            return raw
        try:
            size = int(size_text, 16)
        except ValueError:
            return raw
        position = line_end + 2
        if size == 0:
            return b"".join(chunks)
        chunk_end = position + size
        if chunk_end > len(raw):
            return raw
        chunks.append(raw[position:chunk_end])
        saw_chunk = True
        position = chunk_end
        if raw[position:position + 2] == b"\r\n":
            position += 2
    return b"".join(chunks) if saw_chunk else raw


def response_payload(response):
    try:
        raw = decode_chunked_body(response.body())
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def first_url(value):
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("url_list", "url", "url_list_ori"):
            found = first_url(value.get(key))
            if found:
                return found
    if isinstance(value, list):
        for item in value:
            found = first_url(item)
            if found:
                return found
    return ""


def public_image_urls(value, limit=8):
    """Return bounded public image URLs without treating an avatar as content."""
    found = []

    def visit(item):
        if len(found) >= limit:
            return
        if isinstance(item, str):
            url = item.strip()
            if url and url not in found:
                found.append(url)
            return
        if isinstance(item, dict):
            for key in ("url_list", "url", "url_list_ori"):
                visit(item.get(key))
                if len(found) >= limit:
                    return
        elif isinstance(item, list):
            for nested in item:
                visit(nested)
                if len(found) >= limit:
                    return

    visit(value)
    return found


def public_text(value, maximum=600):
    """Keep scalar, public response fields bounded before writing collector output."""
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    return str(value).strip()[:maximum]


def first_public_value(source, *keys):
    if not isinstance(source, dict):
        return ""
    for key in keys:
        value = source.get(key)
        text = public_text(value)
        if text:
            return text
    return ""


def public_topic_labels(hashtags):
    """Retain only compact topic labels explicitly present in a public caption."""
    return [
        label for label in (public_text(value, 80).lstrip("#\uff03").strip() for value in hashtags)
        if label
    ][:12]


def commercial_markers_from_text(value):
    """Classify only explicit public disclosure words; do not infer sponsorship."""
    text = public_text(value, 1_200).lower()
    markers = []
    if "\u5e7f\u544a" in text:
        markers.append("ad_disclosure")
    if any(term in text for term in ("\u54c1\u724c\u5408\u4f5c", "\u5546\u4e1a\u5408\u4f5c", "paid partnership")):
        markers.append("brand_collaboration")
    if any(term in text for term in ("\u4ed8\u8d39\u63a8\u5e7f", "sponsored")):
        markers.append("paid_promotion")
    if "\u8d5e\u52a9" in text:
        markers.append("sponsorship")
    return markers


def public_video_duration_seconds(video):
    value = video.get("duration") if isinstance(video, dict) else None
    if isinstance(value, bool) or value is None:
        return None
    try:
        milliseconds = int(value)
    except (TypeError, ValueError):
        return None
    seconds = round(milliseconds / 1_000)
    return seconds if 0 < seconds <= 86_400 else None


def aweme_items(payload):
    if not isinstance(payload, dict):
        return []
    items = payload.get("data")
    if not isinstance(items, list):
        return []
    found = []
    for item in items:
        if not isinstance(item, dict):
            continue
        primary = item.get("aweme_info")
        if isinstance(primary, dict):
            found.append(primary)
        nested_items = item.get("aweme_list")
        if isinstance(nested_items, list):
            for nested in nested_items:
                if not isinstance(nested, dict):
                    continue
                nested_aweme = nested.get("aweme_info") if isinstance(nested.get("aweme_info"), dict) else nested
                if isinstance(nested_aweme, dict):
                    found.append(nested_aweme)
    return found


def extract_response_records(payload, search_url):
    records = []
    seen_aweme_ids = set()
    seen_profiles = set()
    for aweme in aweme_items(payload):
        author = aweme.get("author") if isinstance(aweme.get("author"), dict) else {}
        aweme_id = str(aweme.get("aweme_id") or "").strip()
        sec_uid = str(author.get("sec_uid") or "").strip()
        nickname = str(author.get("nickname") or "").strip()
        if not aweme_id or not sec_uid or not nickname:
            continue
        author_profile = f"https://www.douyin.com/user/{quote(sec_uid, safe='')}"
        if aweme_id in seen_aweme_ids or author_profile in seen_profiles:
            continue
        seen_aweme_ids.add(aweme_id)
        seen_profiles.add(author_profile)
        description = str(aweme.get("desc") or "").strip()
        video = aweme.get("video") if isinstance(aweme.get("video"), dict) else {}
        statistics = aweme.get("statistics") if isinstance(aweme.get("statistics"), dict) else {}
        image_items = aweme.get("images") if isinstance(aweme.get("images"), list) else []
        image_urls = public_image_urls(image_items)
        author_bio = first_public_value(author, "signature", "bio", "desc")
        author_handle = first_public_value(author, "unique_id", "short_id", "custom_id")
        verification_label = first_public_value(author, "custom_verify", "enterprise_verify_reason", "verify_info")
        public_metrics = {
            "followers": author.get("follower_count"),
            "following": author.get("following_count"),
            "likes": author.get("total_favorited"),
            "works": author.get("aweme_count"),
        }
        cover_url = (
            first_url(video.get("cover"))
            or first_url(video.get("origin_cover"))
            or first_url(video.get("dynamic_cover"))
            or first_url(image_items)
        )
        content_statistics = {
            "digg_count": statistics.get("digg_count"),
            "comment_count": statistics.get("comment_count"),
            "collect_count": statistics.get("collect_count"),
            "share_count": statistics.get("share_count"),
            "forward_count": statistics.get("forward_count"),
            "play_count": statistics.get("play_count"),
        }
        hashtags = re.findall(r"#[^\s#]+", description)[:12]
        topic_labels = public_topic_labels(hashtags)
        commercial_markers = commercial_markers_from_text(description)
        content_format = (
            "image_carousel" if len(image_items) > 1
            else "image_note" if image_items
            else "video" if video
            else "unknown"
        )
        duration_seconds = public_video_duration_seconds(video)
        latest_sample = {
            "note_url": f"https://www.douyin.com/video/{quote(aweme_id, safe='')}",
            "title": description.splitlines()[0][:300] if description else "",
            "body": description[:600],
            "cover_url": cover_url,
            "image_urls": image_urls,
            "content_type": "image_or_note" if image_items else "video",
            "content_format": content_format,
            "content_image_count": len(image_items),
            "has_video": content_format == "video",
            "hashtags": hashtags,
            "topic_labels": topic_labels,
            "published_at": aweme.get("create_time"),
            "duration_ms": video.get("duration"),
            "duration_seconds": duration_seconds,
            "commercial_markers": commercial_markers or None,
            "statistics": content_statistics,
        }
        records.append({
            "aweme_id": aweme_id,
            "author": {
                "nickname": nickname,
                "sec_uid": sec_uid,
                "uid": str(author.get("uid") or "").strip(),
                "unique_id": author_handle,
                "follower_count": author.get("follower_count"),
                "following_count": author.get("following_count"),
                "total_favorited": author.get("total_favorited"),
                "aweme_count": author.get("aweme_count"),
                "signature": author_bio,
                "verification_label": verification_label,
                "avatar_url": first_url(author.get("avatar_thumb")) or first_url(author.get("avatar_larger")),
            },
            "author_profile": author_profile,
            "source_profile_url": author_profile,
            "note_url": f"https://www.douyin.com/video/{quote(aweme_id, safe='')}",
            "title": description.splitlines()[0][:300] if description else "",
            "body": description[:900],
            "tags": " | ".join(hashtags),
            "bio": author_bio,
            "handle": author_handle,
            "follower_count": author.get("follower_count"),
            "following_count": author.get("following_count"),
            "like_count": author.get("total_favorited"),
            "work_count": author.get("aweme_count"),
            "avatar_url": first_url(author.get("avatar_thumb")) or first_url(author.get("avatar_larger")),
            "verified": bool(verification_label),
            "verified_label": verification_label,
            "location": first_public_value(author, "ip_location", "location"),
            "statistics": content_statistics,
            "latest_samples": [latest_sample],
            "content_summary": {
                "visible_sample_count": 1,
                "sample_interactions": content_statistics,
                "sampled_from_public_search": True,
            },
            "profile": {
                "nickname": nickname,
                "handle": author_handle,
                "bio": author_bio,
                "location": first_public_value(author, "ip_location", "location"),
                "verified": bool(verification_label),
                "verified_label": verification_label,
                "avatar": first_url(author.get("avatar_thumb")) or first_url(author.get("avatar_larger")),
                "metrics": public_metrics,
                "visible_metrics": [
                    value for value in public_metrics.values() if value is not None and str(value).strip()
                ],
                "latest_samples": [latest_sample],
                "content_summary": {
                    "visible_sample_count": 1,
                    "sample_interactions": content_statistics,
                    "sampled_from_public_search": True,
                },
            },
            "cover_url": cover_url,
            "image_urls": image_urls,
            "scraped_at": datetime.now().isoformat(timespec="seconds"),
            "source_search_url": search_url,
        })
    return enrich_profile_records(records)


class SearchResponseCapture:
    def __init__(self, search_url):
        self.search_url = search_url
        self.records = []
        self._seen_profiles = set()
        self.matched_response_events = 0
        self.parsed_response_events = 0

    def on_response(self, response):
        if not any(path in response.url for path in (
            "/aweme/v1/web/general/search/stream/",
            "/aweme/v1/web/general/search/single/",
        )):
            return
        self.matched_response_events += 1
        payload = response_payload(response)
        if payload is None:
            return
        self.parsed_response_events += 1
        for record in extract_response_records(payload, self.search_url):
            profile = record["author_profile"]
            if profile in self._seen_profiles:
                continue
            self._seen_profiles.add(profile)
            self.records.append(record)


def scroll_search_results(page):
    """Advance Douyin's visible search feed without touching an existing user tab."""
    try:
        viewport = page.evaluate("""() => ({ width: window.innerWidth, height: window.innerHeight })""")
        width = max(1, int(viewport.get("width") or 1))
        height = max(1, int(viewport.get("height") or 1))
        # The result view owns normal document scrolling. Moving over the result grid
        # and using a wheel event triggers its native lazy-load path reliably.
        page.mouse.move(min(width - 120, max(260, int(width * 0.55))), min(height - 120, max(300, int(height * 0.72))))
        page.mouse.wheel(0, max(560, int(height * 0.78)))
        return True
    except Exception:
        try:
            return bool(page.evaluate(
                """() => {
                  const roots = [
                    document.scrollingElement,
                    document.querySelector('[class*=scroll]'),
                    document.querySelector('[class*=feed]'),
                    document.body,
                  ].filter(Boolean);
                  const target = roots.find((node) => node.scrollHeight > node.clientHeight + 20) || document.scrollingElement;
                  if (!target || typeof target.scrollBy !== 'function') return false;
                  target.scrollBy(0, Math.max(720, Math.floor(window.innerHeight * 0.82)));
                  return true;
                }"""
            ))
        except Exception:
            return False


def search_surface_state(page):
    """Return coarse public-search progress without persisting raw DOM identities."""
    try:
        return page.evaluate(
            """() => {
              const rootFor = (node) => node.closest(
                'article, li, [data-e2e*=search-card], [data-e2e*=search-result], [class*=search-card], [class*=SearchCard], [class*=feed-card], [class*=FeedCard], [class*=card], [class*=Card]'
              );
              const isNavigationNode = (node) => Boolean(node.closest('nav, header, [role="navigation"], [data-e2e*=nav], [class*=nav], [class*=Nav]'));
              const profileLinks = Array.from(document.querySelectorAll('a[href*="/user/"], a[href*="user/"]'))
                .filter((node) => !isNavigationNode(node) && rootFor(node));
              const contentLinks = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]'))
                .filter((node) => rootFor(node));
              const cardRoots = new Set([...profileLinks, ...contentLinks].map(rootFor).filter(Boolean));
              const roots = [
                document.scrollingElement,
                document.querySelector('[class*=scroll]'),
                document.querySelector('[class*=feed]'),
                document.body,
              ].filter(Boolean);
              const target = roots.find((node) => node.scrollHeight > node.clientHeight + 20) || document.scrollingElement;
              const identities = [...new Set([
                ...profileLinks.map((node) => node.href || ''),
                ...contentLinks.map((node) => node.href || ''),
              ].filter(Boolean))].sort();
              const fingerprint = identities.reduce((hash, value) => {
                for (let index = 0; index < value.length; index += 1) {
                  hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
                }
                return hash;
              }, 0);
              const top = Math.max(window.scrollY || 0, target?.scrollTop || 0);
              const height = Math.max(
                document.documentElement?.scrollHeight || 0,
                document.body?.scrollHeight || 0,
                target?.scrollHeight || 0,
              );
              const clientHeight = Math.max(window.innerHeight || 0, target?.clientHeight || 0);
              return {
                visible_card_roots: cardRoots.size,
                visible_profile_links: profileLinks.length,
                visible_content_links: contentLinks.length,
                visible_identity_count: identities.length,
                visible_identity_fingerprint: String(fingerprint),
                top,
                height,
                client_height: clientHeight,
                at_bottom: height > 0 && top + clientHeight >= height - 24,
              };
            }"""
        )
    except Exception:
        return {}


def surface_progressed(previous, latest):
    """Accept virtual-list replacement and scroll movement as public-page progress."""
    if not isinstance(previous, dict) or not isinstance(latest, dict):
        return False
    return (
        int(latest.get("top") or 0) > int(previous.get("top") or 0) + 8
        or int(latest.get("height") or 0) > int(previous.get("height") or 0) + 20
        or int(latest.get("visible_content_links") or 0) > int(previous.get("visible_content_links") or 0)
        or str(latest.get("visible_identity_fingerprint") or "") != str(previous.get("visible_identity_fingerprint") or "")
    )


def source_card_identity(record):
    """Count public content cards independently from creator identity."""
    if not isinstance(record, dict):
        return ""
    value = str(record.get("note_url") or record.get("aweme_id") or search_candidate_identity(record) or "").strip()
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme and parsed.netloc:
            return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), "", ""))
    except ValueError:
        pass
    return value.rstrip("/").lower()


def observe_markup_candidates(page, records_by_identity, source_card_ids, limit):
    """Accumulate normally rendered public cards from every scroll pass."""
    new_accounts = 0
    new_public_cards = 0
    visible_records = []
    try:
        visible_records = extract_candidates(page, limit)
    except Exception:
        return {
            "visible_records": 0,
            "new_accounts": 0,
            "new_public_cards": 0,
        }
    for record in visible_records:
        card_key = source_card_identity(record)
        if card_key and card_key not in source_card_ids:
            source_card_ids.add(card_key)
            new_public_cards += 1
        identity = search_candidate_identity(record)
        if identity and identity not in records_by_identity:
            records_by_identity[identity] = record
            new_accounts += 1
    return {
        "visible_records": len(visible_records),
        "new_accounts": new_accounts,
        "new_public_cards": new_public_cards,
    }


def observe_response_cards(response_records, source_card_ids):
    """Add public response-backed cards to the same cumulative card count."""
    new_public_cards = 0
    for record in response_records or []:
        card_key = source_card_identity(record)
        if card_key and card_key not in source_card_ids:
            source_card_ids.add(card_key)
            new_public_cards += 1
    return new_public_cards


def combined_unique_account_count(response_records, markup_records_by_identity):
    identities = {
        search_candidate_identity(record)
        for record in (response_records or [])
        if search_candidate_identity(record)
    }
    identities.update(identity for identity in markup_records_by_identity if identity)
    return len(identities)


def stop_disposition(stop_reason):
    if stop_reason == "requested_limit_reached":
        return "target_reached", False
    if stop_reason.startswith("platform_"):
        return "platform_action_required", False
    if stop_reason == "scroll_budget_reached":
        return "bounded_scan_limit", True
    return "retryable_collection_gap", True


def wait_for_search_progress(
    page,
    capture,
    markup_records_by_identity,
    source_card_ids,
    extraction_limit,
    previous_response_count,
    previous_surface,
    timeout_ms=5_000,
):
    """Wait for a response, visible-card, or virtual-list progress signal."""
    deadline = time.monotonic() + (timeout_ms / 1000)
    latest_surface = previous_surface
    observed = {
        "new_response_accounts": 0,
        "new_markup_accounts": 0,
        "new_public_cards": 0,
        "surface_progressed": False,
        "visible_markup_records": 0,
    }
    while time.monotonic() < deadline:
        state = page_access_state(page)
        if state:
            return state, latest_surface, observed
        before_cards = len(source_card_ids)
        response_new_cards = observe_response_cards(capture.records, source_card_ids)
        markup_observation = observe_markup_candidates(
            page,
            markup_records_by_identity,
            source_card_ids,
            extraction_limit,
        )
        latest_surface = search_surface_state(page)
        response_growth = max(0, len(capture.records) - previous_response_count)
        current_progress = surface_progressed(previous_surface, latest_surface)
        observed["new_response_accounts"] = max(observed["new_response_accounts"], response_growth)
        observed["new_markup_accounts"] += markup_observation["new_accounts"]
        observed["new_public_cards"] += max(0, len(source_card_ids) - before_cards)
        observed["surface_progressed"] = observed["surface_progressed"] or current_progress
        observed["visible_markup_records"] = markup_observation["visible_records"]
        if response_growth or response_new_cards or markup_observation["new_accounts"] or markup_observation["new_public_cards"] or current_progress:
            return "", latest_surface, observed
        page.wait_for_timeout(250)
    return page_access_state(page), latest_surface, observed


def collect_search_response_records(page, capture, limit, timeout_ms=None):
    if timeout_ms is None:
        # Leave enough time for genuine lazy-load batches while retaining a hard
        # bound for a single collection task.
        timeout_ms = max(30_000, min(4_200_000, 20_000 + (limit * 420)))
    deadline = time.monotonic() + (timeout_ms / 1000)
    # Search responses normally add roughly 7-10 unique creator profiles per
    # viewport. The cap keeps each discovery pass bounded at high volume.
    max_scrolls = max(8, min(MAX_AUTOMATIC_SCROLLS, ((limit + 5) // 6) + 8))
    page.wait_for_timeout(1_800)
    no_public_progress_rounds = 0
    no_new_unique_account_rounds = 0
    scrolls_attempted = 0
    last_scroll_control_succeeded = True
    last_surface = search_surface_state(page)
    markup_records_by_identity = {}
    source_card_ids = set()
    initial_markup = observe_markup_candidates(page, markup_records_by_identity, source_card_ids, limit)
    observe_response_cards(capture.records, source_card_ids)
    stop_reason = "scroll_budget_reached"
    for _ in range(max_scrolls):
        state = page_access_state(page)
        if state:
            stop_reason = f"platform_{state}_required"
            break
        if combined_unique_account_count(capture.records, markup_records_by_identity) >= limit:
            stop_reason = "requested_limit_reached"
            break
        if time.monotonic() >= deadline:
            stop_reason = "collection_deadline_reached"
            break
        previous_count = len(capture.records)
        previous_surface = search_surface_state(page)
        if not scroll_search_results(page):
            last_scroll_control_succeeded = False
            stop_reason = "scroll_control_failed_retryable"
            break
        scrolls_attempted += 1
        # Search batches can arrive several seconds after a normal wheel event.
        # A response, visible-card change, or virtual-list replacement is progress.
        remaining_ms = max(750, min(5_500, int((deadline - time.monotonic()) * 1000)))
        state, last_surface, observation = wait_for_search_progress(
            page,
            capture,
            markup_records_by_identity,
            source_card_ids,
            limit,
            previous_count,
            previous_surface,
            remaining_ms,
        )
        if state:
            stop_reason = f"platform_{state}_required"
            break
        new_unique_accounts = observation["new_response_accounts"] + observation["new_markup_accounts"]
        if new_unique_accounts:
            no_new_unique_account_rounds = 0
        else:
            no_new_unique_account_rounds += 1
        if observation["new_public_cards"] or observation["surface_progressed"]:
            no_public_progress_rounds = 0
        else:
            no_public_progress_rounds += 1
            if no_public_progress_rounds >= MAX_IDLE_SCROLLS:
                # A finite stability window is evidence for a retryable pause, not
                # proof that the platform has no further public results.
                stop_reason = "public_results_settled_retryable"
                break
    else:
        if combined_unique_account_count(capture.records, markup_records_by_identity) >= limit:
            stop_reason = "requested_limit_reached"
    response_records = capture.records[:limit]
    markup_records = list(markup_records_by_identity.values())[:limit]
    reason_class, continuation_recommended = stop_disposition(stop_reason)
    return {
        "access_state": page_access_state(page),
        "response_records": response_records,
        "markup_records": markup_records,
        "stop_reason": stop_reason,
        "scrolls_attempted": scrolls_attempted,
        "scroll_budget": max_scrolls,
        "cumulative_public_page_cards": len(source_card_ids),
        "cumulative_unique_accounts": combined_unique_account_count(capture.records, markup_records_by_identity),
        "scroll_progress": {
            "scrolls_attempted": scrolls_attempted,
            "scroll_budget": max_scrolls,
            "last_scroll_control_succeeded": last_scroll_control_succeeded,
            "last_surface_state": last_surface,
            "initial_visible_markup_records": initial_markup["visible_records"],
        },
        "stop_evidence": {
            "classification": reason_class,
            "continuation_recommended": continuation_recommended,
            "no_public_progress_rounds": no_public_progress_rounds,
            "no_new_unique_account_rounds": no_new_unique_account_rounds,
            "last_scroll_control_succeeded": last_scroll_control_succeeded,
            "last_surface_state": last_surface,
            "matched_response_events": capture.matched_response_events,
            "parsed_response_events": capture.parsed_response_events,
        },
    }


def blocked_state_exit(state):
    if state == "login":
        print("Douyin login is required in the attached browser profile.")
        return 2
    if state == "verification":
        print("Douyin requires an in-browser verification before public search results can be collected.")
        return 4
    return 0


def blocked_collection_status(mode, state, requested_limit, source_url):
    """Persist a machine-readable public-page stop before returning an exit code."""
    return {
        "mode": mode,
        "requested_limit": requested_limit,
        "records_collected": 0,
        "unique_profiles": 0,
        "cumulative_public_page_cards": 0,
        "cumulative_unique_accounts": 0,
        "scrolls_attempted": 0,
        "scroll_budget": 0,
        "stop_reason": f"platform_{state}_required",
        "scroll_progress": {
            "scrolls_attempted": 0,
            "scroll_budget": 0,
            "last_scroll_control_succeeded": None,
        },
        "stop_evidence": {
            "classification": "platform_action_required",
            "continuation_recommended": False,
            "observed_access_state": state,
        },
        "completed_at": datetime.now().isoformat(timespec="seconds"),
        "source_url": source_url,
    }


def extract_candidates(page, limit):
    return page.evaluate(
        """(limit) => {
          const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
          const absolute = (value) => {
            if (!value) return '';
            try { return new URL(value, location.href).href; } catch { return ''; }
          };
          const nodeMeta = (node) => [
            typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
            node?.getAttribute?.('data-e2e') || '', node?.getAttribute?.('aria-label') || '', node?.getAttribute?.('title') || '',
          ].join(' ').toLowerCase();
          const reservedProfileIds = new Set(['self', 'login', 'search', 'discover', 'following', 'follower']);
          const profileIdFor = (profileUrl) => {
            try {
              const pathname = new URL(profileUrl).pathname.replace(/\\/+$/, '');
              const match = pathname.match(/^\\/(?:user|share\\/user)\\/([^/]+)$/i);
              return match ? decodeURIComponent(match[1]).toLowerCase() : '';
            } catch {
              return '';
            }
          };
          const rootFor = (node) => node.closest(
            'article, li, [data-e2e*=search-card], [data-e2e*=search-result], [class*=search-card], [class*=SearchCard], [class*=feed-card], [class*=FeedCard], [class*=card], [class*=Card]'
          );
          const isNavigationNode = (node) => Boolean(node.closest('nav, header, [role="navigation"], [data-e2e*=nav], [class*=nav], [class*=Nav]'));
          const candidates = [];
          const seen = new Set();
          for (const anchor of Array.from(document.querySelectorAll('a[href*="/user/"], a[href*="user/"]'))) {
            const authorProfile = absolute(anchor.getAttribute('href'));
            const profileId = profileIdFor(authorProfile);
            const root = rootFor(anchor);
            if (!profileId || reservedProfileIds.has(profileId) || isNavigationNode(anchor) || !root) continue;
            const author = clean(anchor.textContent) || clean(root?.querySelector('[class*=author], [class*=name], [class*=Name]')?.textContent);
            const video = root?.querySelector('a[href*="/video/"]');
            if (!author || !video) continue;
            const image = root?.querySelector('img');
            const imageUrls = Array.from(root?.querySelectorAll('img') || [])
              .filter((node) => !/(?:avatar|head|user|author|profile)/i.test(nodeMeta(node)))
              .map((node) => absolute(node.currentSrc || node.getAttribute('src')))
              .filter(Boolean).slice(0, 8);
            const title = clean(root?.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent);
            const body = clean(root?.innerText).slice(0, 900);
            // Keep every visible content card for coverage accounting. Creator
            // dedupe happens later, after cumulative public cards are counted.
            const key = absolute(video?.getAttribute('href')) || authorProfile || author;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            candidates.push({
              author,
              author_profile: authorProfile,
              note_url: absolute(video?.getAttribute('href')),
              title,
              body,
              cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
              image_urls: imageUrls,
              scraped_at: new Date().toISOString(),
              source_url: location.href,
            });
            if (candidates.length >= limit) break;
          }
          return candidates;
        }""",
        limit,
    )


def search_candidate_identity(record):
    """Return a stable public creator key without matching unrelated cards."""
    if not isinstance(record, dict):
        return ""
    profile = str(record.get("author_profile") or "").strip()
    if not profile:
        return ""
    try:
        parsed = urlsplit(profile)
        if parsed.scheme and parsed.netloc:
            return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"), "", ""))
    except ValueError:
        pass
    return profile.rstrip("/").lower()


def merge_search_candidates(response_records, markup_records, limit):
    """Combine response and rendered cards while retaining richer response fields."""
    merged = []
    by_identity = {}
    for record in [*(response_records or []), *(markup_records or [])]:
        identity = search_candidate_identity(record)
        if not identity:
            continue
        existing = by_identity.get(identity)
        if existing is None:
            existing = dict(record)
            by_identity[identity] = existing
            merged.append(existing)
        else:
            # Response records are handled first; markup only fills blank fields.
            for key, value in record.items():
                if not existing.get(key) and value:
                    existing[key] = value
        if len(merged) >= limit:
            break
    return merged


def profile_sample_count(page):
    """Count rendered public links or profile card roots before bounded scrolling."""
    try:
        return page.evaluate(
            """() => {
              const links = new Set(Array.from(document.querySelectorAll(
                'a[href*="/video/"], a[href*="/note/"]'
              )).map((node) => node.href).filter(Boolean)).size;
              const cards = Array.from(document.querySelectorAll(
                '[data-e2e*=aweme], [data-e2e*=video-card], [data-e2e*=note-card], [class*=video-card], [class*=VideoCard], [class*=feed-card], [class*=FeedCard]'
              )).filter((node) => (node.innerText || '').trim().length >= 3).length;
              return Math.max(links, cards);
            }"""
        )
    except Exception:
        return 0


def profile_scroll_budget(profile_sample_limit):
    """Scale normal public-profile scrolling for a bounded visible-card target."""
    target = max(1, min(profile_sample_limit, MAX_PROFILE_SAMPLE_LIMIT))
    return min(
        MAX_PROFILE_CONTENT_SCROLLS,
        max(
            MIN_PROFILE_CONTENT_SCROLLS,
            (target + PROFILE_TARGET_CARDS_PER_SCROLL - 1) // PROFILE_TARGET_CARDS_PER_SCROLL,
        ),
    )


def profile_idle_scroll_limit(profile_sample_limit):
    """Allow a little more settling time for larger normal profile samples."""
    target = max(1, min(profile_sample_limit, MAX_PROFILE_SAMPLE_LIMIT))
    return min(
        MAX_PROFILE_IDLE_SCROLLS,
        max(MIN_PROFILE_IDLE_SCROLLS, MIN_PROFILE_IDLE_SCROLLS + (target - 1) // 250),
    )


def profile_collection_coverage(
    stop_reason,
    requested_sample_limit,
    returned_visible_sample_count,
    last_scroll_control_succeeded=None,
):
    """Describe whether a bounded public-profile scan can be treated as complete."""
    reason = str(stop_reason or "").strip().lower()
    try:
        requested_limit = int(requested_sample_limit)
    except (TypeError, ValueError):
        requested_limit = None
    if requested_limit is not None and requested_limit <= 0:
        requested_limit = None
    try:
        returned_count = max(0, int(returned_visible_sample_count))
    except (TypeError, ValueError):
        returned_count = 0

    public_profile_pages_exhausted = reason in {
        "page_exhausted",
        "profile_page_exhausted",
        "public_page_exhausted",
    }
    requested_limit_reached = reason in {
        "target_reached",
        "sample_limit_reached",
        "profile_sample_limit_reached",
        "requested_limit_reached",
    } or (requested_limit is not None and returned_count >= requested_limit)
    retryable_stop = (
        reason == "scroll_budget_reached"
        or reason == "scroll_control_unavailable"
        or reason.endswith("_retryable")
    )
    continuation_recommended = (
        not public_profile_pages_exhausted
        and not requested_limit_reached
        and not reason.startswith("platform_")
        and (retryable_stop or last_scroll_control_succeeded is False)
    )
    if continuation_recommended:
        coverage_state = "resumable"
        next_collection_action = "resume_collection"
    elif public_profile_pages_exhausted:
        coverage_state = "page_exhausted"
        next_collection_action = "none"
    elif requested_limit_reached:
        coverage_state = "requested_limit_reached"
        next_collection_action = "increase_sample_limit"
    elif returned_count:
        coverage_state = "terminal_state_unconfirmed"
        next_collection_action = "inspect_stop_evidence"
    else:
        coverage_state = "no_visible_content_returned"
        next_collection_action = "inspect_stop_evidence"

    return {
        "requested_content_sample_limit": requested_limit,
        "returned_visible_content_samples": returned_count,
        "requested_limit_reached": requested_limit_reached,
        "public_profile_pages_exhausted": public_profile_pages_exhausted,
        "more_public_content_may_be_available": (
            False if public_profile_pages_exhausted
            else (True if requested_limit_reached or continuation_recommended else None)
        ),
        "continuation_recommended": continuation_recommended,
        "coverage_state": coverage_state,
        "next_collection_action": next_collection_action,
    }


def profile_sample_identity(sample):
    """Return a stable public-content key without retaining URL query fragments."""
    if not isinstance(sample, dict):
        return ""
    raw_url = str(sample.get("note_url") or sample.get("source_url") or "").strip()
    if raw_url:
        try:
            parsed = urlsplit(raw_url)
            if parsed.scheme and parsed.netloc and parsed.path:
                return "url:" + urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, "", ""))
        except Exception:
            pass
        return "url:" + raw_url.split("#", 1)[0]
    fallback = "\x1f".join(
        str(sample.get(field) or "").strip()
        for field in ("title", "body", "published_at", "cover_url")
    )
    normalized = re.sub(r"\s+", " ", fallback).strip().casefold()
    return "text:" + normalized if normalized else ""


def merge_profile_sample(existing, incoming):
    """Retain the first observed ordering while filling sparse public fields."""
    merged = dict(existing) if isinstance(existing, dict) else {}
    if not isinstance(incoming, dict):
        return merged
    for key, value in incoming.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            nested = dict(current)
            for nested_key, nested_value in value.items():
                if not observed_public_value(nested.get(nested_key)) and observed_public_value(nested_value):
                    nested[nested_key] = nested_value
            merged[key] = nested
        elif isinstance(current, list) and isinstance(value, list):
            seen = set()
            combined = []
            for item in [*current, *value]:
                item_key = str(item).strip().casefold()
                if not item_key or item_key in seen:
                    continue
                seen.add(item_key)
                combined.append(item)
            merged[key] = combined
        elif not observed_public_value(current) and observed_public_value(value):
            merged[key] = value
    return merged


def merge_profile_samples(*sample_groups, limit=MAX_PROFILE_SAMPLE_LIMIT):
    """Merge visible-card snapshots by content identity, preserving first-seen order."""
    bounded_limit = max(1, min(int(limit or PROFILE_SAMPLE_LIMIT), MAX_PROFILE_SAMPLE_LIMIT))
    merged = []
    positions = {}
    for group in sample_groups:
        if not isinstance(group, list):
            continue
        for sample in group:
            if not isinstance(sample, dict):
                continue
            identity = profile_sample_identity(sample)
            if not identity:
                continue
            if identity in positions:
                merged[positions[identity]] = merge_profile_sample(merged[positions[identity]], sample)
                continue
            if len(merged) >= bounded_limit:
                continue
            positions[identity] = len(merged)
            merged.append(merge_profile_sample({}, sample))
    return merged


def extract_visible_profile_samples(page, profile_sample_limit=PROFILE_SAMPLE_LIMIT):
    """Read only the currently rendered content cards for virtual-list accumulation."""
    bounded_limit = max(1, min(int(profile_sample_limit or PROFILE_SAMPLE_LIMIT), MAX_PROFILE_SAMPLE_LIMIT))
    try:
        payload = page.evaluate(
            """({ profileSampleLimit }) => {
              const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
              const absolute = (value) => { try { return value ? new URL(value, location.href).href : ''; } catch { return ''; } };
              const unique = (values, max) => [...new Set(values.filter(Boolean))].slice(0, max);
              const nodeMeta = (node) => [
                typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
                node?.getAttribute?.('data-e2e') || '', node?.getAttribute?.('aria-label') || '', node?.getAttribute?.('title') || '',
              ].join(' ').toLowerCase();
              const exactMetric = (value) => {
                const compact = clean(value).replace(/,/g, '').replace(/\\s+/g, '');
                const match = compact.match(/^([0-9]+(?:\\.[0-9]+)?(?:w|k|\\u4e07|\\u4ebf)?)$/i);
                return match ? match[1] : '';
              };
              const cardMetric = (root, labels, allowIconFallback = false) => {
                const normalized = labels.map((label) => label.toLowerCase());
                const nodes = Array.from(root.querySelectorAll('button, span, strong, em, b, i, [aria-label], [title], [data-e2e], [class]')).slice(0, 320);
                for (const node of nodes) {
                  const value = clean(node.innerText || node.textContent);
                  if (!value || value.length > 180) continue;
                  const semantic = normalized.some((label) => nodeMeta(node).includes(label));
                  if (!semantic) continue;
                  const direct = exactMetric(value);
                  if (direct) return direct;
                  if (!allowIconFallback) continue;
                  for (const child of Array.from(node.querySelectorAll('span, strong, em, b, i, [class*=count], [class*=Count]')).slice(0, 48)) {
                    const childValue = exactMetric(child.textContent);
                    if (childValue) return childValue;
                  }
                }
                return '';
              };
              const durationSeconds = (root) => {
                for (const node of Array.from(root.querySelectorAll('[data-e2e*=duration], [data-e2e*=video-time], [class*=duration], [class*=Duration], [class*=video-time], [class*=VideoTime]'))) {
                  const value = clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent);
                  const match = value.match(/(?:^|\\s)(?:(\\d{1,2}):)?([0-5]\\d):([0-5]\\d)(?:\\s|$)/);
                  if (!match) continue;
                  const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
                  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) return seconds;
                }
                return null;
              };
              const pinned = (root) => Array.from(root.querySelectorAll('[data-e2e*=pin], [class*=pin], [class*=Pin], [aria-label*=pinned], [title*=pinned]')).some((node) => /^(?:\\u7f6e\\u9876|pinned)$/i.test(clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent)));
              const profileCardSelector = '[data-e2e*=aweme], [data-e2e*=video-card], [data-e2e*=note-card], [class*=video-card], [class*=VideoCard], [class*=feed-card], [class*=FeedCard]';
              const contentLinkSelector = 'a[href*="/video/"], a[href*="/note/"]';
              const roots = Array.from(new Set([
                ...Array.from(document.querySelectorAll(profileCardSelector)),
                ...Array.from(document.querySelectorAll(contentLinkSelector)).map((anchor) => anchor.closest('article, li, [data-e2e*=aweme], [data-e2e*=video-card], [data-e2e*=note-card], [class*=video-card], [class*=VideoCard], [class*=feed-card], [class*=FeedCard], [class*=card], [class*=Card]') || anchor),
              ])).filter((root) => {
                const value = clean(root.innerText);
                return value.length >= 3 && value.length <= 1200;
              });
              const samples = [];
              const keys = new Set();
              for (const root of roots) {
                const anchor = root.matches(contentLinkSelector) ? root : root.querySelector(contentLinkSelector);
                const noteUrl = absolute(anchor?.getAttribute('href'));
                const text = clean(root.innerText).slice(0, 900);
                const title = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent);
                const key = noteUrl || [title, text.slice(0, 140)].filter(Boolean).join(' ');
                if (!key || keys.has(key)) continue;
                keys.add(key);
                const image = root.querySelector('img');
                const imageCount = Array.from(root.querySelectorAll('img')).filter((node) => !/(?:avatar|head|user|author|profile)/i.test(nodeMeta(node))).length;
                const imageUrls = Array.from(root.querySelectorAll('img'))
                  .filter((node) => !/(?:avatar|head|user|author|profile)/i.test(nodeMeta(node)))
                  .map((node) => absolute(node.currentSrc || node.getAttribute('src')))
                  .filter(Boolean).slice(0, 8);
                const isVideo = Boolean(root.querySelector('video')) || /\\/video\\//i.test(noteUrl || '');
                const hashtags = unique(text.match(/#[^#\\s]{2,32}/g) || [], 12);
                const published = (text.match(/(?:20\\d{2}[.\\-/]\\d{1,2}[.\\-/]\\d{1,2}|(?:0?[1-9]|1[0-2])[.\\-/](?:0?[1-9]|[12]\\d|3[01]))(?!\\s*(?:w|k|\\u4e07|\\u4ebf))/i) || [''])[0];
                const commercial = [];
                if (/\\u5e7f\\u544a/i.test(text)) commercial.push('ad_disclosure');
                if (/(?:\\u54c1\\u724c\\u5408\\u4f5c|\\u5546\\u4e1a\\u5408\\u4f5c|paid\\s+partnership)/i.test(text)) commercial.push('brand_collaboration');
                if (/(?:\\u4ed8\\u8d39\\u63a8\\u5e7f|sponsored)/i.test(text)) commercial.push('paid_promotion');
                samples.push({
                  note_url: noteUrl, title, body: text.slice(0, 600),
                  cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
                  image_urls: imageUrls,
                  content_type: isVideo ? 'video' : 'video_or_image',
                  content_format: isVideo ? 'video' : (imageCount >= 2 ? 'image_carousel' : (imageCount ? 'image_note' : null)),
                  content_image_count: imageCount, has_video: isVideo, hashtags,
                  topic_labels: hashtags.map((tag) => clean(tag).replace(/^[#\\uff03]/, '')).filter(Boolean),
                  published_at: published || null, published_time_text: null,
                  duration_seconds: durationSeconds(root), is_pinned: pinned(root) ? true : null,
                  commercial_markers: commercial.length ? commercial : null,
                  statistics: {
                    digg_count: cardMetric(root, ['\\u70b9\\u8d5e', '\\u8d5e', 'like', 'digg'], true),
                    comment_count: cardMetric(root, ['\\u8bc4\\u8bba', 'comment']),
                    collect_count: cardMetric(root, ['\\u6536\\u85cf', 'collect']),
                    share_count: cardMetric(root, ['\\u5206\\u4eab', '\\u8f6c\\u53d1', 'share']),
                  },
                });
                if (samples.length >= profileSampleLimit) break;
              }
              return { samples, renderedCardCount: roots.length };
            }""",
            {"profileSampleLimit": bounded_limit},
        )
    except Exception:
        return {"samples": [], "rendered_card_count": 0}
    if not isinstance(payload, dict):
        return {"samples": [], "rendered_card_count": 0}
    samples = payload.get("samples") if isinstance(payload.get("samples"), list) else []
    rendered = payload.get("renderedCardCount")
    return {
        "samples": [sample for sample in samples if isinstance(sample, dict)],
        "rendered_card_count": int(rendered) if isinstance(rendered, (int, float)) and rendered >= 0 else 0,
    }


def warm_profile_content(page, profile_sample_limit=PROFILE_SAMPLE_LIMIT):
    """Load a bounded set of normally rendered public profile content cards."""
    accumulated_samples = []
    initial_snapshot = extract_visible_profile_samples(page, profile_sample_limit)
    accumulated_samples = merge_profile_samples(initial_snapshot["samples"], limit=profile_sample_limit)
    previous_rendered_count = initial_snapshot["rendered_card_count"]
    idle_rounds = 0
    scrolls = 0
    stop_reason = "scroll_budget_reached"
    last_scroll_control_succeeded = None
    idle_scroll_limit = profile_idle_scroll_limit(profile_sample_limit)
    if len(accumulated_samples) >= profile_sample_limit:
        stop_reason = "sample_limit_reached"
    for _ in range(profile_scroll_budget(profile_sample_limit)):
        if stop_reason == "sample_limit_reached":
            break
        last_scroll_control_succeeded = bool(scroll_search_results(page))
        if not last_scroll_control_succeeded:
            stop_reason = "scroll_control_unavailable"
            break
        scrolls += 1
        # Most public profile grids render quickly. A second wait is used only
        # when the first observation did not add a card, preserving normal page
        # behavior while reducing per-creator queue time.
        page.wait_for_timeout(420)
        access_state = page_access_state(page)
        if access_state:
            stop_reason = f"{access_state}_retryable"
            break
        snapshot = extract_visible_profile_samples(page, profile_sample_limit)
        before_count = len(accumulated_samples)
        accumulated_samples = merge_profile_samples(
            accumulated_samples,
            snapshot["samples"],
            limit=profile_sample_limit,
        )
        current_rendered_count = snapshot["rendered_card_count"]
        made_progress = len(accumulated_samples) > before_count or current_rendered_count > previous_rendered_count
        if not made_progress:
            page.wait_for_timeout(480)
            access_state = page_access_state(page)
            if access_state:
                stop_reason = f"{access_state}_retryable"
                break
            snapshot = extract_visible_profile_samples(page, profile_sample_limit)
            before_count = len(accumulated_samples)
            accumulated_samples = merge_profile_samples(
                accumulated_samples,
                snapshot["samples"],
                limit=profile_sample_limit,
            )
            current_rendered_count = snapshot["rendered_card_count"]
            made_progress = len(accumulated_samples) > before_count or current_rendered_count > previous_rendered_count
        previous_rendered_count = current_rendered_count
        if made_progress:
            idle_rounds = 0
            if len(accumulated_samples) >= profile_sample_limit:
                stop_reason = "sample_limit_reached"
                break
        else:
            idle_rounds += 1
            if idle_rounds >= idle_scroll_limit:
                stop_reason = "page_exhausted"
                break
    return {
        "scrolls": scrolls,
        "stop_reason": stop_reason,
        "observed_card_count": len(accumulated_samples),
        "last_visible_card_count": previous_rendered_count,
        "idle_rounds": idle_rounds,
        "idle_scroll_limit": idle_scroll_limit,
        "last_scroll_control_succeeded": last_scroll_control_succeeded,
        "latest_samples": accumulated_samples,
    }


def extract_profile(page, expected_name, profile_sample_limit=PROFILE_SAMPLE_LIMIT):
    records = page.evaluate(
        """({ expectedName, profileSampleLimit }) => {
          const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
          const absolute = (value) => { try { return value ? new URL(value, location.href).href : ''; } catch { return ''; } };
          const firstText = (selectors) => {
            for (const selector of selectors) {
              const value = clean(document.querySelector(selector)?.textContent);
              if (value) return value;
            }
            return '';
          };
          const firstNode = (selectors) => {
            for (const selector of selectors) {
              const node = document.querySelector(selector);
              if (clean(node?.textContent)) return node;
            }
            return null;
          };
          const unique = (values, max) => [...new Set(values.filter(Boolean))].slice(0, max);
          const numericMetric = (value) => {
            const match = clean(value).toLowerCase().replace(/,/g, '').match(/([0-9]+(?:\\.[0-9]+)?)\\s*(w|k|\\u4e07|\\u4ebf)?/i);
            if (!match) return null;
            const amount = Number(match[1]);
            if (!Number.isFinite(amount)) return null;
            const unit = (match[2] || '').toLowerCase();
            if (unit === '\\u4ebf') return Math.round(amount * 100000000);
            if (unit === '\\u4e07' || unit === 'w') return Math.round(amount * 10000);
            if (unit === 'k') return Math.round(amount * 1000);
            return Math.round(amount);
          };
          const textNodes = (root, limit = 1600) => unique(
            Array.from(root.querySelectorAll('button, a, span, p, div, li, em, strong'))
              .slice(0, limit)
              .filter((node) => node.children.length <= 2)
              .map((node) => clean(node.textContent))
              .filter((value) => value && value.length <= 96),
            120,
          );
          const attributeText = unique(
            Array.from(document.querySelectorAll('[aria-label], [title], img[alt]'))
              .slice(0, 600)
              .flatMap((node) => [clean(node.getAttribute('aria-label')), clean(node.getAttribute('title')), clean(node.getAttribute('alt'))])
              .filter((value) => value && value.length <= 96),
            80,
          );
          const visibleText = unique([...textNodes(document), ...attributeText], 140);
          const labeled = (patterns, values = visibleText) => {
            const matches = values.filter((value) => patterns.some((pattern) => pattern.test(value)));
            const numbered = matches.filter((value) => /[0-9]/.test(value));
            return (numbered.length ? numbered : matches).sort((left, right) => left.length - right.length)[0] || '';
          };
          const sampleMetric = (text, labels) => {
            for (const label of labels) {
              const escaped = label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
              const number = '([0-9]+(?:\\.[0-9]+)?\\s*(?:w|k|\\u4e07|\\u4ebf)?)';
              const after = text.match(new RegExp(`${escaped}\\s*[:\\uff1a]?\\s*${number}`, 'i'));
              if (after) return after[0];
              const before = text.match(new RegExp(`${number}\\s*${escaped}`, 'i'));
              if (before) return before[0];
            }
            return '';
          };
          const exactMetric = (value) => {
            const compact = clean(value).replace(/,/g, '').replace(/\\s+/g, '');
            const match = compact.match(/^([0-9]+(?:\\.[0-9]+)?(?:w|k|\\u4e07|\\u4ebf)?)$/i);
            return match ? match[1] : '';
          };
          const visibleNode = (node) => Boolean(
            node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
          );
          const nodeMeta = (node) => [
            typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
            node?.getAttribute?.('data-e2e') || '',
            node?.getAttribute?.('data-testid') || '',
            node?.getAttribute?.('aria-label') || '',
            node?.getAttribute?.('title') || '',
          ].join(' ').toLowerCase();
          const labeledMetricValue = (value, labels) => {
            const labeledValue = sampleMetric(value, labels);
            const match = clean(labeledValue).replace(/,/g, '').match(
              /([0-9]+(?:\\.[0-9]+)?\\s*(?:w|k|\\u4e07|\\u4ebf)?)/i
            );
            return match ? exactMetric(match[1]) : '';
          };
          const cardMetric = (root, labels, allowIconFallback = false) => {
            const normalizedLabels = labels.map((label) => label.toLowerCase());
            const nodes = Array.from(root.querySelectorAll(
              'button, span, strong, em, b, i, [aria-label], [title], [data-e2e], [data-testid], [class]'
            )).slice(0, 900);
            for (const node of nodes) {
              if (!visibleNode(node)) continue;
              const text = clean(node.innerText || node.textContent);
              if (!text || text.length > 180) continue;
              const semantic = normalizedLabels.some((label) => nodeMeta(node).includes(label));
              const labeledText = node.children.length <= 2
                && normalizedLabels.some((label) => text.toLowerCase().includes(label));
              if (!semantic && !labeledText) continue;
              // A content title can contain a word such as "分享". Only use a value when
              // it is adjacent to the interaction label, or is the labeled control itself.
              const direct = labeledText
                ? labeledMetricValue(text, labels)
                : (semantic ? exactMetric(text) : '');
              if (direct) return direct;
              if (!allowIconFallback) continue;
              for (const child of Array.from(node.querySelectorAll(
                'span, strong, em, b, i, [class*=count], [class*=Count], [data-e2e], [data-testid]'
              )).slice(0, 80)) {
                if (!visibleNode(child)) continue;
                const value = exactMetric(child.textContent);
                if (value) return value;
              }
            }
            if (!allowIconFallback) return '';
            for (const leaf of nodes) {
              const value = visibleNode(leaf) ? exactMetric(leaf.textContent) : '';
              const parent = leaf?.parentElement;
              if (!value || !parent || clean(parent.innerText).length > 96) continue;
              const hasIconSibling = Array.from(parent.children).some((sibling) => sibling !== leaf && (
                sibling.tagName === 'SVG' || sibling.tagName === 'I'
                || /icon/.test(nodeMeta(sibling))
                || Boolean(sibling.querySelector?.('svg, i, [class*=icon], [class*=Icon]'))
              ));
              if (hasIconSibling) return value;
            }
            return '';
          };
          const cardDurationSeconds = (root) => {
            const nodes = Array.from(root.querySelectorAll(
              '[data-e2e*=duration], [data-e2e*=video-time], [class*=duration], [class*=Duration], [class*=video-time], [class*=VideoTime], [aria-label*=duration], [title*=duration]'
            ));
            for (const node of nodes) {
              const value = clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent);
              const match = value.match(/(?:^|\\s)(?:(\\d{1,2}):)?([0-5]\\d):([0-5]\\d)(?:\\s|$)/);
              if (!match) continue;
              const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
              if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) return seconds;
            }
            return null;
          };
          const cardHasPinnedBadge = (root) => Array.from(root.querySelectorAll(
            '[data-e2e*=pin], [class*=pin], [class*=Pin], [aria-label*=pinned], [title*=pinned]'
          )).some((node) => /^(?:\\u7f6e\\u9876|pinned)$/i.test(clean(
            node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent
          )));
          const contentImageCount = (root) => Array.from(root.querySelectorAll('img')).filter((node) => !/(?:avatar|head|user|author|profile)/i.test(nodeMeta(node))).length;
          const contentFormat = (root, contentUrl, imageCount) => {
            if (root.querySelector('video') || /\\/video\\//i.test(contentUrl || '')) return 'video';
            if (imageCount >= 2) return 'image_carousel';
            if (imageCount === 1 || /\\/note\\//i.test(contentUrl || '')) return 'image_note';
            return '';
          };
          const visiblePublishedAt = (sampleText) => {
            const dateMatch = sampleText.match(/(?:20\\d{2}[.\\-/]\\d{1,2}[.\\-/]\\d{1,2}|(?:0?[1-9]|1[0-2])[.\\-/](?:0?[1-9]|[12]\\d|3[01]))(?!\\s*(?:w|k|\\u4e07|\\u4ebf))/i);
            if (!dateMatch) return { value: '', time: '' };
            const date = dateMatch[0];
            const tail = sampleText.slice((dateMatch.index || 0) + date.length, (dateMatch.index || 0) + date.length + 18);
            const timeMatch = tail.match(/^(?:\\s|T|\\u4e0a\\u5348|\\u4e0b\\u5348){0,12}((?:[01]?\\d|2[0-3]):[0-5]\\d)/i);
            const time = timeMatch ? timeMatch[1] : '';
            return { value: [date, time].filter(Boolean).join(' '), time };
          };
          const topicLabels = (hashtags) => unique(hashtags.map((tag) => clean(tag).replace(/^[#\\uff03]/, '')).filter(Boolean), 12);
          const explicitCommercialMarkers = (value) => {
            const source = clean(value);
            const markers = [
              ['ad_disclosure', /\\u5e7f\\u544a/i],
              ['brand_collaboration', /(?:\\u54c1\\u724c\\u5408\\u4f5c|\\u5546\\u4e1a\\u5408\\u4f5c|paid\\s+partnership)/i],
              ['paid_promotion', /(?:\\u4ed8\\u8d39\\u63a8\\u5e7f|sponsored)/i],
              ['sponsorship', /\\u8d5e\\u52a9/i],
            ];
            return markers.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
          };
          const authorNode = firstNode([
            '[data-e2e*=nickname]', '[class*=nickname]', '[class*=user-name]', '[class*=author-name]', 'h1',
          ]);
          const author = clean(authorNode?.textContent) || firstText([
            '[data-e2e*=nickname]', '[class*=nickname]', '[class*=user-name]', '[class*=author-name]', 'h1',
          ]);
          const bio = firstText([
            '[data-e2e*=user-desc]', '[data-e2e*=user-signature]', '[class*=signature]', '[class*=Signature]',
          ]);
          const metricPattern = /(?:\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u83b7\\u8d5e|\\u559c\\u6b22|\\u4f5c\\u54c1|\\u89c6\\u9891|followers?|following|likes?|posts?|videos?)/i;
          const headerMetricLabels = /(?:\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u83b7\\u8d5e|\\u559c\\u6b22|\\u4f5c\\u54c1|\\u89c6\\u9891|followers?|following|likes?|posts?|videos?)/gi;
          const profileShellPattern = /(?:\u5f00\u542f\u8bfb\u5c4f|\u8bfb\u5c4f\u6807\u7b7e|\u7cbe\u9009|\u63a8\u8350|AI\u6296\u97f3|\u4e0b\u8f7d\u6296\u97f3|\u7f51\u7edc\u8c23\u8a00|\u5145\u94bb\u77f3|\u5ba2\u6237\u7aef|\u58c1\u7eb8|\u901a\u77e5|\u6d88\u606f|\u6295\u7a3f|\u9000\u51fa\u767b\u5f55)/i;
          const metricPairPattern = /(\\u83b7\\u8d5e|\\u559c\\u6b22|\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u4f5c\\u54c1|\\u89c6\\u9891|followers?|following|likes?|posts?|videos?)\\s*[:\\uff1a]?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?\\s*(?:w|k|\\u4e07|\\u4ebf)?\\+?)|([0-9][0-9,]*(?:\\.[0-9]+)?\\s*(?:w|k|\\u4e07|\\u4ebf)?\\+?)\\s*(\\u83b7\\u8d5e|\\u559c\\u6b22|\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u4f5c\\u54c1|\\u89c6\\u9891|followers?|following|likes?|posts?|videos?)/gi;
          const metricKey = (label) => {
            const normalized = clean(label).toLowerCase();
            if (/^(?:\\u7c89\\u4e1d|followers?)$/i.test(normalized)) return 'followers';
            if (/^(?:\\u5173\\u6ce8|following)$/i.test(normalized)) return 'following';
            if (/^(?:\\u83b7\\u8d5e|\\u559c\\u6b22|likes?)$/i.test(normalized)) return 'likes';
            if (/^(?:\\u4f5c\\u54c1|\\u89c6\\u9891|posts?|videos?)$/i.test(normalized)) return 'works';
            return '';
          };
          const profileHeaderCandidates = (() => {
            const selectors = [
              '[data-e2e*=user-detail]', '[data-e2e*=user-info]', '[data-e2e*=user-page]', '[data-e2e*=profile]',
              '[class*=user-detail]', '[class*=UserDetail]', '[class*=user-info]', '[class*=UserInfo]',
              '[class*=profile-header]', '[class*=ProfileHeader]', '[class*=profile-info]', '[class*=ProfileInfo]',
            ].join(', ');
            const candidates = [];
            const seen = new Set();
            const add = (node) => {
              if (!node || seen.has(node)) return;
              seen.add(node);
              const value = clean(node?.innerText);
              if (!author || !value.includes(author) || value.length > 4800 || profileShellPattern.test(value)) return;
              const metricKeys = new Set();
              const matcher = new RegExp(metricPairPattern.source, 'gi');
              let match;
              while ((match = matcher.exec(value))) {
                const key = metricKey(clean(match[1] || match[4]));
                if (key) metricKeys.add(key);
              }
              const labelKeys = new Set(
                (value.match(new RegExp(headerMetricLabels.source, 'gi')) || [])
                  .map(metricKey)
                  .filter(Boolean),
              );
              const semanticRoot = /(?:user|profile|author|detail|info|nickname)/i.test(nodeMeta(node));
              candidates.push({
                node,
                score: (metricKeys.size * 100) + (labelKeys.size * 10) + (semanticRoot ? 2 : 0) - (value.length / 4800),
              });
            };
            for (const node of Array.from(document.querySelectorAll(selectors))) add(node);
            let node = authorNode;
            for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) add(node);
            return candidates.sort((left, right) => right.score - left.score);
          })();
          const profileHeaderRoot = profileHeaderCandidates[0]?.node || null;
          const profileHeaderText = profileHeaderRoot
            ? unique([...textNodes(profileHeaderRoot, 640), clean(profileHeaderRoot.innerText)], 160)
            : [];
          const headerFieldText = (selectors, maxLength = 360) => {
            if (!profileHeaderRoot) return '';
            for (const selector of selectors) {
              for (const node of Array.from(profileHeaderRoot.querySelectorAll(selector))) {
                const value = clean(node.textContent);
                if (value && value.length <= maxLength && !profileShellPattern.test(value)) return value;
              }
            }
            return '';
          };
          const profileBio = headerFieldText([
            '[data-e2e*=user-desc]', '[data-e2e*=user-signature]', '[class*=signature]', '[class*=Signature]',
          ]) || (bio && bio.length <= 360 && !profileShellPattern.test(bio) ? bio : '');
          const profileImage = (() => {
            if (!profileHeaderRoot) return null;
            const candidates = Array.from(profileHeaderRoot.querySelectorAll('img'));
            return candidates.find((node) => {
              const source = absolute(node?.currentSrc || node?.getAttribute('src'));
              const meta = nodeMeta(node);
              return Boolean(source
                && !/(?:douyinstatic\\.com\\/obj\\/douyin-pc-web\\/ies|logo|qrcode)/i.test(source)
                && (/(?:avatar|head|user)/i.test(meta) || clean(node.getAttribute('alt')).includes(author)));
            }) || null;
          })();
          // Pull compact counter pairs only. Full-page text can combine profile data with shell navigation.
          const canonicalMetricLabel = (label) => {
            const key = metricKey(label);
            if (!/^[a-z]/i.test(clean(label))) return clean(label);
            return ({ followers: '\\u7c89\\u4e1d', following: '\\u5173\\u6ce8', likes: '\\u83b7\\u8d5e', works: '\\u4f5c\\u54c1' })[key] || clean(label);
          };
          const metricEntries = [];
          const metricEntryKeys = new Set();
          for (const source of profileHeaderText) {
            const matcher = new RegExp(metricPairPattern.source, 'gi');
            let match;
            while ((match = matcher.exec(source))) {
              const label = clean(match[1] || match[4]);
              const amount = clean(match[2] || match[3]);
              const prefix = source.slice(Math.max(0, match.index - 8), match.index);
              // Exclude counters inside the signed-in account shell (for example, "\\u6211\\u7684\\u4f5c\\u54c18").
              if (/(?:\\u6211\\u7684|\\bmy\\s*)$/i.test(prefix)) continue;
              const key = metricKey(label);
              const value = clean(`${canonicalMetricLabel(label)} ${amount}`);
              const entryKey = `${key}:${amount.toLowerCase().replace(/\\s+/g, '')}`;
              if (!key || !amount || metricEntryKeys.has(entryKey)) continue;
              metricEntryKeys.add(entryKey);
              metricEntries.push({ key, value });
            }
          }
          const metricValue = (key) => metricEntries.find((entry) => entry.key === key)?.value || '';
          const visibleMetrics = unique(metricEntries.map((entry) => entry.value), 12);
          const metrics = {
            followers: metricValue('followers'),
            following: metricValue('following'),
            likes: metricValue('likes'),
            works: metricValue('works'),
          };
          const verifiedLabel = labeled([/(?:\\u5df2\\u8ba4\\u8bc1|\\u8ba4\\u8bc1|verified|official)/i], attributeText);
          const verified = Boolean(verifiedLabel);
          const profileLocation = labeled([/(?:IP\\s*\\u5c5e\\u5730|\\u5730\\u533a|\\u5730\\u57df|location)/i]);
          const handle = firstText([
            '[data-e2e*=user-id]', '[data-e2e*=douyin-id]', '[class*=user-id]', '[class*=userId]', '[class*=douyin-id]', '[class*=douyinId]', '[class*=account-id]',
          ]) || labeled([/(?:\\u6296\\u97f3\\u53f7|DY\\s*ID|ID\\s*[:\\uff1a])/i]);
          const tags = unique(
            Array.from(document.querySelectorAll('[class*=tag], [class*=Tag], [class*=badge], [class*=Badge], a[href*=challenge], a[href*=topic]'))
              .map((node) => clean(node.textContent))
              .filter((value) => value && value.length <= 48 && !metricPattern.test(value)),
            12,
          );
          const profileTagNoisePattern = /^(?:\\d+(?:\\.\\d+)?|\\d{1,2}:\\d{2}|\\d{1,2}\\/\\d{1,2}|\\u5468[\\u4e00\\u4e8c\\u4e09\\u56db\\u4e94\\u516d\\u65e5\\u5929]|\\u7f6e\\u9876|\\u76f4\\u64ad|\\u56fe\\u6587(?:\\u6765\\u4e86)?|\\u89c6\\u9891|\\u5c55\\u5f00|\\u6536\\u8d77)$/i;
          const profileContentAncestorSelector = [
            '[data-e2e*=aweme]', '[data-e2e*=video-card]', '[data-e2e*=note-card]',
            '[class*=video-card]', '[class*=VideoCard]', '[class*=feed-card]', '[class*=FeedCard]',
            'a[href*="/video/"]', 'a[href*="/note/"]',
          ].join(', ');
          const profileTagValue = (node) => {
            if (node.closest(profileContentAncestorSelector)) return '';
            const value = clean(node.textContent);
            if (!value || value.length > 48 || value === author || value === handle
              || metricPattern.test(value) || profileShellPattern.test(value) || profileTagNoisePattern.test(value)) return '';
            return value;
          };
          const profileTags = unique(
            Array.from(profileHeaderRoot?.querySelectorAll(
              '[data-e2e*=tag], [data-e2e*=badge], [class*=tag], [class*=Tag], [class*=badge], [class*=Badge], a[href*=challenge], a[href*=topic]'
            ) || [])
              .map(profileTagValue)
              .filter(Boolean),
            12,
          );
          const audiencePattern = /(?:\\u7c89\\u4e1d(?:\\u7fa4|\\u56e2|\\u724c)|\\u94c1\\u7c89|\\u7c89\\u4e1d\\u6807\\u7b7e|fans?\\s*(?:group|club))/i;
          const audienceShellPattern = /(?:\\u767b\\u5f55|\\u6ce8\\u518c|\\u8d26\\u53f7|\\u8d26\\u6237|\\u4e2a\\u4eba\\u4e2d\\u5fc3|\\u9000\\u51fa|\\u5ba2\\u6237\\u7aef|\\u8ba2\\u5355|\\u89c2\\u770b\\u5386\\u53f2|\\u7a0d\\u540e\\u518d\\u770b|\\u5145\\u94bb\\u77f3|\\u94b1\\u5305|\\u901a\\u77e5|\\u6d88\\u606f|\\u6295\\u7a3f)/i;
          const audienceCtaPattern = /(?:\\u79c1\\u4fe1|\\u8fdb\\u7fa4|\\u8054\\u7cfb|\\u54a8\\u8be2|\\u6dfb\\u52a0|\\u5fae\\u4fe1|\\bvx\\b)/i;
          const audienceFreeTextPattern = /[,.\\uff0c\\u3002!\\uff01?\\uff1f;\\uff1b:\\uff1a]/;
          const audienceSignal = (value) => {
            const normalized = clean(value)
              .replace(/(?:\\s*(?:\\.\\.\\.|\\u2026))?\\s*(?:\\u66f4\\u591a|\\u5c55\\u5f00|\\u6536\\u8d77)?\\s*$/i, '')
              .replace(/(?:\\.\\.\\.|\\u2026)\\s*$/, '');
            if (!normalized || normalized.length > 48 || !audiencePattern.test(normalized)
              || audienceShellPattern.test(normalized) || audienceCtaPattern.test(normalized)
              || audienceFreeTextPattern.test(normalized) || new RegExp(metricPairPattern.source, 'i').test(normalized)) return '';
            if (/^(?:\\u7c89\\u4e1d\\u7fa4|\\u7c89\\u4e1d\\u56e2|\\u7c89\\u4e1d\\u724c|\\u94c1\\u7c89|\\u7c89\\u4e1d\\u6807\\u7b7e|fans?\\s*(?:group|club))$/i.test(normalized)) return '';
            return normalized;
          };
          const publicAudienceSignals = (() => {
            const seen = new Set();
            const signals = [];
            for (const value of profileHeaderText) {
              const signal = audienceSignal(value);
              const key = signal.toLowerCase().replace(/[\\s\\u3000]+/g, '');
              if (!signal || seen.has(key)) continue;
              seen.add(key);
              signals.push(signal);
              if (signals.length >= 8) break;
            }
            return signals;
          })();
          const profileCardSelector = [
            '[data-e2e*=aweme]', '[data-e2e*=video-card]', '[data-e2e*=note-card]', '[class*=video-card]',
            '[class*=VideoCard]', '[class*=feed-card]', '[class*=FeedCard]',
          ].join(', ');
          const contentLinkSelector = 'a[href*="/video/"], a[href*="/note/"]';
          const sampleRoots = Array.from(new Set([
            ...Array.from(document.querySelectorAll(profileCardSelector)),
            ...Array.from(document.querySelectorAll(contentLinkSelector)).map((anchor) =>
              anchor.closest('article, li, [data-e2e*=aweme], [data-e2e*=video-card], [data-e2e*=note-card], [class*=video-card], [class*=VideoCard], [class*=feed-card], [class*=FeedCard], [class*=card], [class*=Card]') || anchor
            ),
          ])).filter((root) => {
            const text = clean(root.innerText);
            return text.length >= 3 && text.length <= 1200;
          });
          const latestSamples = [];
          const sampleKeys = new Set();
          for (const root of sampleRoots) {
            const anchor = root.matches(contentLinkSelector) ? root : root.querySelector(contentLinkSelector);
            const noteUrl = absolute(anchor?.getAttribute('href'));
            const image = root.querySelector('img');
            const imageUrls = Array.from(root.querySelectorAll('img'))
              .filter((node) => !/(?:avatar|head|user|author|profile)/i.test(nodeMeta(node)))
              .map((node) => absolute(node.currentSrc || node.getAttribute('src')))
              .filter(Boolean).slice(0, 8);
            const sampleText = clean(root.innerText).slice(0, 900);
            const sampleTitle = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent);
            const sampleKey = noteUrl || [sampleTitle, sampleText.slice(0, 140)].filter(Boolean).join(' ');
            if (!sampleKey || sampleKeys.has(sampleKey)) continue;
            sampleKeys.add(sampleKey);
            const sampleTags = unique(sampleText.match(/#[^#\\s]{2,32}/g) || [], 12);
            const imageCount = contentImageCount(root);
            const format = contentFormat(root, noteUrl, imageCount);
            const published = visiblePublishedAt(sampleText);
            const statistics = {
              digg_count: cardMetric(root, ['\\u70b9\\u8d5e', '\\u8d5e', 'like', 'digg'], true),
              comment_count: cardMetric(root, ['\\u8bc4\\u8bba', 'comment']),
              collect_count: cardMetric(root, ['\\u6536\\u85cf', 'collect']),
              share_count: cardMetric(root, ['\\u5206\\u4eab', '\\u8f6c\\u53d1', 'share']),
            };
            const publishedAt = (sampleText.match(/(?:20\\d{2}[.\\-/]\\d{1,2}[.\\-/]\\d{1,2}|(?:0?[1-9]|1[0-2])[.\\-/](?:0?[1-9]|[12]\\d|3[01]))(?!\\s*(?:w|k|\\u4e07|\\u4ebf))/i) || [''])[0];
            const commercialMarkers = explicitCommercialMarkers(sampleText);
            latestSamples.push({
              note_url: noteUrl,
              title: sampleTitle,
              body: sampleText.slice(0, 600),
              cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
              image_urls: imageUrls,
              content_type: root.querySelector('video') ? 'video' : 'video_or_image',
              content_format: format || null,
              content_image_count: imageCount,
              has_video: format === 'video',
              hashtags: sampleTags,
              topic_labels: topicLabels(sampleTags),
              published_at: published.value || publishedAt || null,
              published_time_text: published.time || null,
              duration_seconds: cardDurationSeconds(root),
              is_pinned: cardHasPinnedBadge(root) ? true : null,
              commercial_markers: commercialMarkers.length ? commercialMarkers : null,
              statistics,
            });
            if (latestSamples.length >= profileSampleLimit) break;
          }
          const sampleTotals = latestSamples.reduce((totals, sample) => {
            for (const key of ['digg_count', 'comment_count', 'collect_count', 'share_count']) {
              const value = numericMetric(sample.statistics[key]);
              if (value === null) continue;
              totals.values[key] += value;
              totals.observed[key] += 1;
            }
            return totals;
          }, {
            values: { digg_count: 0, comment_count: 0, collect_count: 0, share_count: 0 },
            observed: { digg_count: 0, comment_count: 0, collect_count: 0, share_count: 0 },
          });
          for (const key of Object.keys(sampleTotals.values)) {
            if (!sampleTotals.observed[key]) sampleTotals.values[key] = '';
          }
          const profileBody = clean([
            profileBio,
            ...latestSamples.map((sample) => [sample.title, sample.body, ...(sample.hashtags || [])].filter(Boolean).join(' ')),
          ].filter(Boolean).join('\\n')).slice(0, 3200);
          const avatarUrl = absolute(profileImage?.currentSrc || profileImage?.getAttribute('src'));
          return [{
            author: author,
            observed_name: author,
            expected_name: expectedName,
            profile_identity_extracted: Boolean(author),
            author_profile: location.href,
            note_url: '',
            title: clean(document.title),
            body: profileBody,
            bio: profileBio,
            handle,
            location: profileLocation,
            verified,
            verified_label: verifiedLabel,
            follower_count: metrics.followers,
            following_count: metrics.following,
            like_count: metrics.likes,
            work_count: metrics.works,
            avatar_url: avatarUrl,
            cover_url: avatarUrl,
            tags: tags.join(' | '),
            profile_tags: profileTags.length ? profileTags : null,
            latest_samples: latestSamples,
            public_audience_signals: publicAudienceSignals,
            content_summary: {
              visible_sample_count: latestSamples.length,
              sample_interactions: sampleTotals.values,
              sampled_from_public_profile: true,
            },
            profile: {
              nickname: author,
              handle,
              bio: profileBio,
              location: profileLocation,
              verified,
              verified_label: verifiedLabel,
              avatar: avatarUrl,
              tags,
              profile_tags: profileTags.length ? profileTags : null,
              metrics,
              visible_metrics: visibleMetrics,
              public_audience_signals: publicAudienceSignals,
              latest_samples: latestSamples,
              content_summary: {
                visible_sample_count: latestSamples.length,
                sample_interactions: sampleTotals.values,
                sampled_from_public_profile: true,
              },
            },
            scraped_at: new Date().toISOString(),
            source_profile_url: location.href,
          }];
        }""",
        {"expectedName": expected_name, "profileSampleLimit": profile_sample_limit},
    )
    return enrich_profile_records(records)


def observed_public_value(value):
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


def normalized_profile_name(value):
    return re.sub(r"\s+", "", str(value or "")).casefold()


def profile_capture_identity_confirmed(record, expected_name=""):
    """Accept a header snapshot only when its visible name belongs to this target."""
    if not isinstance(record, dict):
        return False
    observed_name = normalized_profile_name(record.get("observed_name") or record.get("author"))
    expected = normalized_profile_name(expected_name or record.get("expected_name"))
    if not observed_name:
        return False
    if expected:
        return observed_name == expected
    # A direct profile invocation without a display-name target can only retain
    # a locally rendered identity, never a shell/nav value.
    return bool(record.get("profile_identity_extracted") and record.get("author_profile"))


def profile_header_capture_score(records, expected_name=""):
    """Rank only identity-confirmed local profile-header fields for bounded polling."""
    if not records or not isinstance(records[0], dict):
        return -1
    record = records[0]
    if not profile_capture_identity_confirmed(record, expected_name):
        return -1

    profile = record.get("profile") if isinstance(record.get("profile"), dict) else {}
    metrics = profile.get("metrics") if isinstance(profile.get("metrics"), dict) else {}
    score = 100
    score += sum(
        24 for key in ("followers", "following", "likes", "works")
        if observed_public_value(metrics.get(key))
    )
    score += sum(
        8 for key in ("bio", "handle", "location", "avatar", "verified_label")
        if observed_public_value(profile.get(key))
    )
    score += min(len(profile.get("visible_metrics") or []), 4) * 4
    return score


def capture_profile_header_with_retry(page, expected_name):
    """Poll the rendered profile header before scrolling virtualizes it away."""
    best_records = []
    best_score = -1
    for attempt in range(PROFILE_HEADER_POLL_ATTEMPTS):
        if page_access_state(page):
            break
        try:
            records = extract_profile(page, expected_name)
        except Exception:
            records = []
        score = profile_header_capture_score(records, expected_name)
        if score > best_score:
            best_records = records
            best_score = score
        if attempt < PROFILE_HEADER_POLL_ATTEMPTS - 1:
            page.wait_for_timeout(PROFILE_HEADER_POLL_INTERVAL_MS)
    return best_records


def merge_profile_captures(header_records, content_records, accumulated_samples=None, profile_sample_limit=PROFILE_SAMPLE_LIMIT):
    """Keep an early profile-header snapshot when scroll virtualization removes it."""
    header = header_records[0] if header_records else None
    content = content_records[0] if content_records else None
    if content:
        merged = dict(content)
    elif header:
        merged = dict(header)
    else:
        return []

    if header and content and profile_capture_identity_confirmed(header):
        for field in (
            "author", "observed_name", "profile_identity_extracted", "bio", "handle", "location", "verified",
            "verified_label", "follower_count", "following_count", "like_count",
            "work_count", "avatar_url", "cover_url",
        ):
            if observed_public_value(header.get(field)):
                merged[field] = header[field]

        header_profile = header.get("profile") or {}
        content_profile = merged.get("profile") or {}
        merged_profile = dict(content_profile)
        for field in (
            "nickname", "handle", "bio", "location", "verified", "verified_label",
            "avatar", "visible_metrics", "public_audience_signals",
        ):
            if observed_public_value(header_profile.get(field)):
                merged_profile[field] = header_profile[field]

        merged_metrics = dict(content_profile.get("metrics") or {})
        for key, value in (header_profile.get("metrics") or {}).items():
            if observed_public_value(value):
                merged_metrics[key] = value
        merged_profile["metrics"] = merged_metrics
        merged["profile"] = merged_profile

    merged_profile = dict(merged.get("profile") or {})
    merged_samples = merge_profile_samples(
        accumulated_samples or [],
        header.get("latest_samples") if isinstance(header, dict) else [],
        header.get("profile", {}).get("latest_samples") if isinstance(header, dict) and isinstance(header.get("profile"), dict) else [],
        content.get("latest_samples") if isinstance(content, dict) else [],
        content.get("profile", {}).get("latest_samples") if isinstance(content, dict) and isinstance(content.get("profile"), dict) else [],
        limit=profile_sample_limit,
    )
    merged["latest_samples"] = merged_samples
    merged_profile["latest_samples"] = merged_samples
    merged["profile"] = merged_profile
    remaining = content_records[1:] if content_records else []
    return enrich_profile_records([merged, *remaining])


def main():
    parser = argparse.ArgumentParser(description="Collect public Douyin creator cards from an attached browser session.")
    parser.add_argument("--query", default="")
    parser.add_argument("--profile-url", default="")
    parser.add_argument("--expected-name", default="")
    parser.add_argument(
        "--profile-sample-limit",
        type=int,
        default=PROFILE_SAMPLE_LIMIT,
        help="Maximum currently visible public profile content cards to collect (1-10000).",
    )
    parser.add_argument("--relay-port", type=int, default=18792)
    parser.add_argument("--limit", type=int, default=MAX_SEARCH_RESULTS, help="0 uses the controlled full batch (10000).")
    parser.add_argument("--search-url-template", default="https://www.douyin.com/search/{query}?type=general")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    if not args.query and not args.profile_url:
        parser.error("one of --query or --profile-url is required")

    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "douyin_creators_latest.json"
    status_path = output_dir / "douyin_collection_status.json"
    target_url = args.profile_url or args.search_url_template.replace("{query}", quote(args.query, safe=""))
    profile_sample_limit = max(1, min(args.profile_sample_limit, MAX_PROFILE_SAMPLE_LIMIT))

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{args.relay_port}",
                headers=relay_headers(args.relay_port),
                timeout=120000,
            )
            if not browser.contexts:
                raise RuntimeError("The attached browser has no reusable context.")
            context = browser.contexts[0]
            # The collector never navigates a page the user already has open.
            page = context.new_page()
            try:
                response_capture = None
                if not args.profile_url:
                    response_capture = SearchResponseCapture(target_url)
                    page.on("response", response_capture.on_response)
                page.goto(target_url, wait_until="domcontentloaded", timeout=120000)
                initial_state = page_access_state(page)
                if initial_state:
                    status_path.write_text(
                        json.dumps(
                            blocked_collection_status(
                                "profile" if args.profile_url else "search",
                                initial_state,
                                args.limit,
                                page.url,
                            ),
                            ensure_ascii=False,
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                    return blocked_state_exit(initial_state)
                if args.profile_url:
                    page.wait_for_timeout(1200)
                    profile_state = page_access_state(page)
                    if profile_state:
                        status_path.write_text(
                            json.dumps(
                                blocked_collection_status("profile", profile_state, args.limit, page.url),
                                ensure_ascii=False,
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                        return blocked_state_exit(profile_state)
                    header_records = capture_profile_header_with_retry(page, args.expected_name)
                    profile_scroll_state = warm_profile_content(page, profile_sample_limit)
                    records = merge_profile_captures(
                        header_records,
                        extract_profile(page, args.expected_name, profile_sample_limit),
                        profile_scroll_state["latest_samples"],
                        profile_sample_limit,
                    )
                    merged_sample_count = len(records[0].get("latest_samples") or []) if records else 0
                    coverage = profile_collection_coverage(
                        profile_scroll_state["stop_reason"],
                        profile_sample_limit,
                        merged_sample_count,
                        profile_scroll_state["last_scroll_control_succeeded"],
                    )
                    status = {
                        "mode": "profile",
                        "requested_limit": args.limit,
                        "records_collected": len(records),
                        "unique_profiles": len({record.get("author_profile") for record in records if record.get("author_profile")}),
                        "scrolls_attempted": profile_scroll_state["scrolls"],
                        "scroll_budget": profile_scroll_budget(profile_sample_limit),
                        "idle_scroll_limit": profile_idle_scroll_limit(profile_sample_limit),
                        "content_sample_limit": profile_sample_limit,
                        "observed_profile_card_count": profile_scroll_state["observed_card_count"],
                        "last_visible_profile_card_count": profile_scroll_state["last_visible_card_count"],
                        "stop_reason": profile_scroll_state["stop_reason"],
                        "cumulative_public_page_cards": merged_sample_count,
                        "cumulative_unique_accounts": len({record.get("author_profile") for record in records if record.get("author_profile")}),
                        **coverage,
                        "scroll_progress": {
                            "scrolls_attempted": profile_scroll_state["scrolls"],
                            "scroll_budget": profile_scroll_budget(profile_sample_limit),
                            "last_scroll_control_succeeded": profile_scroll_state["last_scroll_control_succeeded"],
                        },
                        "stop_evidence": {
                            "classification": profile_scroll_state["stop_reason"],
                            "continuation_recommended": coverage["continuation_recommended"],
                            "coverage_state": coverage["coverage_state"],
                            "next_collection_action": coverage["next_collection_action"],
                            "last_scroll_control_succeeded": profile_scroll_state["last_scroll_control_succeeded"],
                        },
                        "public_data_scope": "profile_and_visible_content",
                        "completed_at": datetime.now().isoformat(timespec="seconds"),
                        "source_profile_url": page.url,
                    }
                else:
                    limit = MAX_SEARCH_RESULTS if args.limit <= 0 else min(max(1, args.limit), MAX_SEARCH_RESULTS)
                    collection = collect_search_response_records(
                        page,
                        response_capture,
                        limit,
                    )
                    search_state = collection["access_state"]
                    if search_state:
                        status = blocked_collection_status("search", search_state, limit, page.url)
                        status.update({
                            "response_records": len(collection["response_records"]),
                            "markup_records": len(collection["markup_records"]),
                            "cumulative_public_page_cards": collection["cumulative_public_page_cards"],
                            "cumulative_unique_accounts": collection["cumulative_unique_accounts"],
                            "scrolls_attempted": collection["scrolls_attempted"],
                            "scroll_budget": collection["scroll_budget"],
                            "scroll_progress": collection["scroll_progress"],
                            "stop_reason": collection["stop_reason"],
                            "stop_evidence": collection["stop_evidence"],
                            "source_search_url": page.url,
                        })
                        status_path.write_text(
                            json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
                        )
                        return blocked_state_exit(search_state)
                    response_records = collection["response_records"]
                    markup_records = collection["markup_records"]
                    # Response and rendered cards are both normal public search
                    # surfaces; merge by creator only after coverage accounting.
                    records = merge_search_candidates(response_records, markup_records, limit)
                    status = {
                        "requested_limit": limit,
                        "records_collected": len(records),
                        "unique_profiles": len({record.get("author_profile") for record in records if record.get("author_profile")}),
                        "response_records": len(response_records),
                        "markup_records": len(markup_records),
                        "cumulative_public_page_cards": collection["cumulative_public_page_cards"],
                        "cumulative_unique_accounts": collection["cumulative_unique_accounts"],
                        "scrolls_attempted": collection["scrolls_attempted"],
                        "scroll_budget": collection["scroll_budget"],
                        "idle_scroll_limit": MAX_IDLE_SCROLLS,
                        "scroll_progress": collection["scroll_progress"],
                        "stop_reason": collection["stop_reason"],
                        "stop_evidence": collection["stop_evidence"],
                        "completed_at": datetime.now().isoformat(timespec="seconds"),
                        "source_search_url": page.url,
                    }
                status_path.write_text(
                    json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                output_path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
                if args.profile_url:
                    print(f"Collected {len(records)} Douyin profile record at {datetime.now().isoformat(timespec='seconds')}")
                else:
                    print(
                        f"Collected {len(records)} Douyin creator cards "
                        f"(requested={limit}, stop={status['stop_reason']}, scrolls={status['scrolls_attempted']}) "
                        f"at {datetime.now().isoformat(timespec='seconds')}"
                    )
                return 0 if records else 1
            finally:
                page.close()
    except Exception as error:
        print(f"Douyin relay collection failed: {error}")
        return 3


if __name__ == "__main__":
    sys.exit(main())
