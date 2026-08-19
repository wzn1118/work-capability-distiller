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
from urllib.parse import urlsplit, urlunsplit

from playwright.sync_api import sync_playwright

from public_profile_fields import enrich_profile_records


# A real Relay session remains interactive, so discovery remains finite. The
# product normally shards a 10,000-candidate channel target across routes; this
# cap also makes an explicitly configured single route deterministic.
MAX_SEARCH_RESULTS = 10_000
MAX_AUTOMATIC_SCROLLS = 1_800
STABLE_CREATOR_ROUNDS = 8
MAX_CARDS_EXTRACTED_PER_PASS = 20_000
PROFILE_SAMPLE_LIMIT = 10000
MAX_PROFILE_SAMPLE_LIMIT = 10000
MIN_PROFILE_CONTENT_SCROLLS = 6
MAX_PROFILE_CONTENT_SCROLLS = 2500
PROFILE_TARGET_CARDS_PER_SCROLL = 4
MIN_PROFILE_IDLE_SCROLLS = 2
MAX_PROFILE_IDLE_SCROLLS = 5
SEARCH_SCROLL_INITIAL_SETTLE_MS = 900
PROFILE_PAGE_HYDRATION_TIMEOUT_MS = 1200
PROFILE_SCROLL_SETTLE_TIMEOUT_MS = 900
ADAPTIVE_POLL_INITIAL_MS = 80
ADAPTIVE_POLL_MAX_MS = 250


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
    token = hmac.new(
        get_gateway_token().encode("utf-8"),
        f"openclaw-extension-relay-v1:{port}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {"x-openclaw-relay-token": token}


def has_login_wall(page):
    try:
        text = page.locator("body").inner_text(timeout=3000)[:5000]
        markers = ("登录后查看", "手机号登录", "请登录", "登录即可")
        return any(marker in text for marker in markers)
    except Exception:
        return False


def has_verification_wall(page):
    """Detect platform verification routes before treating their contents as a profile."""
    try:
        url = (page.url or "").lower()
        return any(marker in url for marker in (
            "/website-login/captcha",
            "/captcha",
            "/security/verify",
        ))
    except Exception:
        return False


def blocked_collection_summary(mode, state, requested_limit, source_url):
    """Leave structured public-page stop evidence when user action is required."""
    return {
        "mode": mode,
        "requested_limit": requested_limit,
        "effective_limit": 0,
        "raw_candidate_cards": 0,
        "unique_creators": 0,
        "returned_creators": 0,
        "cumulative_public_page_cards": 0,
        "cumulative_unique_accounts": 0,
        "search_passes": 0,
        "scrolls_performed": 0,
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
        "source_url": source_url,
    }


def wait_for_search_cards(page, timeout_ms=12_000):
    deadline = time.monotonic() + (timeout_ms / 1000)
    while time.monotonic() < deadline:
        if has_login_wall(page):
            return False
        try:
            ready = page.evaluate(
                """() => Array.from(document.querySelectorAll(
                  'section.note-item, [class*=note-item], [class*=noteItem], [class*=note-card], [class*=NoteCard], [class*=feed-item], [class*=FeedItem], [data-note-id], [data-noteid]'
                )).some((root) => (
                  root.querySelector('a[href*="/user/profile/"]')
                  && root.querySelector('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]')
                ))"""
            )
            if ready:
                return True
        except Exception:
            pass
        page.wait_for_timeout(250)
    return False


def extract_search_cards(page, limit):
    return page.evaluate(
        """(limit) => {
          const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
          const absolute = (value) => {
            if (!value) return '';
            try { return new URL(value, location.href).href; } catch { return ''; }
          };
          const cardRoots = Array.from(new Set(document.querySelectorAll(
            'section.note-item, [class*=note-item], [class*=noteItem], [class*=note-card], [class*=NoteCard], [class*=feed-item], [class*=FeedItem], [data-note-id], [data-noteid]'
          )));
          const seen = new Set();
          const items = [];
          const contentImageCount = (root) => Array.from(root.querySelectorAll('img')).filter((node) => {
            const meta = [node.className || '', node.getAttribute('alt') || '', node.getAttribute('data-e2e') || ''].join(' ').toLowerCase();
            return !/(?:avatar|head|user|author|profile)/.test(meta);
          }).length;
          for (const root of cardRoots) {
            const profile = root.querySelector('a[href*="/user/profile/"]');
            const note = root.querySelector('a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]');
            const authorProfile = absolute(profile?.getAttribute('href'));
            const noteUrl = absolute(note?.getAttribute('href'));
            const author = clean(profile?.querySelector('.name, [class*="nickname"], [class*="author-name"], [class*="user-name"]')?.textContent)
              || clean(root.querySelector('.author .name, [class*="author-name"], [class*="user-name"]')?.textContent)
              || clean(profile?.textContent);
            if (!authorProfile || !noteUrl) continue;
            // Preserve each public content card for coverage accounting. Creator
            // dedupe is performed after cards have been accumulated.
            const key = noteUrl || authorProfile || author;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const image = root.querySelector('img');
            const body = clean(root.innerText).slice(0, 900);
            const title = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent);
            const counts = Array.from(root.querySelectorAll('[class*=count], [class*=interact]'))
              .map((node) => clean(node.textContent)).filter(Boolean);
            const hashtags = Array.from(root.querySelectorAll('[class*=tag], [class*=badge]'))
              .map((node) => clean(node.textContent)).filter(Boolean).slice(0, 12);
            const imageCount = contentImageCount(root);
            const hasVideo = Boolean(root.querySelector('video'));
            const contentFormat = hasVideo ? 'video' : imageCount >= 2 ? 'image_carousel' : imageCount ? 'image_note' : '';
            const statistics = {
              like_count: counts[0] || '',
              collect_count: counts[1] || '',
              comment_count: counts[2] || '',
            };
            items.push({
              note_id: noteUrl,
              author,
              author_profile: authorProfile,
              note_url: noteUrl,
              title,
              body,
              tags: hashtags.join(' | '),
              like_count: statistics.like_count,
              collect_count: statistics.collect_count,
              comment_count: statistics.comment_count,
              latest_samples: [{
                note_url: noteUrl,
                title,
                body: body.slice(0, 600),
                cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
                content_type: hasVideo ? 'video' : 'image_or_note',
                content_format: contentFormat || null,
                content_image_count: imageCount,
                has_video: hasVideo,
                hashtags,
                topic_labels: hashtags.map((tag) => tag.replace(/^[#\\uff03]/, '')).filter(Boolean),
                statistics,
              }],
              card_cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
              scraped_at: new Date().toISOString(),
              source_search_url: location.href,
            });
            if (items.length >= limit) break;
          }
          return items;
        }""",
        limit,
    )


def candidate_identity(record):
    """Use the stable profile path for dedupe while retaining the original source URL."""
    value = record.get("author_profile") or record.get("note_url") or record.get("author") or ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme and parsed.netloc:
            return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
    except ValueError:
        pass
    return value.strip()


def source_card_identity(record):
    """Keep a separate source-card count before collapsing records by creator."""
    value = record.get("note_url") or record.get("note_id") or candidate_identity(record)
    try:
        parsed = urlsplit(value)
        if parsed.scheme and parsed.netloc:
            return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
    except ValueError:
        pass
    return value.strip()


def search_surface_state(page):
    """Capture coarse progress from the normal public search surface."""
    try:
        return page.evaluate(
            """() => {
              const cardSelector = 'section.note-item, [class*=note-item], [class*=noteItem], [class*=note-card], [class*=NoteCard], [class*=feed-item], [class*=FeedItem], [data-note-id], [data-noteid]';
              const cardRoots = Array.from(new Set(document.querySelectorAll(cardSelector)));
              const profileLinks = Array.from(document.querySelectorAll('a[href*="/user/profile/"]'))
                .filter((node) => node.closest(cardSelector));
              const contentLinks = Array.from(document.querySelectorAll(
                'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]'
              )).filter((node) => node.closest(cardSelector));
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
                visible_card_roots: cardRoots.length,
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
    """Recognize virtual-list replacement even if visible-card counts stay flat."""
    if not isinstance(previous, dict) or not isinstance(latest, dict):
        return False
    return (
        int(latest.get("top") or 0) > int(previous.get("top") or 0) + 8
        or int(latest.get("height") or 0) > int(previous.get("height") or 0) + 20
        or int(latest.get("visible_content_links") or 0) > int(previous.get("visible_content_links") or 0)
        or str(latest.get("visible_identity_fingerprint") or "") != str(previous.get("visible_identity_fingerprint") or "")
    )


def content_surface_progressed(previous, latest):
    """Recognize content mutation without treating a normal wheel move as a load."""
    if not isinstance(previous, dict) or not isinstance(latest, dict):
        return False
    return (
        int(latest.get("height") or 0) > int(previous.get("height") or 0) + 20
        or int(latest.get("visible_card_roots") or 0) > int(previous.get("visible_card_roots") or 0)
        or int(latest.get("visible_content_links") or 0) > int(previous.get("visible_content_links") or 0)
        or str(latest.get("visible_identity_fingerprint") or "")
        != str(previous.get("visible_identity_fingerprint") or "")
    )


def next_adaptive_poll_delay(delay_ms):
    """Increase a short public-page poll interval without exceeding the existing cadence."""
    return min(ADAPTIVE_POLL_MAX_MS, max(ADAPTIVE_POLL_INITIAL_MS, int(delay_ms * 1.5)))


def wait_for_search_update(page, previous_state, timeout_ms=4_000):
    """Wait for rendered content mutation while retaining the prior total budget."""
    started_at = time.monotonic()
    deadline = started_at + ((timeout_ms + SEARCH_SCROLL_INITIAL_SETTLE_MS) / 1000)
    latest_state = previous_state
    delay_ms = ADAPTIVE_POLL_INITIAL_MS
    scroll_only_deadline = None
    while time.monotonic() < deadline:
        if has_login_wall(page) or has_verification_wall(page):
            return latest_state
        try:
            latest_state = search_surface_state(page)
            if content_surface_progressed(previous_state, latest_state):
                return latest_state
            if surface_progressed(previous_state, latest_state):
                # A normal wheel move is not enough to prove cards have loaded.
                # Preserve the prior 900 ms observation window before returning
                # the scroll-only state used by existing stop accounting.
                if scroll_only_deadline is None:
                    scroll_only_deadline = min(
                        deadline,
                        started_at + (SEARCH_SCROLL_INITIAL_SETTLE_MS / 1000),
                    )
        except Exception:
            pass
        active_deadline = min(deadline, scroll_only_deadline) if scroll_only_deadline else deadline
        remaining_ms = int((active_deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            break
        page.wait_for_timeout(min(delay_ms, max(1, remaining_ms)))
        delay_ms = next_adaptive_poll_delay(delay_ms)
    return latest_state


def scroll_search_results(page, distance=2600):
    """Scroll the active search surface without touching any user-owned tab."""
    try:
        page.mouse.wheel(0, distance)
        return True
    except Exception:
        pass

    try:
        return bool(page.evaluate(
            """(delta) => {
              const roots = [
                document.scrollingElement,
                document.querySelector('[class*=scroll]'),
                document.querySelector('[class*=feed]'),
                document.body,
              ].filter(Boolean);
              const target = roots.find((node) => node.scrollHeight > node.clientHeight + 20) || document.scrollingElement;
              if (!target || typeof target.scrollBy !== 'function') return false;
              target.scrollBy(0, delta);
              return true;
            }""",
            distance,
        ))
    except Exception:
        return False


def stop_disposition(stop_reason):
    if stop_reason == "target_reached":
        return "target_reached", False
    if stop_reason.startswith("platform_"):
        return "platform_action_required", False
    if stop_reason == "scroll_budget_reached":
        return "bounded_scan_limit", True
    return "retryable_collection_gap", True


def collect_search_cards(page, limit, max_scrolls=0):
    """Collect public cards and creators with retryable, evidence-backed stopping."""
    target = MAX_SEARCH_RESULTS if limit <= 0 else min(max(1, limit), MAX_SEARCH_RESULTS)
    # Initial pages commonly have around a dozen cards.  The automatic budget
    # grows with the requested volume but always remains finite.
    automatic_budget = min(MAX_AUTOMATIC_SCROLLS, max(18, (target + 5) // 6 + 4))
    scroll_budget = min(MAX_AUTOMATIC_SCROLLS, max_scrolls) if max_scrolls else automatic_budget
    # Keep enough loaded cards available for identity dedupe at high volume.
    extraction_limit = min(MAX_CARDS_EXTRACTED_PER_PASS, max(target * 2, 180))
    records_by_identity = {}
    source_card_ids = set()
    no_new_unique_account_rounds = 0
    no_new_public_card_rounds = 0
    no_surface_progress_rounds = 0
    scrolls_performed = 0
    search_passes = 0
    extraction_errors = 0
    last_scroll_control_succeeded = True
    last_surface_state = search_surface_state(page)
    stop_reason = "scroll_budget_reached"

    for scroll_index in range(scroll_budget + 1):
        if has_verification_wall(page):
            stop_reason = "platform_verification_required"
            break
        if has_login_wall(page):
            stop_reason = "platform_login_required"
            break

        search_passes += 1
        before_count = len(records_by_identity)
        before_card_count = len(source_card_ids)
        try:
            visible_records = extract_search_cards(page, extraction_limit)
        except Exception:
            visible_records = []
            extraction_errors += 1
        for record in visible_records:
            source_key = source_card_identity(record)
            if source_key:
                source_card_ids.add(source_key)
            key = candidate_identity(record)
            if key and key not in records_by_identity:
                records_by_identity[key] = record

        new_unique_accounts = len(records_by_identity) - before_count
        new_public_cards = len(source_card_ids) - before_card_count
        last_surface_state = search_surface_state(page)

        if len(records_by_identity) >= target:
            stop_reason = "target_reached"
            break

        if new_unique_accounts:
            no_new_unique_account_rounds = 0
        else:
            no_new_unique_account_rounds += 1
        if new_public_cards:
            no_new_public_card_rounds = 0
        else:
            no_new_public_card_rounds += 1
        if scroll_index >= scroll_budget:
            stop_reason = "scroll_budget_reached"
            break

        previous_state = last_surface_state
        last_scroll_control_succeeded = scroll_search_results(page)
        if not last_scroll_control_succeeded:
            stop_reason = "scroll_control_failed_retryable"
            break
        scrolls_performed += 1
        last_surface_state = wait_for_search_update(page, previous_state)
        if has_verification_wall(page):
            stop_reason = "platform_verification_required"
            break
        if has_login_wall(page):
            stop_reason = "platform_login_required"
            break
        if surface_progressed(previous_state, last_surface_state):
            no_surface_progress_rounds = 0
        else:
            no_surface_progress_rounds += 1
        if (
            no_new_unique_account_rounds >= STABLE_CREATOR_ROUNDS
            and no_new_public_card_rounds >= STABLE_CREATOR_ROUNDS
            and no_surface_progress_rounds >= STABLE_CREATOR_ROUNDS
        ):
            # This is a finite observation window, not proof that all platform
            # results have been exhausted. The route can be resumed later.
            stop_reason = "public_results_settled_retryable"
            break

    records = list(records_by_identity.values())[:target]
    reason_class, continuation_recommended = stop_disposition(stop_reason)
    return records, {
        "requested_limit": limit,
        "effective_limit": target,
        "raw_candidate_cards": len(source_card_ids),
        "unique_creators": len(records_by_identity),
        "returned_creators": len(records),
        "cumulative_public_page_cards": len(source_card_ids),
        "cumulative_unique_accounts": len(records_by_identity),
        "search_passes": search_passes,
        "scrolls_performed": scrolls_performed,
        "scroll_budget": scroll_budget,
        "stop_reason": stop_reason,
        "scroll_progress": {
            "scrolls_attempted": scrolls_performed,
            "scroll_budget": scroll_budget,
            "last_scroll_control_succeeded": last_scroll_control_succeeded,
            "last_surface_state": last_surface_state,
        },
        "stop_evidence": {
            "classification": reason_class,
            "continuation_recommended": continuation_recommended,
            "no_new_unique_account_rounds": no_new_unique_account_rounds,
            "no_new_public_card_rounds": no_new_public_card_rounds,
            "no_surface_progress_rounds": no_surface_progress_rounds,
            "last_scroll_control_succeeded": last_scroll_control_succeeded,
            "last_surface_state": last_surface_state,
            "extraction_errors": extraction_errors,
        },
    }


def profile_sample_count(page):
    """Count rendered public note links or profile card roots before bounded scrolling."""
    try:
        return page.evaluate(
            """() => {
              const links = new Set(Array.from(document.querySelectorAll(
                'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]'
              )).map((node) => node.href).filter(Boolean)).size;
              const cards = Array.from(document.querySelectorAll(
                'section.note-item, [class*=note-item], [class*=noteItem], [class*=note-card], [class*=NoteCard], [class*=feed-item], [class*=FeedItem], [data-note-id], [data-noteid]'
              )).filter((node) => (node.innerText || '').trim().length >= 3).length;
              return Math.max(links, cards);
            }"""
        )
    except Exception:
        return 0


def profile_scroll_budget(profile_sample_limit):
    """Use a safety guard; a stable rendered grid ends the scan before it is reached.

    The requested sample limit caps retained public cards. It is not an estimate
    that every four cards require one browser scroll.
    """
    return MAX_PROFILE_CONTENT_SCROLLS


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


def profile_content_surface_state(page):
    """Capture lightweight, rendered profile-card progress before full extraction."""
    try:
        return page.evaluate(
            """() => {
              const cardSelector = 'section.note-item, [class*=note-item], [class*=noteItem], [class*=note-card], [class*=NoteCard], [class*=feed-item], [class*=FeedItem], [data-e2e*=note-item], [data-note-id], [data-noteid]';
              const noteSelector = 'a[href*="/explore/"], a[href*="/discovery/item/"]';
              const visible = (node) => Boolean(
                node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
              );
              const cardRoots = Array.from(new Set(document.querySelectorAll(cardSelector))).filter(visible);
              const noteLinks = Array.from(document.querySelectorAll(noteSelector))
                .filter((node) => visible(node) && (node.closest(cardSelector) || node));
              const identities = [...new Set(noteLinks.map((node) => node.href || '').filter(Boolean))]
                .sort()
                .slice(0, 240);
              const fingerprint = identities.reduce((hash, value) => {
                for (let index = 0; index < value.length; index += 1) {
                  hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
                }
                return hash;
              }, 0);
              const roots = [
                document.scrollingElement,
                document.querySelector('[class*=scroll]'),
                document.querySelector('[class*=feed]'),
                document.body,
              ].filter(Boolean);
              const target = roots.find((node) => node.scrollHeight > node.clientHeight + 20) || document.scrollingElement;
              const height = Math.max(
                document.documentElement?.scrollHeight || 0,
                document.body?.scrollHeight || 0,
                target?.scrollHeight || 0,
              );
              const top = Math.max(window.scrollY || 0, target?.scrollTop || 0);
              const clientHeight = Math.max(window.innerHeight || 0, target?.clientHeight || 0);
              const terminalPattern = /(?:\u6ca1\u6709\u66f4\u591a|\u5df2\u7ecf\u5230\u5e95|\u5df2\u5230\u5e95|\u5168\u90e8\u52a0\u8f7d|no\\s+more|end\\s+of\\s+(?:list|feed|results))/i;
              const terminalMarker = Array.from(document.querySelectorAll(
                '[class*=load], [class*=Load], [class*=footer], [class*=Footer], [class*=end], [class*=End], [data-e2e*=load], [data-e2e*=end]'
              ))
                .filter(visible)
                .map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim())
                .find((value) => terminalPattern.test(value)) || '';
              return {
                visible_card_roots: cardRoots.length,
                visible_content_links: noteLinks.length,
                visible_identity_fingerprint: String(fingerprint),
                top,
                height,
                client_height: clientHeight,
                at_bottom: height > 0 && top + clientHeight >= height - 24,
                terminal_marker: terminalMarker,
              };
            }"""
        )
    except Exception:
        return {}


def profile_surface_ready(state):
    return bool(
        int(state.get("visible_card_roots") or 0)
        or int(state.get("visible_content_links") or 0)
    ) if isinstance(state, dict) else False


def profile_surface_end_reached(state):
    """Require a visible terminal marker and the bottom of the rendered surface."""
    return bool(
        isinstance(state, dict)
        and state.get("at_bottom")
        and str(state.get("terminal_marker") or "").strip()
    )


def wait_for_profile_cards(page, timeout_ms=PROFILE_PAGE_HYDRATION_TIMEOUT_MS):
    """Start profile work as soon as a rendered public card is available."""
    deadline = time.monotonic() + (timeout_ms / 1000)
    delay_ms = ADAPTIVE_POLL_INITIAL_MS
    while time.monotonic() < deadline:
        if has_login_wall(page) or has_verification_wall(page):
            return False
        if profile_surface_ready(profile_content_surface_state(page)):
            return True
        remaining_ms = int((deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            break
        page.wait_for_timeout(min(delay_ms, max(1, remaining_ms)))
        delay_ms = next_adaptive_poll_delay(delay_ms)
    return False


def wait_for_profile_content_update(page, previous_state, timeout_ms=PROFILE_SCROLL_SETTLE_TIMEOUT_MS):
    """Wait only until rendered profile content changes, with the former 900 ms cap."""
    deadline = time.monotonic() + (timeout_ms / 1000)
    latest_state = previous_state
    delay_ms = ADAPTIVE_POLL_INITIAL_MS
    while time.monotonic() < deadline:
        if has_login_wall(page):
            return latest_state, "login"
        if has_verification_wall(page):
            return latest_state, "verification"
        latest_state = profile_content_surface_state(page)
        if content_surface_progressed(previous_state, latest_state):
            return latest_state, ""
        remaining_ms = int((deadline - time.monotonic()) * 1000)
        if remaining_ms <= 0:
            break
        page.wait_for_timeout(min(delay_ms, max(1, remaining_ms)))
        delay_ms = next_adaptive_poll_delay(delay_ms)
    return latest_state, ""


def observed_public_value(value):
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


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


def merge_profile_samples_into(merged, positions, *sample_groups, limit=MAX_PROFILE_SAMPLE_LIMIT):
    """Extend one visible-card accumulator without rebuilding its index per scroll."""
    bounded_limit = max(1, min(int(limit or PROFILE_SAMPLE_LIMIT), MAX_PROFILE_SAMPLE_LIMIT))
    if not isinstance(merged, list):
        raise TypeError("merged must be a list")
    if not isinstance(positions, dict):
        raise TypeError("positions must be a dict")
    # Keep this helper safe for callers that seed an existing list but have not
    # built its identity index yet.
    if merged and not positions:
        for index, sample in enumerate(merged):
            identity = profile_sample_identity(sample)
            if identity and identity not in positions:
                positions[identity] = index
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


def merge_profile_samples(*sample_groups, limit=MAX_PROFILE_SAMPLE_LIMIT):
    """Merge visible-card snapshots by content identity, preserving first-seen order."""
    merged = []
    merge_profile_samples_into(merged, {}, *sample_groups, limit=limit)
    return merged


_XIAOHONGSHU_CONTENT_PATH = re.compile(
    r"^/(?:explore|discovery/item)/([^/?#]+)$", re.IGNORECASE
)


def canonical_xiaohongshu_content_url(value):
    """Keep a rendered Xiaohongshu content URL while dropping transient query data."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except Exception:
        return ""
    hostname = (parsed.hostname or "").lower().rstrip(".")
    path = (parsed.path or "").rstrip("/")
    if parsed.scheme.lower() != "https" or not hostname or not _XIAOHONGSHU_CONTENT_PATH.match(path):
        return ""
    if hostname != "xiaohongshu.com" and not hostname.endswith(".xiaohongshu.com"):
        return ""
    return urlunsplit(("https", hostname, path, "", ""))


def xiaohongshu_content_id(value):
    """Return the public content identifier embedded in a canonical content URL."""
    canonical_url = canonical_xiaohongshu_content_url(value)
    if not canonical_url:
        return ""
    match = _XIAOHONGSHU_CONTENT_PATH.match(urlsplit(canonical_url).path)
    return match.group(1) if match else ""


def canonical_xiaohongshu_profile_url(value):
    """Retain only the stable public profile path used as card provenance."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
    except Exception:
        return ""
    hostname = (parsed.hostname or "").lower().rstrip(".")
    path = (parsed.path or "/").rstrip("/") or "/"
    if parsed.scheme.lower() != "https" or not hostname:
        return ""
    if hostname != "xiaohongshu.com" and not hostname.endswith(".xiaohongshu.com"):
        return ""
    return urlunsplit(("https", hostname, path, "", ""))


def profile_card_field_sources(sample):
    """Describe only non-empty fields observed in a rendered public card."""
    fields = {}
    for key in (
        "note_url", "source_url", "content_id", "title", "body", "cover_url",
        "published_at", "published_time_text", "duration_seconds", "is_pinned",
        "content_type", "content_format", "content_image_count", "hashtags", "topic_labels",
        "commercial_markers",
    ):
        if observed_public_value(sample.get(key)):
            fields[key] = "rendered_visible_card"
    statistics = sample.get("statistics") if isinstance(sample.get("statistics"), dict) else {}
    for key in ("like_count", "collect_count", "comment_count", "share_count"):
        if observed_public_value(statistics.get(key)):
            fields[f"statistics.{key}"] = "rendered_visible_card"
    return fields


def normalize_profile_card_samples(samples, source_profile_url=""):
    """Validate public content links and attach auditable visible-DOM provenance."""
    if not isinstance(samples, list):
        return []
    profile_url = canonical_xiaohongshu_profile_url(source_profile_url)
    normalized = []
    for source in samples:
        if not isinstance(source, dict):
            continue
        sample = dict(source)
        note_url = canonical_xiaohongshu_content_url(sample.get("note_url") or sample.get("source_url"))
        if not note_url:
            # A profile card without a public content link is not a source work.
            continue
        sample["note_url"] = note_url
        sample["source_url"] = note_url
        sample["content_id"] = xiaohongshu_content_id(note_url)
        captured_at = str(sample.get("captured_at") or "").strip() or datetime.now().astimezone().isoformat(timespec="seconds")
        sample["captured_at"] = captured_at
        evidence = dict(sample.get("source_evidence") or {}) if isinstance(sample.get("source_evidence"), dict) else {}
        prior_fields = dict(evidence.get("fields") or {}) if isinstance(evidence.get("fields"), dict) else {}
        prior_fields.update(profile_card_field_sources(sample))
        evidence.update({
            "scope": "visible_public_profile_card",
            "collector": "browser_relay_visible_dom",
            "observed_at": captured_at,
            "source_profile_url": profile_url,
            "content_url": note_url,
            "fields": prior_fields,
        })
        sample["source_evidence"] = evidence
        normalized.append(sample)
    return normalized


def normalize_profile_capture_records(records):
    """Apply card URL and provenance rules to both header and post-scroll captures."""
    if not isinstance(records, list):
        return []
    output = []
    for source in records:
        if not isinstance(source, dict):
            continue
        record = dict(source)
        profile = dict(record.get("profile") or {}) if isinstance(record.get("profile"), dict) else {}
        profile_url = record.get("author_profile") or record.get("source_profile_url") or ""
        samples = record.get("latest_samples")
        if not isinstance(samples, list):
            samples = profile.get("latest_samples")
        normalized_samples = normalize_profile_card_samples(samples, profile_url)
        record["latest_samples"] = normalized_samples
        if profile:
            profile["latest_samples"] = normalized_samples
            record["profile"] = profile
        output.append(record)
    return output


def _legacy_extract_visible_profile_samples(page, profile_sample_limit=PROFILE_SAMPLE_LIMIT):
    """Read only currently rendered content cards so virtual-list cards survive scrolling."""
    bounded_limit = max(1, min(int(profile_sample_limit or PROFILE_SAMPLE_LIMIT), MAX_PROFILE_SAMPLE_LIMIT))
    try:
        payload = page.evaluate(
            """({ profileSampleLimit }) => {
              const clean = (value) => (value || '').replace(/s+/g, ' ').trim();
              const absolute = (value) => { try { return value ? new URL(value, location.href).href : ''; } catch { return ''; } };
              const unique = (values, max) => [...new Set(values.filter(Boolean))].slice(0, max);
              const nodeMeta = (node) => [
                typeof node?.className === 'string' ? node.className : node?.getAttribute?.('class') || '',
                node?.getAttribute?.('data-e2e') || '', node?.getAttribute?.('aria-label') || '', node?.getAttribute?.('title') || '',
              ].join(' ').toLowerCase();
              const exactMetric = (value) => {
                const compact = clean(value).replace(/,/g, '').replace(/s+/g, '');
                const match = compact.match(/^([0-9]+(?:.[0-9]+)?(?:w|k|万|亿)?)$/i);
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
                  const match = value.match(/(?:^|s)(?:(d{1,2}):)?([0-5]d):([0-5]d)(?:s|$)/);
                  if (!match) continue;
                  const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
                  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) return seconds;
                }
                return null;
              };
              const pinned = (root) => Array.from(root.querySelectorAll('[data-e2e*=pin], [class*=pin], [class*=Pin], [aria-label*=pinned], [title*=pinned]')).some((node) => /^(?:置顶|pinned)$/i.test(clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent)));
              const profileCardSelector = 'section.note-item, [class*=note-item], [class*=noteItem], [class*=note-card], [class*=NoteCard], [class*=feed-item], [class*=FeedItem], [data-e2e*=note-item], [data-note-id], [data-noteid]';
              const noteLinkSelector = 'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]';
              const roots = Array.from(new Set([
                ...Array.from(document.querySelectorAll(profileCardSelector)),
                ...Array.from(document.querySelectorAll(noteLinkSelector)).map((anchor) => anchor.closest(profileCardSelector) || anchor),
              ])).filter((root) => {
                const value = clean(root.innerText);
                return value.length >= 3 && value.length <= 1200;
              });
              const samples = [];
              const keys = new Set();
              for (const root of roots) {
                const anchor = root.matches(noteLinkSelector) ? root : root.querySelector(noteLinkSelector);
                const noteUrl = absolute(anchor?.getAttribute('href'));
                const text = clean(root.innerText).slice(0, 900);
                const title = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent);
                const key = noteUrl || [title, text.slice(0, 140)].filter(Boolean).join(' ');
                if (!key || keys.has(key)) continue;
                keys.add(key);
                const image = root.querySelector('img');
                const imageCount = Array.from(root.querySelectorAll('img')).filter((node) => !/(?:avatar|head|user|author|profile)/i.test(nodeMeta(node))).length;
                const isVideo = Boolean(root.querySelector('video')) || //video//i.test(noteUrl || '');
                const hashtags = unique(text.match(/#[^#s]{2,32}/g) || [], 12);
                const published = (text.match(/(?:20d{2}[.-/]d{1,2}[.-/]d{1,2}|(?:0?[1-9]|1[0-2])[.-/](?:0?[1-9]|[12]d|3[01]))(?!s*(?:w|k|万|亿))/i) || [''])[0];
                const commercial = [];
                if (/广告/i.test(text)) commercial.push('ad_disclosure');
                if (/(?:品牌合作|商业合作|paids+partnership)/i.test(text)) commercial.push('brand_collaboration');
                if (/(?:付费推广|sponsored)/i.test(text)) commercial.push('paid_promotion');
                samples.push({
                  note_url: noteUrl, title, body: text.slice(0, 600),
                  cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
                  content_type: isVideo ? 'video' : 'image_or_note',
                  content_format: isVideo ? 'video' : (imageCount >= 2 ? 'image_carousel' : (imageCount ? 'image_note' : null)),
                  content_image_count: imageCount, has_video: isVideo, hashtags,
                  topic_labels: hashtags.map((tag) => clean(tag).replace(/^[#＃]/, '')).filter(Boolean),
                  published_at: published || null, published_time_text: null,
                  duration_seconds: durationSeconds(root), is_pinned: pinned(root) ? true : null,
                  commercial_markers: commercial.length ? commercial : null,
                  statistics: {
                    like_count: cardMetric(root, ['赞', '点赞', 'like'], true),
                    collect_count: cardMetric(root, ['收藏', 'collect']),
                    comment_count: cardMetric(root, ['评论', 'comment']),
                    share_count: cardMetric(root, ['分享', 'share']),
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


def extract_visible_profile_samples(page, profile_sample_limit=PROFILE_SAMPLE_LIMIT):
    """Read complete, currently rendered public cards for virtual-list accumulation."""
    bounded_limit = max(1, min(int(profile_sample_limit or PROFILE_SAMPLE_LIMIT), MAX_PROFILE_SAMPLE_LIMIT))
    try:
        payload = page.evaluate(
            r"""({ profileSampleLimit }) => {
              const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
              const absolute = (value) => { try { return value ? new URL(value, location.href).href : ''; } catch { return ''; } };
              const unique = (values, max) => [...new Set(values.filter(Boolean))].slice(0, max);
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
              const canonicalContentUrl = (value) => {
                try {
                  const parsed = new URL(value, location.href);
                  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
                  const path = parsed.pathname.replace(/\/+$/, '');
                  if (parsed.protocol !== 'https:' || !/(?:^|\.)xiaohongshu\.com$/i.test(hostname)) return '';
                  if (!/^\/(?:explore|discovery\/item)\/[^/?#]+$/i.test(path)) return '';
                  return `https://${hostname}${path}`;
                } catch {
                  return '';
                }
              };
              const exactMetric = (value) => {
                const compact = clean(value).replace(/,/g, '').replace(/\s+/g, '');
                const match = compact.match(/^([0-9]+(?:\.[0-9]+)?(?:w|k|\u4e07|\u4ebf)?)$/i);
                return match ? match[1] : '';
              };
              const labeledMetricValue = (value, labels) => {
                const source = clean(value);
                for (const label of labels) {
                  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const number = '([0-9]+(?:\\.[0-9]+)?\\s*(?:w|k|\\u4e07|\\u4ebf)?)';
                  const after = source.match(new RegExp(`${escaped}\\s*[:\\uff1a]?\\s*${number}`, 'i'));
                  const before = source.match(new RegExp(`${number}\\s*${escaped}`, 'i'));
                  const match = after || before;
                  if (!match) continue;
                  const numeric = match[0].match(/([0-9]+(?:\.[0-9]+)?\s*(?:w|k|\u4e07|\u4ebf)?)/i);
                  const metric = numeric ? exactMetric(numeric[1]) : '';
                  if (metric) return metric;
                }
                return '';
              };
              const cardMetric = (root, labels, allowIconFallback = false) => {
                const normalizedLabels = labels.map((label) => label.toLowerCase());
                const nodes = Array.from(root.querySelectorAll(
                  'button, span, strong, em, b, i, [aria-label], [title], [data-e2e], [data-testid], [class]'
                )).slice(0, 900);
                for (const node of nodes) {
                  if (!visibleNode(node)) continue;
                  const value = clean(node.innerText || node.textContent);
                  if (!value || value.length > 180) continue;
                  const meta = nodeMeta(node);
                  const semantic = normalizedLabels.some((label) => meta.includes(label));
                  const labeledText = node.children.length <= 2
                    && normalizedLabels.some((label) => value.toLowerCase().includes(label));
                  if (!semantic && !labeledText) continue;
                  const direct = labeledText
                    ? labeledMetricValue(value, labels)
                    : (semantic ? (exactMetric(value) || labeledMetricValue(`${value} ${meta}`, labels)) : '');
                  if (direct) return direct;
                  if (!allowIconFallback) continue;
                  for (const child of Array.from(node.querySelectorAll(
                    'span, strong, em, b, i, [class*=count], [class*=Count], [data-e2e], [data-testid]'
                  )).slice(0, 80)) {
                    if (!visibleNode(child)) continue;
                    const childValue = exactMetric(child.textContent);
                    if (childValue) return childValue;
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
                  if (!visibleNode(node)) continue;
                  const value = clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent);
                  const match = value.match(/(?:^|\s)(?:(\d{1,2}):)?([0-5]\d):([0-5]\d)(?:\s|$)/);
                  if (!match) continue;
                  const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
                  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) return seconds;
                }
                return null;
              };
              const cardHasPinnedBadge = (root) => Array.from(root.querySelectorAll(
                '[data-e2e*=pin], [class*=pin], [class*=Pin], [aria-label*=pinned], [title*=pinned]'
              )).some((node) => /^(?:\u7f6e\u9876|pinned)$/i.test(clean(
                node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent
              )));
              const contentImageCount = (root) => Array.from(root.querySelectorAll('img')).filter(
                (node) => !/(?:avatar|head|user|author|profile)/i.test(nodeMeta(node))
              ).length;
              const contentFormat = (root, contentUrl, imageCount) => {
                const videoMarker = root.querySelector('video, [data-e2e*=duration], [data-e2e*=video-time], [class*=duration], [class*=Duration], [class*=video-time], [class*=VideoTime]');
                if (videoMarker || /\/video\//i.test(contentUrl || '')) return 'video';
                if (imageCount >= 2) return 'image_carousel';
                if (imageCount === 1 || /\/(?:explore|discovery\/item)\//i.test(contentUrl || '')) return 'image_note';
                return '';
              };
              const visiblePublishedAt = (sampleText) => {
                const dateMatch = sampleText.match(/(?:20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}|(?:0?[1-9]|1[0-2])[.\-/](?:0?[1-9]|[12]\d|3[01]))(?!\s*(?:w|k|\u4e07|\u4ebf))/i);
                const relativeMatch = sampleText.match(/(?:\u521a\u521a|\u6628\u5929|\u524d\u5929|\d+\s*(?:\u5206\u949f|\u5c0f\u65f6|\u5929)\u524d)/i);
                if (!dateMatch) return { value: '', time: relativeMatch ? relativeMatch[0] : '' };
                const date = dateMatch[0];
                const tail = sampleText.slice((dateMatch.index || 0) + date.length, (dateMatch.index || 0) + date.length + 18);
                const timeMatch = tail.match(/^(?:\s|T|\u4e0a\u5348|\u4e0b\u5348){0,12}((?:[01]?\d|2[0-3]):[0-5]\d)/i);
                const time = timeMatch ? timeMatch[1] : '';
                return { value: [date, time].filter(Boolean).join(' '), time: [date, time].filter(Boolean).join(' ') };
              };
              const explicitCommercialMarkers = (value) => {
                const source = clean(value);
                const markers = [
                  ['ad_disclosure', /\u5e7f\u544a/i],
                  ['brand_collaboration', /(?:\u54c1\u724c\u5408\u4f5c|\u5546\u4e1a\u5408\u4f5c|paid\s+partnership)/i],
                  ['paid_promotion', /(?:\u4ed8\u8d39\u63a8\u5e7f|sponsored)/i],
                  ['sponsorship', /\u8d5e\u52a9/i],
                ];
                return markers.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
              };
              const profileCardSelector = 'section.note-item, [class*=note-item], [class*=noteItem], [class*=note-card], [class*=NoteCard], [class*=feed-item], [class*=FeedItem], [data-e2e*=note-item], [data-note-id], [data-noteid]';
              const noteLinkSelector = 'a[href*="/explore/"], a[href*="/discovery/item/"]';
              const roots = Array.from(new Set([
                ...Array.from(document.querySelectorAll(profileCardSelector)),
                ...Array.from(document.querySelectorAll(noteLinkSelector)).map((anchor) => anchor.closest(profileCardSelector) || anchor),
              ])).filter((root) => {
                const value = clean(root.innerText);
                return visibleNode(root) && value.length >= 3 && value.length <= 1200;
              });
              const samples = [];
              const keys = new Set();
              for (const root of roots) {
                const anchor = root.matches(noteLinkSelector) ? root : root.querySelector(noteLinkSelector);
                const noteUrl = canonicalContentUrl(anchor?.getAttribute('href'));
                if (!noteUrl) continue;
                const text = clean(root.innerText).slice(0, 900);
                const title = clean(root.querySelector('h1, h2, h3, [class*=title], [class*=Title]')?.textContent);
                const key = noteUrl || [title, text.slice(0, 140)].filter(Boolean).join(' ');
                if (!key || keys.has(key)) continue;
                keys.add(key);
                const image = root.querySelector('img');
                const imageCount = Array.from(root.querySelectorAll('img')).filter((node) => {
                  const meta = (nodeMeta(node) + ' ' + (node.alt || '')).toLowerCase();
                  return !/(?:avatar|head|user|author|profile)/i.test(meta);
                }).length;
                const format = contentFormat(root, noteUrl, imageCount);
                const isVideo = format === 'video';
                const hashtags = unique(text.match(/#[^#\s]{2,32}/g) || [], 12);
                const published = visiblePublishedAt(text);
                const statistics = {
                  like_count: cardMetric(root, ['\u8d5e', '\u70b9\u8d5e', 'like'], true),
                  collect_count: cardMetric(root, ['\u6536\u85cf', 'collect']),
                  comment_count: cardMetric(root, ['\u8bc4\u8bba', 'comment']),
                  share_count: cardMetric(root, ['\u5206\u4eab', 'share']),
                };
                const commercialMarkers = explicitCommercialMarkers(text);
                samples.push({
                  note_url: noteUrl,
                  source_url: noteUrl,
                  content_id: noteUrl.split('/').pop() || '',
                  title,
                  body: text.slice(0, 600),
                  cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
                  content_type: isVideo ? 'video' : 'image_or_note',
                  content_format: format || null,
                  content_image_count: imageCount,
                  has_video: isVideo,
                  hashtags,
                  topic_labels: hashtags.map((tag) => tag.replace(/^[#\uff03]/, '')).filter(Boolean),
                  published_at: published.value || null,
                  published_time_text: published.time || null,
                  duration_seconds: cardDurationSeconds(root),
                  is_pinned: cardHasPinnedBadge(root) ? true : null,
                  commercial_markers: commercialMarkers.length ? commercialMarkers : null,
                  statistics,
                  captured_at: new Date().toISOString(),
                });
                if (samples.length >= profileSampleLimit) break;
              }
              return { samples, renderedCardCount: roots.length, sourceProfileUrl: location.href };
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
        "samples": normalize_profile_card_samples(samples, payload.get("sourceProfileUrl") or ""),
        "rendered_card_count": int(rendered) if isinstance(rendered, (int, float)) and rendered >= 0 else 0,
    }


def warm_profile_content(page, profile_sample_limit=PROFILE_SAMPLE_LIMIT, progress_callback=None):
    """Load currently visible public profile cards by normal scrolling."""
    accumulated_samples = []
    accumulated_positions = {}
    initial_snapshot = extract_visible_profile_samples(page, profile_sample_limit)
    merge_profile_samples_into(
        accumulated_samples,
        accumulated_positions,
        initial_snapshot["samples"],
        limit=profile_sample_limit,
    )
    previous_rendered_count = initial_snapshot["rendered_card_count"]
    idle_rounds = 0
    scrolls = 0
    stop_reason = "scroll_budget_reached"
    last_scroll_control_succeeded = None
    idle_scroll_limit = profile_idle_scroll_limit(profile_sample_limit)
    terminal_end_evidence = None
    progress_sample_interval = max(25, (max(1, int(profile_sample_limit)) + 49) // 50)
    last_progress_sample_count = 0
    last_progress_scrolls = 0

    def report_profile_progress(force=False):
        nonlocal last_progress_sample_count, last_progress_scrolls
        visible = len(accumulated_samples)
        if not callable(progress_callback):
            return
        if not force and (
            visible < last_progress_sample_count + progress_sample_interval
            and scrolls < last_progress_scrolls + 100
        ):
            return
        progress_callback({
            "scrolls": scrolls,
            "scroll_budget": profile_scroll_budget(profile_sample_limit),
            "visible": visible,
            "idle_rounds": idle_rounds,
        })
        last_progress_sample_count = visible
        last_progress_scrolls = scrolls
    if len(accumulated_samples) >= profile_sample_limit:
        stop_reason = "sample_limit_reached"
    for _ in range(profile_scroll_budget(profile_sample_limit)):
        if stop_reason == "sample_limit_reached":
            break
        previous_surface_state = profile_content_surface_state(page)
        try:
            page.mouse.wheel(0, 1800)
            last_scroll_control_succeeded = True
        except Exception:
            last_scroll_control_succeeded = False
            stop_reason = "scroll_control_unavailable"
            break
        scrolls += 1
        latest_surface_state, access_state = wait_for_profile_content_update(page, previous_surface_state)
        if access_state:
            stop_reason = f"{access_state}_retryable"
            break
        snapshot = extract_visible_profile_samples(page, profile_sample_limit)
        before_count = len(accumulated_samples)
        merge_profile_samples_into(
            accumulated_samples,
            accumulated_positions,
            snapshot["samples"],
            limit=profile_sample_limit,
        )
        report_profile_progress()
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
            report_profile_progress()
            if idle_rounds >= idle_scroll_limit:
                terminal_end_evidence = {
                    "at_bottom": bool(latest_surface_state.get("at_bottom")) if isinstance(latest_surface_state, dict) else False,
                    "terminal_marker": str(latest_surface_state.get("terminal_marker") or "") if isinstance(latest_surface_state, dict) else "",
                }
                stop_reason = (
                    "page_exhausted"
                    if profile_surface_end_reached(latest_surface_state)
                    else "public_profile_settled_retryable"
                )
                break
    report_profile_progress(force=True)
    return {
        "scrolls": scrolls,
        "stop_reason": stop_reason,
        "observed_card_count": len(accumulated_samples),
        "last_visible_card_count": previous_rendered_count,
        "idle_rounds": idle_rounds,
        "idle_scroll_limit": idle_scroll_limit,
        "last_scroll_control_succeeded": last_scroll_control_succeeded,
        "terminal_end_evidence": terminal_end_evidence,
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
              const meta = nodeMeta(node);
              const semantic = normalizedLabels.some((label) => meta.includes(label));
              const labeledText = node.children.length <= 2
                && normalizedLabels.some((label) => text.toLowerCase().includes(label));
              if (!semantic && !labeledText) continue;
              // A content title can contain a word such as "分享". Only use a value when
              // it is adjacent to the interaction label, or is the labeled control itself.
              const direct = labeledText
                ? labeledMetricValue(text, labels)
                : (semantic ? (exactMetric(text) || labeledMetricValue(`${text} ${meta}`, labels)) : '');
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
          const body = clean(document.body?.innerText).slice(0, 3200);
          const title = clean(document.title);
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
            if (imageCount === 1 || /\\/(?:explore|search_result|discovery\\/item)\\//i.test(contentUrl || '')) return 'image_note';
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
            '[data-e2e*=desc]', '[class*=desc]', '[class*=Desc]', '[class*=bio]', '[class*=Bio]', '[class*=introduc]',
          ]);
          const metricPattern = /(?:\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u83b7\\u8d5e|\\u8d5e\\u4e0e\\u6536\\u85cf|\\u7b14\\u8bb0|\\u4f5c\\u54c1|followers?|following|likes?|posts?)/i;
          const headerMetricLabels = /(?:\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u83b7\\u8d5e|\\u8d5e\\u4e0e\\u6536\\u85cf|\\u7b14\\u8bb0|\\u4f5c\\u54c1|followers?|following|likes?|posts?)/gi;
          const profileHeaderRoot = (() => {
            const selectors = [
              '[data-e2e*=user-detail]', '[data-e2e*=user-info]', '[data-e2e*=user-page]', '[data-e2e*=profile]',
              '[class*=user-detail]', '[class*=UserDetail]', '[class*=user-info]', '[class*=UserInfo]',
              '[class*=profile-header]', '[class*=ProfileHeader]', '[class*=profile-info]', '[class*=ProfileInfo]',
            ].join(', ');
            const isHeader = (node) => {
              const value = clean(node?.innerText);
              return Boolean(author && value.includes(author) && value.length <= 1600
                && (value.match(headerMetricLabels) || []).length >= 2);
            };
            const matched = Array.from(document.querySelectorAll(selectors)).find(isHeader);
            if (matched) return matched;
            let node = authorNode;
            for (let depth = 0; node && node !== document.body && depth < 7; depth += 1, node = node.parentElement) {
              if (isHeader(node)) return node;
            }
            return null;
          })();
          const profileHeaderText = profileHeaderRoot
            ? unique([...textNodes(profileHeaderRoot, 480), clean(profileHeaderRoot.innerText)], 100)
            : [];
          // Pull compact counter pairs only. Full-page text can combine profile data with shell navigation.
          const metricPairPattern = /(\\u83b7\\u8d5e\\u4e0e\\u6536\\u85cf|\\u83b7\\u8d5e|\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u7b14\\u8bb0|\\u4f5c\\u54c1|followers?|following|likes?|posts?)\\s*[:\\uff1a]?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?\\s*(?:w|k|\\u4e07|\\u4ebf)?\\+?)|([0-9][0-9,]*(?:\\.[0-9]+)?\\s*(?:w|k|\\u4e07|\\u4ebf)?\\+?)\\s*(\\u83b7\\u8d5e\\u4e0e\\u6536\\u85cf|\\u83b7\\u8d5e|\\u7c89\\u4e1d|\\u5173\\u6ce8|\\u7b14\\u8bb0|\\u4f5c\\u54c1|followers?|following|likes?|posts?)/gi;
          const metricKey = (label) => {
            const normalized = clean(label).toLowerCase();
            if (/^(?:\\u7c89\\u4e1d|followers?)$/i.test(normalized)) return 'followers';
            if (/^(?:\\u5173\\u6ce8|following)$/i.test(normalized)) return 'following';
            if (/^(?:\\u83b7\\u8d5e\\u4e0e\\u6536\\u85cf|\\u83b7\\u8d5e|likes?)$/i.test(normalized)) return 'likes';
            if (/^(?:\\u7b14\\u8bb0|\\u4f5c\\u54c1|posts?)$/i.test(normalized)) return 'works';
            return '';
          };
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
            '[data-e2e*=red-id]', '[class*=red-id]', '[class*=redId]', '[class*=user-id]', '[class*=userId]', '[class*=account-id]',
          ]) || labeled([/(?:\\u5c0f\\u7ea2\\u4e66\\u53f7|RED\\s*ID|ID\\s*[:\\uff1a])/i]);
          const tags = unique(
            Array.from(document.querySelectorAll('[class*=tag], [class*=Tag], [class*=badge], [class*=Badge], a[href*=topic], a[href*=search_result]'))
              .map((node) => clean(node.textContent))
              .filter((value) => value && value.length <= 48 && !metricPattern.test(value)),
            12,
          );
          const profileTags = unique(
            Array.from(profileHeaderRoot?.querySelectorAll(
              '[data-e2e*=tag], [data-e2e*=badge], [class*=tag], [class*=Tag], [class*=badge], [class*=Badge], a[href*=topic], a[href*=search_result]'
            ) || [])
              .map((node) => clean(node.textContent))
              .filter((value) => value && value.length <= 48 && value !== author && value !== handle
                && !metricPattern.test(value)),
            12,
          );
          const audiencePattern = /(?:\\u7c89\\u4e1d(?:\\u7fa4|\\u56e2|\\u724c)|\\u7c89\\u4e1d\\u6807\\u7b7e|fans?\\s*(?:group|club))/i;
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
            if (/^(?:\\u7c89\\u4e1d\\u7fa4|\\u7c89\\u4e1d\\u56e2|\\u7c89\\u4e1d\\u724c|\\u7c89\\u4e1d\\u6807\\u7b7e|fans?\\s*(?:group|club))$/i.test(normalized)) return '';
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
            'section.note-item', '[class*=note-item]', '[class*=noteItem]', '[class*=note-card]', '[class*=NoteCard]',
            '[class*=feed-item]', '[class*=FeedItem]', '[data-e2e*=note-item]', '[data-note-id]', '[data-noteid]',
          ].join(', ');
          const noteLinkSelector = 'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]';
          const sampleRoots = Array.from(new Set([
            ...Array.from(document.querySelectorAll(profileCardSelector)),
            ...Array.from(document.querySelectorAll(noteLinkSelector)).map((anchor) =>
              anchor.closest(profileCardSelector) || anchor
            ),
          ])).filter((root) => {
            const text = clean(root.innerText);
            return text.length >= 3 && text.length <= 1200;
          });
          const latestSamples = [];
          const sampleKeys = new Set();
          for (const root of sampleRoots) {
            const noteAnchor = root.matches(noteLinkSelector) ? root : root.querySelector(noteLinkSelector);
            const noteUrl = absolute(noteAnchor?.getAttribute('href'));
            const image = root.querySelector('img');
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
              like_count: cardMetric(root, ['\\u8d5e', '\\u70b9\\u8d5e', 'like'], true),
              collect_count: cardMetric(root, ['\\u6536\\u85cf', 'collect']),
              comment_count: cardMetric(root, ['\\u8bc4\\u8bba', 'comment']),
              share_count: cardMetric(root, ['\\u5206\\u4eab', 'share']),
            };
            const publishedAt = (sampleText.match(/(?:20\\d{2}[.\\-/]\\d{1,2}[.\\-/]\\d{1,2}|(?:0?[1-9]|1[0-2])[.\\-/](?:0?[1-9]|[12]\\d|3[01]))(?!\\s*(?:w|k|\\u4e07|\\u4ebf))/i) || [''])[0];
            const commercialMarkers = explicitCommercialMarkers(sampleText);
            latestSamples.push({
              note_url: noteUrl,
              title: sampleTitle,
              body: sampleText.slice(0, 600),
              cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
              content_type: root.querySelector('video') ? 'video' : 'image_or_note',
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
            for (const key of ['like_count', 'collect_count', 'comment_count', 'share_count']) {
              const value = numericMetric(sample.statistics[key]);
              if (value === null) continue;
              totals.values[key] += value;
              totals.observed[key] += 1;
            }
            return totals;
          }, {
            values: { like_count: 0, collect_count: 0, comment_count: 0, share_count: 0 },
            observed: { like_count: 0, collect_count: 0, comment_count: 0, share_count: 0 },
          });
          for (const key of Object.keys(sampleTotals.values)) {
            if (!sampleTotals.observed[key]) sampleTotals.values[key] = '';
          }
          const image = document.querySelector('img');
          return [{
            author: author,
            observed_name: author,
            expected_name: expectedName,
            profile_identity_extracted: Boolean(author),
            author_profile: location.href,
            note_url: '',
            title,
            body,
            bio,
            handle,
            location: profileLocation,
            verified,
            verified_label: verifiedLabel,
            followers: metrics.followers,
            follower_count: metrics.followers,
            following_count: metrics.following,
            like_count: metrics.likes,
            work_count: metrics.works,
            avatar_url: absolute(image?.currentSrc || image?.getAttribute('src')),
            tags: tags.join(' | '),
            profile_tags: profileTags.length ? profileTags : null,
            card_cover_url: absolute(image?.currentSrc || image?.getAttribute('src')),
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
              bio,
              location: profileLocation,
              verified,
              verified_label: verifiedLabel,
              avatar: absolute(image?.currentSrc || image?.getAttribute('src')),
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
    return enrich_profile_records(normalize_profile_capture_records(records))


def normalized_profile_name(value):
    return re.sub(r"\s+", "", str(value or "")).casefold()


def profile_capture_identity_confirmed(record, expected_name=""):
    """Accept an early header snapshot only when its visible profile identity matches."""
    if not isinstance(record, dict):
        return False
    observed_name = normalized_profile_name(record.get("observed_name") or record.get("author"))
    expected = normalized_profile_name(expected_name or record.get("expected_name"))
    if not observed_name:
        return False
    if expected:
        return observed_name == expected
    return bool(record.get("profile_identity_extracted") and record.get("author_profile"))


def merge_profile_captures(header_records, content_records, accumulated_samples=None, profile_sample_limit=PROFILE_SAMPLE_LIMIT):
    """Combine the early complete header with all normally observed content cards."""
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
            "author", "observed_name", "profile_identity_extracted", "bio", "handle", "location",
            "verified", "verified_label", "followers", "follower_count", "following_count",
            "like_count", "work_count", "avatar_url", "card_cover_url",
        ):
            if observed_public_value(header.get(field)):
                merged[field] = header[field]

        header_profile = header.get("profile") if isinstance(header.get("profile"), dict) else {}
        content_profile = merged.get("profile") if isinstance(merged.get("profile"), dict) else {}
        merged_profile = dict(content_profile)
        for field in (
            "nickname", "handle", "bio", "location", "verified", "verified_label", "avatar",
            "tags", "profile_tags", "visible_metrics", "public_audience_signals",
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
        header.get("profile", {}).get("latest_samples")
        if isinstance(header, dict) and isinstance(header.get("profile"), dict) else [],
        content.get("latest_samples") if isinstance(content, dict) else [],
        content.get("profile", {}).get("latest_samples")
        if isinstance(content, dict) and isinstance(content.get("profile"), dict) else [],
        limit=profile_sample_limit,
    )
    merged["latest_samples"] = merged_samples
    merged_profile["latest_samples"] = merged_samples
    merged["profile"] = merged_profile
    remaining = content_records[1:] if content_records else []
    return enrich_profile_records([merged, *remaining])


def main():
    parser = argparse.ArgumentParser(description="Collect Xiaohongshu public cards from an attached browser session.")
    parser.add_argument("--search-url", default="")
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
    parser.add_argument("--max-scrolls", type=int, default=0, help="0 derives a bounded scroll budget from --limit.")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    if not args.search_url and not args.profile_url:
        parser.error("one of --search-url or --profile-url is required")

    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "xiaohongshu_notes_latest.json"
    summary_path = output_dir / "xiaohongshu_collection_summary.json"
    target_url = args.profile_url or args.search_url
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
                page.goto(target_url, wait_until="domcontentloaded", timeout=120000)
                if has_verification_wall(page):
                    summary = blocked_collection_summary(
                        "profile" if args.profile_url else "search",
                        "verification",
                        args.limit,
                        page.url,
                    )
                    summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                    print("Xiaohongshu requires platform security verification in the attached browser profile.")
                    return 4
                if has_login_wall(page):
                    summary = blocked_collection_summary(
                        "profile" if args.profile_url else "search",
                        "login",
                        args.limit,
                        page.url,
                    )
                    summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                    print("Xiaohongshu login is required in the attached browser profile.")
                    return 2
                if args.profile_url:
                    def emit_profile_progress(progress):
                        print(
                            "PROFILE_PROGRESS "
                            f"scrolls={progress['scrolls']}/{progress['scroll_budget']} "
                            f"visible={progress['visible']} phase=grid idle={progress['idle_rounds']}",
                            file=sys.stderr,
                            flush=True,
                        )

                    wait_for_profile_cards(page)
                    if has_verification_wall(page):
                        summary = blocked_collection_summary("profile", "verification", args.limit, page.url)
                        summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                        print("Xiaohongshu requires platform security verification in the attached browser profile.")
                        return 4
                    header_records = extract_profile(page, args.expected_name, profile_sample_limit)
                    profile_scroll_state = warm_profile_content(
                        page,
                        profile_sample_limit,
                        progress_callback=emit_profile_progress,
                    )
                    if has_verification_wall(page):
                        summary = blocked_collection_summary("profile", "verification", args.limit, page.url)
                        summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                        print("Xiaohongshu requires platform security verification in the attached browser profile.")
                        return 4
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
                    summary = {
                        "mode": "profile",
                        "requested_limit": args.limit,
                        "effective_limit": 1,
                        "raw_candidate_cards": len(records),
                        "unique_creators": len(records),
                        "returned_creators": len(records),
                        "search_passes": 0,
                        "scrolls_performed": profile_scroll_state["scrolls"],
                        "scroll_budget": profile_scroll_budget(profile_sample_limit),
                        "idle_scroll_limit": profile_idle_scroll_limit(profile_sample_limit),
                        "content_sample_limit": profile_sample_limit,
                        "observed_profile_card_count": profile_scroll_state["observed_card_count"],
                        "last_visible_profile_card_count": profile_scroll_state["last_visible_card_count"],
                        "stop_reason": profile_scroll_state["stop_reason"],
                        "cumulative_public_page_cards": merged_sample_count,
                        "cumulative_unique_accounts": len(records),
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
                            "terminal_end_evidence": profile_scroll_state["terminal_end_evidence"],
                        },
                        "public_data_scope": "profile_and_visible_content",
                    }
                else:
                    wait_for_search_cards(page)
                    if has_verification_wall(page):
                        summary = blocked_collection_summary("search", "verification", args.limit, page.url)
                        summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                        print("Xiaohongshu requires platform security verification in the attached browser profile.")
                        return 4
                    if has_login_wall(page):
                        summary = blocked_collection_summary("search", "login", args.limit, page.url)
                        summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                        print("Xiaohongshu login is required in the attached browser profile.")
                        return 2
                    records, summary = collect_search_cards(page, args.limit, max(0, args.max_scrolls))
                    records = enrich_profile_records(records)
                output_path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
                summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                print(
                    "Collected "
                    f"{summary['returned_creators']} unique Xiaohongshu creators from "
                    f"{summary['raw_candidate_cards']} source cards; "
                    f"stop_reason={summary['stop_reason']}; "
                    f"scrolls={summary['scrolls_performed']}/{summary['scroll_budget']}"
                )
                return 0 if records else 1
            finally:
                page.close()
    except Exception as error:
        print(f"Xiaohongshu relay collection failed: {error}")
        return 3


if __name__ == "__main__":
    sys.exit(main())
