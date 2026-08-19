#!/usr/bin/env python3
"""Independent content, integrity, privacy, and browser verification for the master report."""

from __future__ import annotations

import csv
import hashlib
import html as html_lib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
OUT = ROOT / "output" / "wuhu-mkt-master-strategy-20260814"
REPORT = OUT / "三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告.html"
ANALYSIS = OUT / "wuhu-mkt-multidimensional-analysis.json"
PROFILES = OUT / "wuhu-mkt-multidimensional-anonymous-profiles.csv"
METRICS = OUT / "wuhu-mkt-multidimensional-metric-dictionary.csv"
VIDEOS = OUT / "wuhu-mkt-multidimensional-video-statistics.csv"
JOURNEYS = OUT / "wuhu-mkt-deep-pseudonymous-journeys.csv"
SCORECARD = OUT / "wuhu-mkt-deep-video-scorecard.csv"
CODED = OUT / "wuhu-grounded-coded-comments.csv"
REPEAT_DATA = OUT / "wuhu-repeat-commenter-background-analysis.json"
IDENTIFIED_TIMING = OUT / "wuhu-repeat-commenter-identified-temporal-analysis.json"
IDENTIFIED_SUMMARY = OUT / "多次评论用户具名画像与时序.csv"
IDENTIFIED_TIMELINE = OUT / "多次评论用户逐条评论时序明细.csv"
IDENTIFIED_APPENDIX = OUT / "多次评论用户具名时序附录.html"
METHOD = OUT / "主报告证据口径与复算说明.md"
DELIVERY = OUT / "交付清单.md"
VERIFICATION = OUT / "verification.json"
MANIFEST = OUT / "artifact-manifest.json"

SOURCE_COMMENTS = Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\all-comments.csv")
SOURCE_VIDEOS = Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\videos-summary.csv")
GENERATOR = ROOT / "scripts" / "generate-wuhu-mkt-master-report.mjs"
EXPANDED = ROOT / "scripts" / "wuhu-master-expanded-sections.mjs"
REPEAT_ANALYZER = ROOT / "scripts" / "analyze-wuhu-repeat-user-background.py"
IDENTIFIED_BUILDER = ROOT / "scripts" / "build-wuhu-repeat-commenter-identified-appendix.py"
REPEAT_SECTION = ROOT / "scripts" / "wuhu-repeat-commenter-section.mjs"
SELF = Path(__file__).resolve()

