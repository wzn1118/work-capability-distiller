import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
OUT_DIR = ROOT / "output" / "wuhu-mkt-deep-analysis-20260814"
REPORT_PATH = OUT_DIR / "三国杀WUHU联盟卡宝粉丝与受众MKT深度洞察报告.html"
ANALYSIS_PATH = OUT_DIR / "wuhu-mkt-deep-analysis.json"
JOURNEY_PATH = OUT_DIR / "wuhu-mkt-deep-pseudonymous-journeys.csv"
VIDEO_PATH = OUT_DIR / "wuhu-mkt-deep-video-scorecard.csv"
METHOD_PATH = OUT_DIR / "深度MKT分析口径与复算说明.md"
RESULT_PATH = OUT_DIR / "verification.json"
MANIFEST_PATH = OUT_DIR / "artifact-manifest.json"
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

SOURCE_PATHS = [
    Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\all-comments.csv"),
    Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\videos-summary.csv"),
    ROOT / "output" / "wuhu-grounded-player-context-20260813" / "wuhu-grounded-coded-comments.csv",
    ROOT / "output" / "wuhu-grounded-player-context-20260813" / "wuhu-grounded-player-context-analysis.json",
]

EXPECTED_JOURNEY_COLUMNS = [
    "匿名受众ID",
    "首次入口",
    "首条时间",
    "评论数",
    "文本评论数",
    "视频数",
    "活跃层",
    "活跃跨度天",
    "第二次互动时延小时",
    "跨视频复访代理",
    "观察7日回访",
    "观察30日回访",
    "最高参与深度",
    "互斥语境层级",
    "状态迁移路径",
    "严格玩家语境",
    "关系共创",
    "周边兴趣",
    "严格购买意向",
]


def read_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return reader.fieldnames or [], list(reader)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_file(path, minimum_bytes=1):
    return path.is_file() and path.stat().st_size >= minimum_bytes


def inspect_view(browser, name, width, height):
    page = browser.new_page(viewport={"width": width, "height": height})
    console_errors = []
    page_errors = []
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.goto(REPORT_PATH.as_uri(), wait_until="load")
    page.wait_for_timeout(350)

    measurements = page.evaluate(
        """
        () => {
          const root = document.documentElement;
          const visible = (el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const svgMetrics = [...document.querySelectorAll('svg')].map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              circles: el.querySelectorAll('circle').length,
              labels: el.querySelectorAll('text').length,
            };
          });
          const navLinks = [...document.querySelectorAll('.report-nav a[href^="#"]')];
          const accidentalOverflow = [...document.querySelectorAll('body *')]
            .filter((el) => {
              if (!visible(el)) return false;
              if (el.closest('.table-wrap, .chart-scroll, .report-nav')) return false;
              const style = getComputedStyle(el);
              if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) return false;
              return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 3;
            })
            .slice(0, 20)
            .map((el) => ({
              tag: el.tagName,
              className: String(el.className || '').slice(0, 100),
              clientWidth: el.clientWidth,
              scrollWidth: el.scrollWidth,
              text: String(el.textContent || '').trim().slice(0, 90),
            }));
          const clippedText = [...document.querySelectorAll('h1,h2,h3,h4,p,.metric,.callout,.bar-head,.cover-meta span')]
            .filter((el) => {
              if (!visible(el) || el.closest('.table-wrap, .chart-scroll, .report-nav')) return false;
              const style = getComputedStyle(el);
              if (['auto', 'scroll'].includes(style.overflowY)) return false;
              return el.scrollHeight > el.clientHeight + 6;
            })
            .slice(0, 20)
            .map((el) => ({
              tag: el.tagName,
              className: String(el.className || '').slice(0, 100),
              clientHeight: el.clientHeight,
              scrollHeight: el.scrollHeight,
              text: String(el.textContent || '').trim().slice(0, 90),
            }));
          return {
            title: document.title,
            viewport: {width: innerWidth, height: innerHeight},
            documentWidth: root.scrollWidth,
            documentHeight: root.scrollHeight,
            bodyHorizontalOverflow: root.scrollWidth > innerWidth + 1,
            coverHeight: Math.round(document.querySelector('.cover').getBoundingClientRect().height),
            sectionCount: document.querySelectorAll('main > section.section').length,
            partCount: document.querySelectorAll('.part-head[id]').length,
            h2Count: document.querySelectorAll('.part-head h2').length,
            tableCount: document.querySelectorAll('table').length,
            barListCount: document.querySelectorAll('.bar-list').length,
            metricCount: document.querySelectorAll('.metric').length,
            calloutCount: document.querySelectorAll('.callout').length,
            svgMetrics,
            navLinkCount: navLinks.length,
            missingNavTargets: navLinks
              .map((link) => link.getAttribute('href'))
              .filter((href) => !document.querySelector(href)),
            accidentalOverflow,
            clippedText,
            reportTextLength: document.body.innerText.length,
          };
        }
        """
    )

    screenshot_path = OUT_DIR / f"verification-{name}.png"
    page.screenshot(path=str(screenshot_path), full_page=True)
    page.close()

    svg_metrics = measurements["svgMetrics"]
    checks = {
        "no_page_horizontal_overflow": not measurements["bodyHorizontalOverflow"],
        "no_unexpected_element_overflow": not measurements["accidentalOverflow"],
        "no_clipped_text": not measurements["clippedText"],
        "all_13_sections_rendered": measurements["sectionCount"] == 13
        and measurements["partCount"] == 13
        and measurements["h2Count"] == 13,
        "all_nav_targets_exist": measurements["navLinkCount"] == 13
        and not measurements["missingNavTargets"],
        "both_scatterplots_nonblank": len(svg_metrics) == 2
        and all(item["width"] > 200 and item["height"] > 120 for item in svg_metrics)
        and sum(item["circles"] for item in svg_metrics) == 154,
        "dense_evidence_components_present": measurements["tableCount"] >= 9
        and measurements["barListCount"] >= 14
        and measurements["metricCount"] >= 24
        and measurements["calloutCount"] >= 20,
        "substantial_report_text": measurements["reportTextLength"] >= 18000,
        "no_console_errors": not console_errors,
        "no_page_errors": not page_errors,
        "screenshot_created": check_file(screenshot_path, 10_000),
    }
    return {
        "viewport": {"name": name, "width": width, "height": height},
        "measurements": measurements,
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "screenshot": str(screenshot_path),
        "checks": checks,
        "passed": all(checks.values()),
    }


