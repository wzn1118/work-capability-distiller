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
from urllib.parse import quote

from playwright.sync_api import sync_playwright

from public_profile_fields import enrich_profile_records


# Public discovery remains bounded even when the per-channel volume is high.
# The usual product flow shards the channel target across query routes.
MAX_SEARCH_RESULTS = 10_000
MAX_SEARCH_SCROLLS = 1_800
MAX_IDLE_SCROLLS = 8
PROFILE_SAMPLE_LIMIT = 12
MAX_PROFILE_SAMPLE_LIMIT = 120
PROFILE_MAX_SCROLLS = 48

LOGIN_MARKERS = (
    "\u767b\u5f55\u540e\u89c2\u770b",
    "\u8bf7\u5148\u767b\u5f55",
    "\u7acb\u5373\u767b\u5f55",
    "\u626b\u7801\u767b\u5f55",
    "\u5e10\u53f7\u767b\u5f55",
)

VERIFICATION_MARKERS = (
    "\u5b89\u5168\u9a8c\u8bc1",
    "\u6ed1\u52a8\u9a8c\u8bc1",
    "\u4eba\u673a\u9a8c\u8bc1",
    "\u8bf7\u5b8c\u6210\u9a8c\u8bc1",
    "\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41",
    "\u7f51\u7edc\u73af\u5883\u5f02\u5e38",
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
        body = page.locator("body").inner_text(timeout=3000)[:8000]
    except Exception:
        return ""
    if any(marker in body for marker in VERIFICATION_MARKERS):
        return "verification"
    if any(marker in body for marker in LOGIN_MARKERS):
        return "login"
    return ""


def canonical_profile_url(value):
    match = re.search(r"(?:space\.)?bilibili\.com/(\d+)", str(value or ""), re.IGNORECASE)
    return f"https://space.bilibili.com/{match.group(1)}" if match else ""


def search_url(template, query):
    return str(template or "").replace("{query}", quote(str(query or ""), safe=""))


def visible_candidates(page, maximum):
    return page.evaluate(
        """(limit) => {
          const compact = (value, maximum = 600) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, maximum);
          const profile = (href) => {
            try {
              const url = new URL(href, location.href);
              const match = url.hostname.endsWith('bilibili.com') && url.pathname.match(/^\\/(\\d+)\\/?$/);
              return match ? `https://space.bilibili.com/${match[1]}` : '';
            } catch { return ''; }
          };
          const results = [];
          const seen = new Set();
          for (const anchor of [...document.querySelectorAll('a[href*="space.bilibili.com/"]')]) {
            const sourceProfileUrl = profile(anchor.href);
            if (!sourceProfileUrl || seen.has(sourceProfileUrl)) continue;
            let card = anchor;
            for (let index = 0; index < 5 && card?.parentElement; index += 1) card = card.parentElement;
            const cardText = compact(card?.innerText, 1200);
            const image = card?.querySelector('img') || anchor.querySelector('img');
            const name = compact(anchor.innerText || anchor.getAttribute('title') || card?.querySelector('[title]')?.getAttribute('title'), 120);
            seen.add(sourceProfileUrl);
            results.push({
              source_profile_url: sourceProfileUrl,
              author_profile: sourceProfileUrl,
              owner: {
                mid: sourceProfileUrl.split('/').pop(),
                name,
                face: image?.currentSrc || image?.src || '',
              },
              title: compact(cardText.split('\\n')[0], 300),
              body: cardText,
              cover_url: image?.currentSrc || image?.src || '',
              content_type: 'creator_card',
              scraped_at: new Date().toISOString(),
            });
            if (results.length >= limit) break;
          }
          return results;
        }""",
        maximum,
    )


def extract_profile(page, profile_url, expected_name, sample_limit):
    payload = page.evaluate(
        """({ profileUrl, expectedName, sampleLimit }) => {
          const compact = (value, maximum = 600) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, maximum);
          const body = compact(document.body?.innerText, 16000);
          const firstText = (selectors, maximum = 300) => {
            for (const selector of selectors) {
              const node = document.querySelector(selector);
              const value = compact(node?.innerText || node?.textContent || node?.getAttribute?.('title'), maximum);
              if (value) return value;
            }
            return '';
          };
          const firstImage = (selectors) => {
            for (const selector of selectors) {
              const node = document.querySelector(selector);
              const value = compact(node?.currentSrc || node?.src, 1600);
              if (value) return value;
            }
            return '';
          };
          const metric = (labels) => {
            for (const label of labels) {
              const match = body.match(new RegExp(`${label}\\\\s*([0-9,.]+(?:\\\\u4e07|\\\\u4ebf|w|W)?)`, 'i'));
              if (match) return match[1];
            }
            return '';
          };
          const samples = [];
          const seen = new Set();
          for (const anchor of [...document.querySelectorAll('a[href*="/video/"]')]) {
            let sourceUrl = '';
            try {
              const url = new URL(anchor.href, location.href);
              if (url.protocol === 'https:' && url.hostname.endsWith('bilibili.com') && /\\/video\\//.test(url.pathname)) {
                sourceUrl = `https://${url.host}${url.pathname}`;
              }
            } catch { continue; }
            if (!sourceUrl || seen.has(sourceUrl)) continue;
            let card = anchor;
            for (let index = 0; index < 4 && card?.parentElement; index += 1) card = card.parentElement;
            const cardText = compact(card?.innerText, 1600);
            const title = compact(anchor.getAttribute('title') || anchor.innerText || cardText.split('\\n')[0], 300);
            const image = card?.querySelector('img') || anchor.querySelector('img');
            seen.add(sourceUrl);
            samples.push({
              source_url: sourceUrl,
              note_url: sourceUrl,
              title,
              body: cardText,
              detail_text: cardText,
              cover_url: image?.currentSrc || image?.src || '',
              content_type: 'video',
              content_format: 'video',
              has_video: true,
              scraped_at: new Date().toISOString(),
            });
            if (samples.length >= sampleLimit) break;
          }
          const mid = (profileUrl.match(/\\/(\\d+)\\/?$/) || [])[1] || '';
          const name = firstText([
            '#h-name', '.h-name', '.upinfo-detail__name', '[class*="name"] h1', 'h1',
          ], 120) || compact(expectedName, 120);
          const bio = firstText([
            '.h-sign', '.upinfo-detail__desc', '[class*="desc"]', '[class*="sign"]',
          ], 600);
          const avatar = firstImage([
            '.h-avatar img', '.upinfo-detail__avatar img', '[class*="avatar"] img',
          ]);
          return {
            source_profile_url: profileUrl,
            author_profile: profileUrl,
            owner: { mid, name, face: avatar },
            profile: {
              nickname: name,
              bio,
              avatar,
              metrics: {
                followers: metric(['\\\\u7c89\\\\u4e1d', 'followers']),
                following: metric(['\\\\u5173\\\\u6ce8', 'following']),
                works: metric(['\\\\u89c6\\\\u9891', '\\\\u6295\\\\u7a3f', 'videos']),
              },
              latest_samples: samples,
            },
            name,
            bio,
            avatar_url: avatar,
            follower_count: metric(['\\\\u7c89\\\\u4e1d', 'followers']),
            following_count: metric(['\\\\u5173\\\\u6ce8', 'following']),
            work_count: metric(['\\\\u89c6\\\\u9891', '\\\\u6295\\\\u7a3f', 'videos']),
            latest_samples: samples,
            content_summary: {
              visible_sample_count: samples.length,
              sampled_from_public_profile: true,
            },
            scraped_at: new Date().toISOString(),
          };
        }""",
        {"profileUrl": profile_url, "expectedName": expected_name, "sampleLimit": sample_limit},
    )
    return enrich_profile_records([payload]) if isinstance(payload, dict) else []


def collect_search(page, limit):
    records = []
    seen = set()
    idle_scrolls = 0
    max_scrolls = max(8, min(MAX_SEARCH_SCROLLS, (limit + 4) // 5 + 8))
    stop_reason = "scroll_cap_reached"
    for _ in range(max_scrolls):
        state = page_access_state(page)
        if state:
            stop_reason = f"platform_{state}_required"
            break
        candidates = visible_candidates(page, limit)
        before = len(records)
        for record in candidates:
            source_profile_url = canonical_profile_url(record.get("source_profile_url"))
            if not source_profile_url or source_profile_url in seen:
                continue
            seen.add(source_profile_url)
            record["source_profile_url"] = source_profile_url
            record["author_profile"] = source_profile_url
            records.append(record)
            if len(records) >= limit:
                stop_reason = "requested_limit_reached"
                break
        if len(records) >= limit:
            break
        try:
            page.mouse.wheel(0, 920)
            page.wait_for_timeout(900)
        except Exception:
            stop_reason = "scroll_failed"
            break
        idle_scrolls = idle_scrolls + 1 if len(records) == before else 0
        if idle_scrolls >= MAX_IDLE_SCROLLS:
            stop_reason = "no_new_visible_creator_cards"
            break
    return enrich_profile_records(records), {
        "mode": "search",
        "requested_limit": limit,
        "raw_candidate_cards": len(records),
        "unique_creators": len(records),
        "returned_creators": len(records),
        "scroll_budget": max_scrolls,
        "stop_reason": stop_reason,
        "public_data_scope": "visible_creator_cards",
    }


def main():
    parser = argparse.ArgumentParser(description="Collect Bilibili public creator cards from an attached browser session.")
    parser.add_argument("--query", default="")
    parser.add_argument("--profile-url", default="")
    parser.add_argument("--expected-name", default="")
    parser.add_argument("--search-url-template", default="https://search.bilibili.com/upuser?keyword={query}")
    parser.add_argument("--profile-sample-limit", type=int, default=PROFILE_SAMPLE_LIMIT)
    parser.add_argument("--relay-port", type=int, default=18800)
    parser.add_argument("--limit", type=int, default=MAX_SEARCH_RESULTS)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    if not args.query and not args.profile_url:
        parser.error("one of --query or --profile-url is required")
    profile_url = canonical_profile_url(args.profile_url)
    if args.profile_url and not profile_url:
        parser.error("--profile-url must be a Bilibili space profile URL")
    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "bilibili_creators_latest.json"
    summary_path = output_dir / "bilibili_collection_status.json"
    target_url = profile_url or search_url(args.search_url_template, args.query)
    limit = max(1, min(int(args.limit or MAX_SEARCH_RESULTS), MAX_SEARCH_RESULTS))
    sample_limit = max(1, min(int(args.profile_sample_limit or PROFILE_SAMPLE_LIMIT), MAX_PROFILE_SAMPLE_LIMIT))
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(
                f"http://127.0.0.1:{args.relay_port}",
                headers=relay_headers(args.relay_port),
                timeout=120000,
            )
            if not browser.contexts:
                raise RuntimeError("The attached browser has no reusable context.")
            page = browser.contexts[0].new_page()
            try:
                page.goto(target_url, wait_until="domcontentloaded", timeout=120000)
                page.wait_for_timeout(1600)
                state = page_access_state(page)
                if state == "verification":
                    print("Bilibili requires platform verification in the attached browser profile.")
                    return 4
                if state == "login":
                    print("Bilibili login is required in the attached browser profile.")
                    return 2
                if profile_url:
                    for _ in range(PROFILE_MAX_SCROLLS):
                        page.mouse.wheel(0, 920)
                        page.wait_for_timeout(450)
                    records = extract_profile(page, profile_url, args.expected_name, sample_limit)
                    summary = {
                        "mode": "profile",
                        "requested_limit": limit,
                        "raw_candidate_cards": len(records),
                        "unique_creators": len(records),
                        "returned_creators": len(records),
                        "content_sample_limit": sample_limit,
                        "stop_reason": "profile_read",
                        "public_data_scope": "profile_and_visible_content",
                    }
                else:
                    records, summary = collect_search(page, limit)
                    summary["source_search_url"] = target_url
                summary["collected_at"] = datetime.now().isoformat(timespec="seconds")
                output_path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
                summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"Collected {len(records)} Bilibili public creator records; stop_reason={summary['stop_reason']}")
                return 0 if records else 1
            finally:
                page.close()
    except Exception as error:
        print(f"Bilibili relay collection failed: {error}")
        return 3


if __name__ == "__main__":
    sys.exit(main())
