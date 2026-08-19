#!/usr/bin/env python3
"""Independent integrity, privacy, and browser validation for the 98-dimension report."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
OUT = ROOT / "output" / "wuhu-mkt-multidimensional-audience-20260814"
REPORT = OUT / "三国杀WUHU联盟卡宝98维受众统计深度洞察报告.html"
ANALYSIS = OUT / "wuhu-mkt-multidimensional-analysis.json"
PROFILES = OUT / "wuhu-mkt-multidimensional-anonymous-profiles.csv"
METRICS = OUT / "wuhu-mkt-multidimensional-metric-dictionary.csv"
VIDEOS = OUT / "wuhu-mkt-multidimensional-video-statistics.csv"
METHODS = OUT / "多维受众统计方法与口径.md"
VERIFICATION = OUT / "verification.json"
MANIFEST = OUT / "artifact-manifest.json"

SOURCE_ALL_COMMENTS = Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\all-comments.csv")
SOURCE_VIDEOS = Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\videos-summary.csv")
SOURCE_CODED = ROOT / "output" / "wuhu-grounded-player-context-20260813" / "wuhu-grounded-coded-comments.csv"
ANALYZER = ROOT / "scripts" / "analyze-wuhu-mkt-multidimensional.py"
GENERATOR = ROOT / "scripts" / "generate-wuhu-mkt-multidimensional-report.mjs"
SELF = Path(__file__).resolve()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


checks: list[dict[str, Any]] = []


def check(name: str, condition: bool, detail: str) -> None:
    checks.append({"name": name, "passed": bool(condition), "detail": detail})


def number(value: Any) -> float:
    return float(value)


def sum_rows(rows: list[dict[str, Any]], field: str) -> int:
    return sum(int(row[field]) for row in rows)


def static_validation(data: dict[str, Any], html: str) -> dict[str, Any]:
    for path in [REPORT, ANALYSIS, PROFILES, METRICS, VIDEOS, METHODS, ANALYZER, GENERATOR, SELF]:
        check(f"exists:{path.name}", path.exists(), str(path))

    check("report-size", REPORT.stat().st_size >= 80_000, f"{REPORT.stat().st_size} bytes")
    check("html-utf8", "\ufffd" not in html, "No replacement characters")
    check("html-no-mojibake-markers", not re.search(r"锟|鈥|锛", html), "No common mojibake markers")
    check("offline-no-external-script", not re.search(r"<script[^>]+src=", html, re.I), "No external script tag")
    check("offline-no-external-link", not re.search(r"(?:src|href)=[\"']https?://", html, re.I), "No HTTP(S) dependency")
    check("metric-dimension-count", data["scope"]["metricDimensions"] == 98, str(data["scope"]["metricDimensions"]))
    check("metric-object-count", len(data["metrics"]) == 98, str(len(data["metrics"])))
    metric_ids = [item["指标ID"] for item in data["metrics"]]
    check("metric-id-unique", len(metric_ids) == len(set(metric_ids)) == 98, f"{len(set(metric_ids))}/98 unique")
    check("method-count", data["scope"]["statisticalMethodCount"] == 34, str(data["scope"]["statisticalMethodCount"]))
    check("semantic-code-count", len(data["semanticCodes"]) == 34, str(len(data["semanticCodes"])))

    section_ids = set(re.findall(r'id=[\"\'](part-\d+)[\"\']', html))
    nav_targets = re.findall(r'href=[\"\']#(part-\d+)[\"\']', html)
    check("section-count", len(section_ids) == 13, f"{len(section_ids)} unique part ids")
    check("nav-targets", len(nav_targets) == 13 and all(target in section_ids for target in nav_targets), f"{len(nav_targets)} links")
    html_metric_rows = len(re.findall(r"<tr[^>]*data-module=", html, re.I))
    check("html-metric-rows", html_metric_rows == 98, f"{html_metric_rows}/98 rows")

    coverage = data["coverage"]
    expected_coverage = {
        "videos": 107,
        "commentBearingVideos": 106,
        "capturedComments": 16_796,
        "declaredComments": 17_021,
        "audienceComments": 14_715,
        "audienceUsers": 5_410,
        "audienceTextComments": 13_320,
        "audienceTextUsers": 4_990,
    }
    for key, expected in expected_coverage.items():
        check(f"coverage:{key}", coverage[key] == expected, f"{coverage[key]} expected {expected}")

    lifecycle_users = sum_rows(data["lifecycleSegments"], "用户数")
    context_users = sum_rows(data["contextLevels"], "用户数")
    strict_cute_users = sum_rows(data["strictCuteSegments"], "用户数")
    check("lifecycle-partition", lifecycle_users == coverage["audienceUsers"], f"{lifecycle_users}/{coverage['audienceUsers']}")
    check("context-partition", context_users == coverage["audienceTextUsers"], f"{context_users}/{coverage['audienceTextUsers']}")
    check("strict-cute-partition", strict_cute_users == coverage["audienceTextUsers"], f"{strict_cute_users}/{coverage['audienceTextUsers']}")

    commerce = data["commerce"]
    check("commerce-purchase-users", commerce["purchaseUserCount"] == 153, str(commerce["purchaseUserCount"]))
    check("commerce-purchase-comments", commerce["purchaseCommentCount"] == 169, str(commerce["purchaseCommentCount"]))
    check("commerce-overlap", commerce["overlapUserCount"] == 146, str(commerce["overlapUserCount"]))
    check("commerce-top3-robustness", commerce["top3RemovedUserCount"] == 152, str(commerce["top3RemovedUserCount"]))

    profiles = read_csv(PROFILES)
    profile_columns = list(profiles[0].keys()) if profiles else []
    profile_ids = [row.get("匿名受众ID", "") for row in profiles]
    check("anonymous-profile-row-count", len(profiles) == 5_410, str(len(profiles)))
    check("anonymous-profile-id-unique", len(profile_ids) == len(set(profile_ids)) == 5_410, f"{len(set(profile_ids))}/5410")
    check("anonymous-profile-id-format", all(re.fullmatch(r"aud_[0-9a-f]{16}", value) for value in profile_ids), "aud_ + 16 lower hex")
    forbidden_columns = re.compile(r"昵称|姓名|账号|用户URL|原始文本|评论正文|评论内容|精确时间|联系方式", re.I)
    bad_columns = [column for column in profile_columns if forbidden_columns.search(column)]
    check("anonymous-profile-no-direct-identity-columns", not bad_columns, ", ".join(bad_columns) or "No direct identity columns")

    pii_patterns = {
        "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
        "url": re.compile(r"(?:https?://|www\.)", re.I),
        "mention": re.compile(r"@"),
        "phone": re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
        "identity_number": re.compile(r"(?<!\d)\d{17}[\dXx](?!\w)"),
        "long_number": re.compile(r"(?<!\d)\d{7,}(?!\d)"),
    }
    pii_hits = {name: 0 for name in pii_patterns}
    for row in profiles:
        for column, value in row.items():
            if column == "匿名受众ID":
                continue
            cell = value or ""
            for name, pattern in pii_patterns.items():
                if pattern.search(cell):
                    pii_hits[name] += 1
    for name, count in pii_hits.items():
        check(f"anonymous-profile-pii:{name}", count == 0, f"{count} hits")

    metric_rows = read_csv(METRICS)
    metric_csv_ids = [row.get("指标ID", "") for row in metric_rows]
    check("metric-dictionary-row-count", len(metric_rows) == 98, str(len(metric_rows)))
    check("metric-dictionary-ids", set(metric_csv_ids) == set(metric_ids), f"{len(set(metric_csv_ids))}/98 matching ids")
    video_rows = read_csv(VIDEOS)
    check("video-statistics-row-count", len(video_rows) == 106, str(len(video_rows)))

    return {
        "profileColumns": profile_columns,
        "piiHits": pii_hits,
        "sectionIds": sorted(section_ids),
        "htmlMetricRows": html_metric_rows,
    }


def browser_validation() -> list[dict[str, Any]]:
    browser_results: list[dict[str, Any]] = []
    viewports = [
        ("desktop", 1440, 1000),
        ("mobile", 390, 844),
        ("compact", 320, 720),
    ]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for label, width, height in viewports:
                console_errors: list[str] = []
                page_errors: list[str] = []
                page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
                page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.goto(REPORT.resolve().as_uri(), wait_until="load", timeout=30_000)
                page.wait_for_timeout(350)

                initial_rows = page.locator("tr[data-module]").count()
                search = page.locator("#metric-search, #metricSearch, input[type='search']")
                search_count = search.count()
                filtered_rows: int | None = None
                if search_count:
                    search.first.fill("GINI")
                    page.wait_for_timeout(150)
                    filtered_rows = page.locator("tr[data-module]:visible").count()
                    search.first.fill("")
                    page.wait_for_timeout(100)

                dom = page.evaluate(
                    """() => {
                      const rootOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
                      const targetLinks = [...document.querySelectorAll('nav a[href^="#part-"]')];
                      const missingTargets = targetLinks.filter(a => !document.querySelector(a.getAttribute('href'))).map(a => a.getAttribute('href'));
                      const clipped = [...document.querySelectorAll('h1,h2,h3,p,.metric,.finding,.signal,.experiment,.bar-head')]
                        .filter(el => {
                          const cs = getComputedStyle(el);
                          return (cs.overflowY === 'hidden' || cs.overflow === 'hidden') && el.scrollHeight > el.clientHeight + 2;
                        })
                        .slice(0, 10)
                        .map(el => ({tag: el.tagName, text: (el.textContent || '').trim().slice(0, 70)}));
                      const accidentalOverflow = [...document.querySelectorAll('body *')]
                        .filter(el => {
                          const cs = getComputedStyle(el);
                          const exempt = el.closest('.table-wrap,.metric-dictionary,.nav-wrap,nav');
                          return !exempt && cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 2;
                        })
                        .slice(0, 10)
                        .map(el => el.className || el.tagName);
                      return {
                        title: document.title,
                        bandCount: document.querySelectorAll('main > section.band').length,
                        partCount: document.querySelectorAll('[id^="part-"]').length,
                        navCount: targetLinks.length,
                        missingTargets,
                        rootOverflow,
                        clipped,
                        accidentalOverflow,
                        textLength: (document.body.innerText || '').length,
                      };
                    }"""
                )
                screenshot = OUT / f"verification-{label}.png"
                page.screenshot(path=str(screenshot), full_page=True)
                page.close()

                view_checks = [
                    ("title", dom["title"] == "三国杀WUHU联盟卡宝98维受众统计深度洞察报告", dom["title"]),
                    ("sections", dom["bandCount"] == 13 and dom["partCount"] == 13, f"bands={dom['bandCount']}, parts={dom['partCount']}"),
                    ("navigation", dom["navCount"] == 13 and not dom["missingTargets"], f"nav={dom['navCount']}, missing={dom['missingTargets']}"),
                    ("metric-table", initial_rows == 98, f"{initial_rows}/98 rows"),
                    ("metric-search", search_count >= 1 and filtered_rows is not None and 0 < filtered_rows < 98, f"input={search_count}, filtered={filtered_rows}"),
                    ("root-horizontal-overflow", not dom["rootOverflow"], str(dom["rootOverflow"])),
                    ("unexpected-overflow", not dom["accidentalOverflow"], str(dom["accidentalOverflow"])),
                    ("text-clipping", not dom["clipped"], str(dom["clipped"])),
                    ("rendered-text", dom["textLength"] > 15_000, str(dom["textLength"])),
                    ("console-errors", not console_errors, str(console_errors)),
                    ("page-errors", not page_errors, str(page_errors)),
                    ("screenshot", screenshot.exists() and screenshot.stat().st_size > 10_000, f"{screenshot.name}:{screenshot.stat().st_size if screenshot.exists() else 0}"),
                ]
                browser_results.append({
                    "viewport": {"name": label, "width": width, "height": height},
                    "checks": [{"name": name, "passed": bool(passed), "detail": detail} for name, passed, detail in view_checks],
                    "dom": dom,
                    "consoleErrors": console_errors,
                    "pageErrors": page_errors,
                    "screenshot": str(screenshot),
                })
        finally:
            browser.close()
    return browser_results


def write_manifest() -> None:
    files = [
        ("source_all_comments", SOURCE_ALL_COMMENTS),
        ("source_videos_summary", SOURCE_VIDEOS),
        ("source_grounded_coded_comments", SOURCE_CODED),
        ("analysis_script", ANALYZER),
        ("report_generator", GENERATOR),
        ("verification_script", SELF),
        ("report_html", REPORT),
        ("analysis_json", ANALYSIS),
        ("anonymous_profiles_csv", PROFILES),
        ("metric_dictionary_csv", METRICS),
        ("video_statistics_csv", VIDEOS),
        ("methodology_md", METHODS),
        ("verification_json", VERIFICATION),
        ("desktop_screenshot", OUT / "verification-desktop.png"),
        ("mobile_screenshot", OUT / "verification-mobile.png"),
        ("compact_screenshot", OUT / "verification-compact.png"),
    ]
    manifest = {
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(),
        "newDefault": str(REPORT),
        "files": [
            {"role": role, "path": str(path), "bytes": path.stat().st_size, "sha256": sha256(path)}
            for role, path in files
        ],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    if not ANALYSIS.exists():
        print(f"Missing analysis artifact: {ANALYSIS}", file=sys.stderr)
        return 1
    data = json.loads(ANALYSIS.read_text(encoding="utf-8"))
    html = REPORT.read_text(encoding="utf-8")
    privacy = static_validation(data, html)
    browser_results = browser_validation()

    all_checks = checks + [check for view in browser_results for check in view["checks"]]
    passed = all(item["passed"] for item in all_checks)
    result = {
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(),
        "passed": passed,
        "newDefault": str(REPORT),
        "staticChecks": checks,
        "browserChecks": browser_results,
        "privacy": privacy,
        "summary": {
            "totalChecks": len(all_checks),
            "passedChecks": sum(1 for item in all_checks if item["passed"]),
            "failedChecks": [item for item in all_checks if not item["passed"]],
        },
    }
    VERIFICATION.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if passed:
        write_manifest()
    print(json.dumps({
        "passed": passed,
        "totalChecks": result["summary"]["totalChecks"],
        "passedChecks": result["summary"]["passedChecks"],
        "failedChecks": result["summary"]["failedChecks"],
        "verification": str(VERIFICATION),
        "manifest": str(MANIFEST) if MANIFEST.exists() else None,
    }, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