def build_static_checks(data, html, journey_columns, journeys, video_columns, videos):
    lifecycle_sum = sum(
        row["users"] for row in data["lifecycle"]["observedLifecycleSegments"]
    )
    journey_ids = [row["匿名受众ID"] for row in journeys]
    video_ids = [row["视频ID"] for row in videos]
    role_proxy_rows = data["roles"]["sensitivity"]
    pair_proxy_rows = data["roles"]["pairs"]
    role_proxy_keys = {
        "titleSupplyVideos",
        "titleContextCommenters",
        "nonTitleMentionUsers",
        "nonTitleMentionComments",
        "nonTitleMentionLikes",
        "titleSupplyIndex",
        "nonTitleMentionIndex",
        "relativeOpportunityIndex",
    }
    pair_proxy_keys = {
        "titleSupplyVideos",
        "nonTitleCoMentionUsers",
        "nonTitleCoMentionComments",
        "nonTitleCoMentionLikes",
        "nonTitleCoMentionShippingComments",
        "nonTitleCoMentionActionComments",
        "titleSupplyIndex",
        "nonTitleCoMentionIndex",
        "relativeOpportunityIndex",
    }
    legacy_market_keys = {
        "supplyVideos",
        "titleExposureUsers",
        "spontaneousUsers",
        "spontaneousComments",
        "spontaneousLikes",
        "spontaneousShippingComments",
        "spontaneousActionComments",
        "supplyIndex",
        "demandIndex",
        "gapIndex",
    }
    semantic_ratio_specs = [
        ("严格玩家用户", "严格玩家用户占文本受众比"),
        ("共创用户", "共创用户占文本受众比"),
        ("周边兴趣用户", "周边兴趣用户占文本受众比"),
    ]
    video_ratio_denominators_reconcile = all(
        all(
            abs(
                float(row[rate_column])
                - (
                    int(row[count_column]) / int(row["有文本受众用户"])
                    if int(row["有文本受众用户"])
                    else 0
                )
            )
            <= 0.0001
            for count_column, rate_column in semantic_ratio_specs
        )
        for row in videos
    )
    journey_blob = JOURNEY_PATH.read_text(encoding="utf-8-sig")
    sensitive_patterns = {
        "email": re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
        "raw_url": re.compile(r"https?://", re.I),
        "at_mention": re.compile(r"@[^,\s]+"),
    }
    sensitive_hits = {
        name: len(pattern.findall(journey_blob))
        for name, pattern in sensitive_patterns.items()
    }
    expected_phrases = [
        "5,410 位观众评论者",
        "4,990 位有文本观众",
        "1,824 人（33.7%）",
        "1,446",
        "角色识别覆盖91.5%",
        "153人/169评",
        "47组",
        "不是单向下漏",
        "非标题点名代理",
        "有文本用户",
        "无法排除角色在画面、对白或剧情中出现",
    ]
    rejected_causal_claims = [
        "深语境是留存引擎",
        "萌化是商品入口",
        "玩家语境负责留存",
        "增长不是单条爆款",
        "高供给 × 高自发需求",
        "低供给 × 高自发需求",
    ]
    static_checks = {
        "all_primary_artifacts_exist": all(
            check_file(path, 500)
            for path in [REPORT_PATH, ANALYSIS_PATH, JOURNEY_PATH, VIDEO_PATH, METHOD_PATH]
        ),
        "coverage_totals_exact": len(data["content"]["videos"]) == 107
        and data["coverage"]["capturedComments"] == 16796
        and data["coverage"]["audienceCommentsWithDate"] == 14715
        and data["coverage"]["audienceTextUsers"] == 4990,
        "lifecycle_reconciles": data["lifecycle"]["audienceUsers"] == 5410
        and lifecycle_sum == 5410,
        "journey_schema_exact": journey_columns == EXPECTED_JOURNEY_COLUMNS,
        "journey_rows_and_ids_exact": len(journeys) == 4990
        and len(journey_ids) == len(set(journey_ids))
        and all(value.startswith("aud_") for value in journey_ids),
        "journey_has_no_direct_identifiers": not any(sensitive_hits.values())
        and "评论用户URL" not in journey_columns
        and "评论用户" not in journey_columns,
        "video_rows_and_ids_exact": len(videos) == 107
        and len(video_ids) == len(set(video_ids))
        and "有文本受众用户" in video_columns
        and "严格玩家用户" in video_columns
        and "严格购买用户" in video_columns,
        "video_semantic_ratios_use_visible_text_denominator": video_ratio_denominators_reconcile,
        "machine_role_schema_uses_proxy_language": len(role_proxy_rows) == 47
        and all(role_proxy_keys <= set(row) for row in role_proxy_rows)
        and all(not (legacy_market_keys & set(row)) for row in role_proxy_rows)
        and all("非标题点名代理" in row["quadrant"] for row in role_proxy_rows),
        "machine_relationship_schema_uses_proxy_language": len(pair_proxy_rows) == 8
        and all(pair_proxy_keys <= set(row) for row in pair_proxy_rows)
        and all(not (legacy_market_keys & set(row)) for row in pair_proxy_rows)
        and all("非标题共同点名代理" in row["quadrant"] for row in pair_proxy_rows),
        "report_has_expected_deep_findings": all(phrase in html for phrase in expected_phrases),
        "report_avoids_rejected_causal_claims": not any(
            phrase in html for phrase in rejected_causal_claims
        ),
        "report_is_offline_standalone": "<script src=" not in html.lower()
        and "<link rel=\"stylesheet\"" not in html.lower()
        and "data:image" not in html.lower(),
        "report_has_no_placeholder_values": not re.search(
            r"\b(?:undefined|NaN|null)\b|0\s*/\s*0\.0%", html
        ),
        "report_structure_static": html.count('<div class="part-head"') == 13
        and html.count("<svg") == 2
        and html.count("<table") >= 9,
    }
    return static_checks, sensitive_hits