SOURCE_COPIES = [
    (ROOT / "output" / "wuhu-mkt-multidimensional-audience-20260814" / "wuhu-mkt-multidimensional-analysis.json", ANALYSIS),
    (ROOT / "output" / "wuhu-mkt-multidimensional-audience-20260814" / "wuhu-mkt-multidimensional-metric-dictionary.csv", METRICS),
    (ROOT / "output" / "wuhu-mkt-multidimensional-audience-20260814" / "wuhu-mkt-multidimensional-anonymous-profiles.csv", PROFILES),
    (ROOT / "output" / "wuhu-mkt-multidimensional-audience-20260814" / "wuhu-mkt-multidimensional-video-statistics.csv", VIDEOS),
    (ROOT / "output" / "wuhu-mkt-deep-analysis-20260814" / "wuhu-mkt-deep-analysis.json", OUT / "wuhu-mkt-deep-analysis.json"),
    (ROOT / "output" / "wuhu-mkt-deep-analysis-20260814" / "wuhu-mkt-deep-pseudonymous-journeys.csv", JOURNEYS),
    (ROOT / "output" / "wuhu-mkt-deep-analysis-20260814" / "wuhu-mkt-deep-video-scorecard.csv", SCORECARD),
    (ROOT / "output" / "wuhu-grounded-player-context-20260813" / "wuhu-grounded-player-context-analysis.json", OUT / "wuhu-grounded-player-context-analysis.json"),
    (ROOT / "output" / "wuhu-grounded-player-context-20260813" / "wuhu-grounded-coded-comments.csv", CODED),
    (ROOT / "output" / "wuhu-grounded-player-context-20260813" / "三国杀玩家语境扎根编码手册.md", OUT / "三国杀玩家语境扎根编码手册.md"),
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def visible_text(markup: str) -> str:
    text = re.sub(r"<script\b[^>]*>.*?</script>", " ", markup, flags=re.I | re.S)
    text = re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


checks: list[dict[str, Any]] = []


def check(name: str, condition: bool, detail: str) -> None:
    checks.append({"name": name, "passed": bool(condition), "detail": detail})


def static_validation(data: dict[str, Any], markup: str) -> dict[str, Any]:
    required = [REPORT, ANALYSIS, PROFILES, METRICS, VIDEOS, JOURNEYS, SCORECARD, CODED, REPEAT_DATA, IDENTIFIED_TIMING, IDENTIFIED_SUMMARY, IDENTIFIED_TIMELINE, IDENTIFIED_APPENDIX, METHOD, DELIVERY, GENERATOR, EXPANDED, REPEAT_ANALYZER, IDENTIFIED_BUILDER, REPEAT_SECTION, SELF]
    for path in required:
        check(f"exists:{path.name}", path.exists(), str(path))

    body_text = visible_text(markup)
    pre_appendix = markup.split('id="part-28"', 1)[0]
    narrative_text = visible_text(pre_appendix)
    check("report-size", REPORT.stat().st_size >= 180_000, f"{REPORT.stat().st_size} bytes")
    check("visible-text-volume", len(body_text) >= 45_000, f"{len(body_text)} characters")
    check("pre-appendix-content-volume", len(narrative_text) >= 30_000, f"{len(narrative_text)} characters before appendix")
    check("html-utf8", "\ufffd" not in markup, "No replacement characters")
    check("html-no-mojibake-markers", not re.search(r"锟|鈥|锛", markup), "No common mojibake markers")
    check("html-no-template-leaks", not re.search(r"undefined|NaN|\[object Object\]", markup), "No template leaks")
    check("offline-no-external-assets", not re.search(r"<(?:script|img|link)\b[^>]+(?:src|href)=[\"']https?://", markup, re.I), "No HTTP(S) asset dependencies")

    section_ids = set(re.findall(r'id=[\"\'](part-\d+)[\"\']', markup))
    nav_targets = re.findall(r'href=[\"\']#(part-\d+)[\"\']', markup)
    metric_rows = len(re.findall(r"<tr[^>]*data-module=", markup, re.I))
    check("section-count", len(section_ids) == 28, f"{len(section_ids)}/28 unique parts")
    check("navigation-count", len(nav_targets) == 28 and set(nav_targets) == section_ids, f"{len(nav_targets)}/28 links")
    check("metric-row-count", metric_rows == 98, f"{metric_rows}/98 rows")
    check("quote-evidence-count", markup.count('class="quote"') >= 12, f"{markup.count('class=\"quote\"')} quote blocks")
    check("decision-module-count", markup.count('class="verdict"') >= 8, f"{markup.count('class=\"verdict\"')} verdict blocks")

    required_topics = [
        "受众关系阶梯", "五层语境", "玩家 × 萌化", "角色资产", "角色关系资产",
        "内容原型", "视频任务", "线程", "to签", "严格购买", "商品策略",
        "90天", "KPI", "证据限制", "Wilson", "观察性关联",
        "内部具名时序", "精确时间", "相邻评论间隔", "原始评论",
    ]
    missing_topics = [topic for topic in required_topics if topic not in body_text]
    check("content-topic-coverage", not missing_topics, ", ".join(missing_topics) or "16/16 topics present")

    check("metric-dimension-count", data["scope"]["metricDimensions"] == 98, str(data["scope"]["metricDimensions"]))
    check("statistical-method-count", data["scope"]["statisticalMethodCount"] == 34, str(data["scope"]["statisticalMethodCount"]))
    check("semantic-code-count", len(data["semanticCodes"]) == 34, str(len(data["semanticCodes"])))
    expected = {
        "videos": 107, "commentBearingVideos": 106, "capturedComments": 16_796,
        "declaredComments": 17_021, "audienceComments": 14_715, "audienceUsers": 5_410,
        "audienceTextComments": 13_320, "audienceTextUsers": 4_990,
    }
    for key, value in expected.items():
        check(f"coverage:{key}", data["coverage"][key] == value, f"{data['coverage'][key]} expected {value}")

    for source, copied in SOURCE_COPIES:
        condition = source.exists() and copied.exists() and sha256(source) == sha256(copied)
        check(f"source-copy:{copied.name}", condition, f"{source} -> {copied}")

    links = [html_lib.unescape(link) for link in re.findall(r'href=[\"\']([^\"\']+)[\"\']', markup)]
    local_links = [link for link in links if not link.startswith("#") and not re.match(r"^(?:https?:)?//", link, re.I)]
    missing_links = [link for link in local_links if not (OUT / link).exists()]
    check("local-delivery-links", not missing_links, ", ".join(missing_links) or f"{len(local_links)} local links resolved")

    profiles = read_csv(PROFILES)
    journeys = read_csv(JOURNEYS)
    metrics = read_csv(METRICS)
    videos = read_csv(VIDEOS)
    coded = read_csv(CODED)
    identified_summary = read_csv(IDENTIFIED_SUMMARY)
    identified_timeline = read_csv(IDENTIFIED_TIMELINE)
    temporal = json.loads(IDENTIFIED_TIMING.read_text(encoding="utf-8"))
    check("anonymous-profile-rows", len(profiles) == 5_410, str(len(profiles)))
    check("journey-rows", len(journeys) == 4_990, str(len(journeys)))
    check("metric-dictionary-rows", len(metrics) == 98, str(len(metrics)))
    check("video-statistic-rows", len(videos) == 106, str(len(videos)))
    check("coded-comment-rows", len(coded) == 16_796, str(len(coded)))
    check("identified-summary-rows", len(identified_summary) == 2_059, str(len(identified_summary)))
    check("identified-timeline-rows", len(identified_timeline) == 11_364, str(len(identified_timeline)))
    check("identified-summary-fields", all(all(row.get(field) for field in ("昵称（样本期常用）", "主页", "首评精确时间", "末评精确时间")) for row in identified_summary), "昵称/主页/首末精确时间均存在")
    check("identified-timeline-fields", all(all(field in row for field in ("昵称", "主页", "评论时间", "评论内容", "所属视频标题")) for row in identified_timeline), "逐条具名时序字段完整")
    check("identified-temporal-scope", temporal.get("scope", {}).get("repeatUsers") == 2_059 and temporal.get("scope", {}).get("repeatCommentEvents") == 11_364 and temporal.get("scope", {}).get("internalOnly") is True, str(temporal.get("scope", {})))
    check("identified-temporal-intervals", temporal.get("intervals", {}).get("n") == 9_305 and temporal.get("sessions", {}).get("total") == 8_732, "9,305个相邻间隔 / 8,732个六小时会话")

    pii_patterns = {
        "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
        "url": re.compile(r"(?:https?://|www\.)", re.I),
        "phone": re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
        "identity": re.compile(r"(?<!\d)\d{17}[\dXx](?!\w)"),
    }
    pii_hits = {name: 0 for name in pii_patterns}
    for rows in (profiles, journeys, coded):
        for row in rows:
            for key, value in row.items():
                if key in {"匿名受众ID", "评论ID", "视频ID"}:
                    continue
                cell = value or ""
                for name, pattern in pii_patterns.items():
                    if pattern.search(cell):
                        pii_hits[name] += 1
    for name, count in pii_hits.items():
        check(f"anonymous-exports-pii:{name}", count == 0, f"{count} hits")

    method_text = METHOD.read_text(encoding="utf-8")
    check("method-current-title", method_text.startswith("# 三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告"), method_text.splitlines()[0])
    return {
        "visibleTextCharacters": len(body_text),
        "preAppendixTextCharacters": len(narrative_text),
        "sectionIds": sorted(section_ids),
        "metricRows": metric_rows,
        "piiHits": pii_hits,
    }


def browser_validation() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    viewports = [("desktop", 1440, 1000), ("mobile", 390, 844), ("compact", 320, 720)]
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
                page.wait_for_timeout(250)
                initial_rows = page.locator("tr[data-module]").count()
                search = page.locator("#metricSearch")
                search.fill("购买")
                page.wait_for_timeout(100)
                filtered_rows = page.locator("tr[data-module]:visible").count()
                search.fill("")

                dom = page.evaluate("""() => {
                  const nav = [...document.querySelectorAll('nav a[href^="#part-"]')];
                  const blocks = [...document.querySelectorAll('.part-head, main > section.band')]
                    .map(el => ({top: el.getBoundingClientRect().top + scrollY, bottom: el.getBoundingClientRect().bottom + scrollY}));
                  const overlaps = blocks.slice(1).filter((item, index) => item.top < blocks[index].bottom - 1).length;
                  const clipped = [...document.querySelectorAll('h1,h2,h3,p,.metric,.finding,.signal,.experiment,.quote,.verdict')]
                    .filter(el => {
                      const cs = getComputedStyle(el);
                      return (cs.overflow === 'hidden' || cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 2;
                    }).slice(0, 8).map(el => (el.textContent || '').trim().slice(0, 60));
                  return {
                    title: document.title,
                    parts: document.querySelectorAll('[id^="part-"]').length,
                    bands: document.querySelectorAll('main > section.band').length,
                    nav: nav.length,
                    missing: nav.filter(a => !document.querySelector(a.getAttribute('href'))).map(a => a.getAttribute('href')),
                    rootOverflow: document.documentElement.scrollWidth > innerWidth + 1,
                    clipped,
                    overlaps,
                    textLength: (document.body.innerText || '').length,
                  };
                }""")
                screenshot = OUT / f"verification-{label}.png"
                page.screenshot(path=str(screenshot), full_page=True)
                page.close()

                viewport_checks = [
                    ("title", dom["title"] == "三国杀WUHU联盟卡宝受众资产与内容增长战略全量报告", dom["title"]),
                     ("parts", dom["parts"] == 28 and dom["bands"] == 28, f"parts={dom['parts']}, bands={dom['bands']}"),
                     ("navigation", dom["nav"] == 28 and not dom["missing"], f"nav={dom['nav']}, missing={dom['missing']}"),
                    ("metric-table", initial_rows == 98, f"{initial_rows}/98 rows"),
                    ("metric-search", 0 < filtered_rows < 98, f"{filtered_rows}/98 rows after search"),
                    ("horizontal-overflow", not dom["rootOverflow"], str(dom["rootOverflow"])),
                    ("text-clipping", not dom["clipped"], str(dom["clipped"])),
                    ("section-overlap", dom["overlaps"] == 0, str(dom["overlaps"])),
                    ("rendered-text", dom["textLength"] >= 45_000, str(dom["textLength"])),
                    ("console-errors", not console_errors, str(console_errors)),
                    ("page-errors", not page_errors, str(page_errors)),
                    ("screenshot", screenshot.exists() and screenshot.stat().st_size > 50_000, f"{screenshot.name}:{screenshot.stat().st_size if screenshot.exists() else 0}"),
                ]
                results.append({
                    "viewport": {"name": label, "width": width, "height": height},
                    "checks": [{"name": name, "passed": bool(passed), "detail": detail} for name, passed, detail in viewport_checks],
                    "dom": dom,
                    "consoleErrors": console_errors,
                    "pageErrors": page_errors,
                    "screenshot": str(screenshot),
                })
        finally:
            browser.close()
    return results


def write_manifest() -> None:
    roles = {
        SOURCE_COMMENTS: "source_all_comments", SOURCE_VIDEOS: "source_videos_summary",
        GENERATOR: "report_generator", EXPANDED: "expanded_sections", REPEAT_ANALYZER: "repeat_user_analyzer", IDENTIFIED_BUILDER: "identified_temporal_builder", REPEAT_SECTION: "repeat_commenter_section", SELF: "verification_script",
        REPORT: "report_html", METHOD: "methodology", DELIVERY: "delivery_index",
    }
    artifacts = [path for path in OUT.rglob("*") if path.is_file() and path.name != MANIFEST.name]
    files = [SOURCE_COMMENTS, SOURCE_VIDEOS, GENERATOR, EXPANDED, REPEAT_ANALYZER, IDENTIFIED_BUILDER, REPEAT_SECTION, SELF] + artifacts
    manifest = {
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(),
        "newDefault": str(REPORT),
        "files": [
            {"role": roles.get(path, f"artifact:{path.relative_to(OUT).as_posix()}" if path.is_relative_to(OUT) else "source"),
             "path": str(path), "bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in files
        ],
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    data = json.loads(ANALYSIS.read_text(encoding="utf-8"))
    markup = REPORT.read_text(encoding="utf-8")
    content = static_validation(data, markup)
    browser_results = browser_validation()
    all_checks = checks + [item for viewport in browser_results for item in viewport["checks"]]
    passed = all(item["passed"] for item in all_checks)
    result = {
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(),
        "passed": passed,
        "newDefault": str(REPORT),
        "staticChecks": checks,
        "browserChecks": browser_results,
        "content": content,
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
        "passed": passed, "totalChecks": result["summary"]["totalChecks"],
        "passedChecks": result["summary"]["passedChecks"], "failedChecks": result["summary"]["failedChecks"],
        "visibleTextCharacters": content["visibleTextCharacters"],
        "preAppendixTextCharacters": content["preAppendixTextCharacters"],
        "verification": str(VERIFICATION), "manifest": str(MANIFEST) if MANIFEST.exists() else None,
    }, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
