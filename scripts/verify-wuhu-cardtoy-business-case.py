from __future__ import annotations

import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
OUT = ROOT / "output" / "wuhu-cardtoy-business-case-20260817"
REPORT = OUT / "三国杀WUHU联盟卡宝玩偶化立项专项论证报告.html"
METRICS = OUT / "玩偶化立项指标与语义分析.json"
MANIFEST = OUT / "artifact-manifest.json"
LEDGER = OUT / "玩偶化语义证据清单（内部复核）.csv"
TREND = OUT / "玩偶化需求月度趋势.csv"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def check(name: str, predicate: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(predicate), "detail": detail}


def main() -> int:
    checks: list[dict] = []
    required = [
        REPORT,
        METRICS,
        MANIFEST,
        LEDGER,
        TREND,
        OUT / "玩偶化候选视频信号.csv",
        OUT / "玩偶化立项方法与口径说明.md",
    ]
    checks.append(check("required_artifacts", all(path.is_file() for path in required), f"{sum(path.is_file() for path in required)}/{len(required)} artifacts present"))

    metric_data = json.loads(METRICS.read_text(encoding="utf-8"))
    core = metric_data["coreMetrics"]
    expected = {
        "videos": 107,
        "captured": 16796,
        "declared": 17021,
        "audienceComments": 14715,
        "audienceText": 13320,
        "audienceUsers": 5410,
        "textUsers": 4990,
        "strictPurchaseComments": 169,
        "strictPurchaseUsers": 153,
        "toyPurchaseComments": 99,
        "toyPurchaseUsers": 89,
        "actionPhysicalComments": 185,
        "actionPhysicalUsers": 152,
        "designComments": 14,
        "designUsers": 13,
        "priceComments": 8,
        "priceUsers": 6,
    }
    observed = {key: core.get(key) for key in expected}
    checks.append(check("core_metrics", observed == expected, json.dumps(observed, ensure_ascii=False)))
    checks.append(check("coverage", abs(core["coverage"] - 16796 / 17021) < 1e-12, f"coverage={core['coverage']:.12f}"))

    monthly = metric_data["monthly"]
    checks.append(check("monthly_coverage", len(monthly) == 8 and [row["month"] for row in monthly] == [f"2026-{month:02d}" for month in range(1, 9)], f"months={[row['month'] for row in monthly]}"))
    checks.append(check("monthly_purchase_closure", sum(row["purchaseComments"] for row in monthly) == core["strictPurchaseComments"], f"sum={sum(row['purchaseComments'] for row in monthly)}"))
    checks.append(check("monthly_toy_closure", sum(row["toyComments"] for row in monthly) == core["toyPurchaseComments"], f"sum={sum(row['toyComments'] for row in monthly)}"))

    with LEDGER.open(encoding="utf-8-sig", newline="") as handle:
        ledger_rows = list(csv.DictReader(handle))
        headers = list(ledger_rows[0]) if ledger_rows else []
    required_columns = {"语义类别", "评论用户昵称", "评论用户主页", "原始评论", "评论时间", "点赞数", "视频标题", "视频链接", "评论ID"}
    checks.append(check("internal_evidence_ledger", len(ledger_rows) >= 169 and required_columns.issubset(headers), f"rows={len(ledger_rows)}, columns={len(headers)}"))
    checks.append(check("internal_evidence_links", all(row["评论用户主页"].startswith("http") and row["视频链接"].startswith("http") for row in ledger_rows), f"link rows={len(ledger_rows)}"))

    with TREND.open(encoding="utf-8-sig", newline="") as handle:
        trend_rows = list(csv.DictReader(handle))
    checks.append(check("trend_csv_matches_json", trend_rows == [{key: str(value) for key, value in row.items()} for row in monthly], f"csv rows={len(trend_rows)}"))

    html = REPORT.read_text(encoding="utf-8")
    forbidden = ["不是", "而是", "是不是", "并非", "而非", "不等于"]
    hits = [term for term in forbidden if term in html]
    checks.append(check("report_style_terms", not hits, f"hits={hits}"))
    checks.append(check("report_structure", html.count("<section") >= 8 and html.count('class="quote"') >= 6, f"sections={html.count('<section')}, quotes={html.count('class=\"quote\"')}"))
    checks.append(check("report_no_unresolved_values", "undefined" not in html and "NaN" not in html, "undefined/NaN scan"))
    required_text = ["99 条明确指向", "185 条产品动作句", "语义步骤 1", "2026 年 5 月起", "6 周试验节奏"]
    checks.append(check("report_semantic_chain", all(text in html for text in required_text), "semantic action-object-condition and time trend anchors"))

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    digest_entries = manifest["sources"] + manifest["files"]
    digest_ok = True
    digest_failures: list[str] = []
    for entry in digest_entries:
        path = Path(entry["file"])
        if not path.is_absolute():
            path = OUT / path
        current = path.is_file() and path.stat().st_size == entry["bytes"] and sha256(path) == entry["sha256"]
        if not current:
            digest_ok = False
            digest_failures.append(entry["file"])
    checks.append(check("manifest_hashes", digest_ok, f"checked={len(digest_entries)}, failures={digest_failures}"))

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "passed": all(item["passed"] for item in checks),
        "passedCount": sum(item["passed"] for item in checks),
        "totalCount": len(checks),
        "checks": checks,
    }
    (OUT / "verification.json").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: output[key] for key in ["passed", "passedCount", "totalCount"]}, ensure_ascii=False))
    for item in checks:
        print(f"{'PASS' if item['passed'] else 'FAIL'} {item['name']}: {item['detail']}")
    return 0 if output["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
