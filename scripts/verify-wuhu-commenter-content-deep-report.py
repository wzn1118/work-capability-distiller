from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "wuhu-commenter-content-deep-report-20260815"
REPORT = OUT / "三国杀WUHU联盟卡宝评论用户与内容关系超级深度报告.html"
VIDEO_CSV = OUT / "评论用户×内容证据矩阵.csv"
EVIDENCE_CSV = OUT / "具名评论用户与内容证据样本.csv"
TREND_CSV = OUT / "评论用户时间趋势.csv"
METHODS = OUT / "评论用户与内容报告方法说明.md"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(condition: bool, message: str, failures: list[str], checks: list[str]) -> None:
    checks.append(message)
    if not condition:
        failures.append(message)


def main() -> int:
    failures: list[str] = []
    checks: list[str] = []
    required = [REPORT, VIDEO_CSV, EVIDENCE_CSV, TREND_CSV, METHODS, OUT / "artifact-manifest.json"]
    for path in required:
        check(path.exists() and path.stat().st_size > 0, f"file:{path.name}", failures, checks)

    html = REPORT.read_text(encoding="utf-8") if REPORT.exists() else ""
    check(html.count("<section") == 14, "report:14 sections", failures, checks)
    for token in ["评论用户与内容关系超级深度报告", "5,410", "4,990", "14,715", "13,320", "107条视频", "具名多次评论用户", "玩家×萌化", "月度评论量与活跃评论用户趋势", "近14周评论脉冲", "评论用户时间趋势.csv", "评论用户×内容证据矩阵.csv"]:
        check(token in html, f"report:contains:{token}", failures, checks)
    for bad in ["NaN", "undefined", "[object Object]", "</p></aside>"]:
        check(bad not in html, f"report:no:{bad}", failures, checks)
    assertive_forbidden = ["不是", "而是", "是不是", "不把", "不等于", "不代表", "并不", "不应", "而非"]
    for phrase in assertive_forbidden:
        check(phrase not in html, f"report:assertive-language:no:{phrase}", failures, checks)
    methods_text = METHODS.read_text(encoding="utf-8") if METHODS.exists() else ""
    for phrase in assertive_forbidden:
        check(phrase not in methods_text, f"methods:assertive-language:no:{phrase}", failures, checks)
    check("<script" not in html.lower(), "report:no-external-script", failures, checks)
    check(html.count('class="quote"') >= 8, "report:raw-quote-evidence", failures, checks)
    check(html.count("target=\"_blank\"") >= 16, "report:profile-and-video-links", failures, checks)

    if VIDEO_CSV.exists():
        with VIDEO_CSV.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        check(len(rows) == 107, "video-matrix:107 rows", failures, checks)
        check(len({row.get("视频ID") for row in rows}) == 107, "video-matrix:unique video ids", failures, checks)
        check(all(row.get("视频标题") for row in rows), "video-matrix:titles present", failures, checks)
        check(any(row.get("观众用户") == "163" for row in rows), "video-matrix:sample video anchor", failures, checks)
    if EVIDENCE_CSV.exists():
        with EVIDENCE_CSV.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        check(len(rows) >= 20, "evidence:at-least-20 rows", failures, checks)
        check(any("主题原评" in row.get("证据类型", "") for row in rows), "evidence:theme quotes", failures, checks)
        check(any("具名轨迹" in row.get("证据类型", "") for row in rows), "evidence:named trajectories", failures, checks)
        check(any(row.get("用户主页", "").startswith("https://www.douyin.com/user/") for row in rows), "evidence:profile urls", failures, checks)
        check(any(row.get("原始评论") for row in rows), "evidence:raw text", failures, checks)

    if TREND_CSV.exists():
        with TREND_CSV.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        check(len(rows) == 8, "trend:8 calendar months", failures, checks)
        check(sum(int(row["观众评论"]) for row in rows) == 14715, "trend:comments sum 14715", failures, checks)
        by_month = {row["月份"]: row for row in rows}
        check(by_month.get("2026-07", {}).get("观众评论") == "8205", "trend:july comments 8205", failures, checks)
        check(by_month.get("2026-08", {}).get("观察天数") == "13", "trend:august partial 13 days", failures, checks)
        check(all("严格玩家语境每千文本评论" in row for row in rows), "trend:normalized semantic rate", failures, checks)

    manifest = json.loads((OUT / "artifact-manifest.json").read_text(encoding="utf-8")) if (OUT / "artifact-manifest.json").exists() else {}
    check(len(manifest.get("sources", [])) == 3, "manifest:3 source hashes", failures, checks)
    check(len(manifest.get("files", [])) >= 4, "manifest:output hashes", failures, checks)
    for item in manifest.get("files", []):
        file = OUT / item["file"]
        check(file.exists() and sha256(file) == item["sha256"] and file.stat().st_size == item["bytes"], f"manifest:match:{item['file']}", failures, checks)

    result = {
        "passed": not failures,
        "checks": len(checks),
        "failures": failures,
        "report": str(REPORT),
        "videoRows": 107 if VIDEO_CSV.exists() else 0,
        "evidenceRows": sum(1 for _ in EVIDENCE_CSV.open(encoding="utf-8")) - 1 if EVIDENCE_CSV.exists() else 0,
    }
    (OUT / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