def write_manifest(paths):
    items = []
    for path in paths:
        items.append(
            {
                "path": str(path),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "report": str(REPORT_PATH),
        "items": items,
    }
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def main():
    required = [REPORT_PATH, ANALYSIS_PATH, JOURNEY_PATH, VIDEO_PATH, METHOD_PATH, EDGE_PATH]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing required files: " + "; ".join(missing))

    data = json.loads(ANALYSIS_PATH.read_text(encoding="utf-8"))
    html = REPORT_PATH.read_text(encoding="utf-8")
    journey_columns, journeys = read_csv(JOURNEY_PATH)
    video_columns, videos = read_csv(VIDEO_PATH)
    static_checks, sensitive_hits = build_static_checks(
        data, html, journey_columns, journeys, video_columns, videos
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=str(EDGE_PATH),
            headless=True,
            args=["--allow-file-access-from-files"],
        )
        try:
            viewports = [
                inspect_view(browser, "desktop", 1440, 1000),
                inspect_view(browser, "mobile", 390, 844),
                inspect_view(browser, "compact", 320, 720),
            ]
            browser_version = browser.version
        finally:
            browser.close()

    passed = all(static_checks.values()) and all(item["passed"] for item in viewports)
    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "report": str(REPORT_PATH),
        "browser": browser_version,
        "staticChecks": static_checks,
        "journeySensitivePatternHits": sensitive_hits,
        "viewports": viewports,
        "passed": passed,
    }
    RESULT_PATH.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    manifest_paths = SOURCE_PATHS + [
        REPORT_PATH,
        ANALYSIS_PATH,
        JOURNEY_PATH,
        VIDEO_PATH,
        METHOD_PATH,
        RESULT_PATH,
        *(OUT_DIR / f"verification-{name}.png" for name in ("desktop", "mobile", "compact")),
    ]
    manifest = write_manifest(manifest_paths)

    print(
        json.dumps(
            {
                "verification": str(RESULT_PATH),
                "manifest": str(MANIFEST_PATH),
                "manifestItems": len(manifest["items"]),
                "passed": passed,
            },
            ensure_ascii=False,
        )
    )
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
