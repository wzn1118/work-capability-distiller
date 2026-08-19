#!/usr/bin/env python3
"""Build an internal, identifiable timeline appendix for repeat commenters.

This deliberately differs from the public-style aggregate report: the requested
appendix retains the supplied display nickname, Douyin profile URL, raw comment
text, and exact comment timestamp. It is therefore for internal analysis only.
"""

from __future__ import annotations

import csv
import hashlib
import html
import json
import math
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
OUT = ROOT / "output" / "wuhu-mkt-master-strategy-20260814"
SOURCE = Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\all-comments.csv")
PROFILES = OUT / "wuhu-mkt-multidimensional-anonymous-profiles.csv"
CODED = OUT / "wuhu-grounded-coded-comments.csv"
SUMMARY_CSV = OUT / "多次评论用户具名画像与时序.csv"
TIMELINE_CSV = OUT / "多次评论用户逐条评论时序明细.csv"
APPENDIX_HTML = OUT / "多次评论用户具名时序附录.html"
TEMPORAL_JSON = OUT / "wuhu-repeat-commenter-identified-temporal-analysis.json"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def clean(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def truth(value: Any) -> bool:
    return clean(value).lower() in {"true", "1", "yes", "是", "y"}


def integer(value: Any) -> int:
    try:
        return int(round(float(clean(value).replace(",", ""))))
    except ValueError:
        return 0


def parse_time(value: Any) -> datetime | None:
    text = clean(value)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    return None


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def anon_id(user_key: str) -> str:
    digest = hashlib.sha256(f"wuhu-multidim-v1\0{user_key}".encode("utf-8")).hexdigest()[:16]
    return f"aud_{digest}"


def fmt(value: float | int | None, digits: int = 1) -> str:
    if value is None:
        return "—"
    if isinstance(value, float) and not value.is_integer():
        return f"{value:,.{digits}f}"
    return f"{int(value):,}"


def pct(value: float | None, digits: int = 1) -> str:
    return "—" if value is None else f"{value * 100:.{digits}f}%"


def html_text(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def top_label(counter: Counter[str]) -> str:
    return counter.most_common(1)[0][0] if counter else ""


def chinese_weekday(value: datetime) -> str:
    return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][value.weekday()]


PROFILE_FLAGS = [
    "角色识别", "卡宝人格", "萌化情感", "严格玩家解码", "机制映射", "史事与设定",
    "关系共创", "投稿仪式", "周边兴趣", "严格购买表达", "价格敏感", "理解门槛",
    "内容边界", "叙事追问",
]


def build() -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    profiles = {clean(row.get("匿名受众ID")): row for row in read_csv(PROFILES)}
    coded = {clean(row.get("评论ID")): row for row in read_csv(CODED) if clean(row.get("评论ID"))}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for raw in read_csv(SOURCE):
        if truth(raw.get("是否视频作者")):
            continue
        profile_url = clean(raw.get("评论用户URL"))
        nickname = clean(raw.get("评论用户"))
        user_key = profile_url or f"name:{nickname}"
        if not user_key or user_key == "name:":
            continue
        coded_row = coded.get(clean(raw.get("评论ID")), {})
        time_text = clean(raw.get("评论时间"))
        grouped[user_key].append({
            "昵称": nickname,
            "主页": profile_url,
            "评论ID": clean(raw.get("评论ID")),
            "评论时间": time_text,
            "_time": parse_time(time_text),
            "评论内容": raw.get("评论内容") or "",
            "评论点赞数": integer(raw.get("评论点赞数")),
            "评论地点": clean(raw.get("评论地点")),
            "所属视频ID": clean(raw.get("所属视频ID")),
            "所属视频标题": raw.get("所属视频标题") or "",
            "所属视频URL": clean(raw.get("所属视频URL")),
            "回复层级": clean(raw.get("回复层级")),
            "关系类型": clean(raw.get("关系类型")),
            "父评论ID": clean(raw.get("父评论ID")),
            "视频作者是否回复": clean(raw.get("视频作者是否回复")),
            "评论图片URL": clean(raw.get("评论图片URL")),
            "开放编码": clean(coded_row.get("开放编码")),
            "主轴编码": clean(coded_row.get("主轴编码")),
            "参与深度": clean(coded_row.get("参与深度")),
        })

    summary_rows: list[dict[str, Any]] = []
    timeline_rows: list[dict[str, Any]] = []
    all_intervals: list[float] = []
    sessions_per_user: list[int] = []
    comments_per_session: list[float] = []
    event_hours, first_hours, weekdays = Counter(), Counter(), Counter()
    entry_months, active_months = Counter(), Counter()
    same_day_repeat_users = 0
    burst_3plus_users = 0

    for user_key, events in grouped.items():
        if len(events) < 2:
            continue
        events.sort(key=lambda row: (row["_time"] is None, row["_time"] or datetime.max, row["评论ID"]))
        profile = profiles.get(anon_id(user_key), {})
        known_times = [row["_time"] for row in events if row["_time"]]
        nicknames = Counter(row["昵称"] for row in events if row["昵称"])
        locations = Counter(row["评论地点"] for row in events if row["评论地点"])
        videos = {row["所属视频ID"] for row in events if row["所属视频ID"]}
        days = Counter(time.strftime("%Y-%m-%d") for time in known_times)
        if any(count >= 2 for count in days.values()):
            same_day_repeat_users += 1

        intervals: list[float] = []
        session_count = 0
        session_sizes: list[int] = []
        current_session_size = 0
        previous: datetime | None = None
        for when in known_times:
            gap = None if previous is None else (when - previous).total_seconds() / 3600
            # The interval distribution covers every adjacent observed comment.
            # Session boundaries remain a separate six-hour operational rule.
            if gap is not None and gap >= 0:
                intervals.append(gap)
                all_intervals.append(gap)
            if previous is None or gap is None or gap > 6:
                if current_session_size:
                    session_sizes.append(current_session_size)
                session_count += 1
                current_session_size = 1
            else:
                current_session_size += 1
            previous = when
        if current_session_size:
            session_sizes.append(current_session_size)
        sessions_per_user.append(session_count)
        comments_per_session.extend(session_sizes)
        if any(size >= 3 for size in session_sizes):
            burst_3plus_users += 1

        if known_times:
            first_time, last_time = known_times[0], known_times[-1]
            span_days = (last_time - first_time).total_seconds() / 86400
            event_hours.update(str(time.hour) for time in known_times)
            first_hours[str(first_time.hour)] += 1
            weekdays.update(chinese_weekday(time) for time in known_times)
            entry_months[first_time.strftime("%Y-%m")] += 1
            active_months.update(time.strftime("%Y-%m") for time in known_times)
        else:
            first_time = last_time = None
            span_days = 0.0

        root_count = sum(1 for row in events if not row["父评论ID"] or row["关系类型"] in {"根评论", "root", "根评"})
        max_like = max(events, key=lambda row: row["评论点赞数"])
        earliest = events[0]
        latest = events[-1]
        profile_flags = [flag for flag in PROFILE_FLAGS if truth(profile.get(flag))]
        summary = {
            "昵称（样本期常用）": top_label(nicknames),
            "主页": events[0]["主页"],
            "匿名受众ID": anon_id(user_key),
            "评论数": len(events),
            "涉及视频数": len(videos),
            "评论日期数": len(days),
            "会话数（相邻间隔>6小时断开）": session_count,
            "平均每会话评论数": round(len(events) / max(1, session_count), 3),
            "首评精确时间": first_time.strftime("%Y-%m-%d %H:%M:%S") if first_time else earliest["评论时间"],
            "二评精确时间": known_times[1].strftime("%Y-%m-%d %H:%M:%S") if len(known_times) >= 2 else "",
            "末评精确时间": last_time.strftime("%Y-%m-%d %H:%M:%S") if last_time else latest["评论时间"],
            "活跃跨度天": round(span_days, 3),
            "中位评论间隔小时": round(statistics.median(intervals), 3) if intervals else "",
            "P90评论间隔小时": round(percentile(intervals, .9) or 0, 3) if intervals else "",
            "根评论数": root_count,
            "回复评论数": len(events) - root_count,
            "累计点赞": sum(row["评论点赞数"] for row in events),
            "最高单评点赞": max_like["评论点赞数"],
            "主要评论地点标签": top_label(locations),
            "语境层": clean(profile.get("语境层")),
            "严格×萌化": clean(profile.get("严格×萌化")),
            "命中语境信号": " | ".join(profile_flags),
            "最早评论时间": earliest["评论时间"],
            "最早评论原文": earliest["评论内容"],
            "最高赞评论时间": max_like["评论时间"],
            "最高赞评论原文": max_like["评论内容"],
            "最新评论时间": latest["评论时间"],
            "最新评论原文": latest["评论内容"],
        }
        summary_rows.append(summary)
        for ordinal, event in enumerate(events, start=1):
            timeline_rows.append({
                "昵称": event["昵称"], "主页": event["主页"], "匿名受众ID": anon_id(user_key),
                "用户内评论序号": ordinal, "评论ID": event["评论ID"], "评论时间": event["评论时间"],
                "评论内容": event["评论内容"], "评论点赞数": event["评论点赞数"],
                "评论地点": event["评论地点"], "所属视频ID": event["所属视频ID"],
                "所属视频标题": event["所属视频标题"], "所属视频URL": event["所属视频URL"],
                "回复层级": event["回复层级"], "关系类型": event["关系类型"],
                "父评论ID": event["父评论ID"], "视频作者是否回复": event["视频作者是否回复"],
                "评论图片URL": event["评论图片URL"], "开放编码": event["开放编码"],
                "主轴编码": event["主轴编码"], "参与深度": event["参与深度"],
            })

    summary_rows.sort(key=lambda row: (-int(row["评论数"]), row["首评精确时间"]))
    timeline_rows.sort(key=lambda row: (row["评论时间"], row["匿名受众ID"], int(row["用户内评论序号"])))
    interval_buckets = {
        "≤1小时": sum(1 for gap in all_intervals if gap <= 1),
        "1–6小时": sum(1 for gap in all_intervals if 1 < gap <= 6),
        "6–24小时": sum(1 for gap in all_intervals if 6 < gap <= 24),
        "1–7天": sum(1 for gap in all_intervals if 24 < gap <= 7 * 24),
        "7–30天": sum(1 for gap in all_intervals if 7 * 24 < gap <= 30 * 24),
        ">30天": sum(1 for gap in all_intervals if gap > 30 * 24),
    }
    temporal = {
        "scope": {
            "repeatUsers": len(summary_rows), "repeatCommentEvents": len(timeline_rows),
            "definition": "非视频作者、同一评论用户主页URL在样本内至少两条评论；无主页时以昵称键作为回退。",
            "internalOnly": True,
            "identifiableFields": ["昵称", "主页", "原始评论内容", "精确评论时间"],
        },
        "intervals": {
            "n": len(all_intervals), "medianHours": statistics.median(all_intervals) if all_intervals else None,
            "p25Hours": percentile(all_intervals, .25), "p75Hours": percentile(all_intervals, .75),
            "p90Hours": percentile(all_intervals, .9), "buckets": interval_buckets,
            "bucketShares": {label: ratio(count, len(all_intervals)) for label, count in interval_buckets.items()},
        },
        "sessions": {
            "breakRule": "相邻评论间隔超过6小时视为新会话",
            "total": sum(sessions_per_user), "medianPerUser": statistics.median(sessions_per_user),
            "p90PerUser": percentile(sessions_per_user, .9), "averageCommentsPerSession": statistics.fmean(comments_per_session),
            "sameDayRepeatUsers": same_day_repeat_users, "sameDayRepeatRate": ratio(same_day_repeat_users, len(summary_rows)),
            "threePlusBurstUsers": burst_3plus_users, "threePlusBurstRate": ratio(burst_3plus_users, len(summary_rows)),
        },
        "eventHours": [{"label": hour, "count": count, "share": ratio(count, len(timeline_rows))} for hour, count in sorted(event_hours.items(), key=lambda item: int(item[0]))],
        "firstCommentHours": [{"label": hour, "count": count, "share": ratio(count, len(summary_rows))} for hour, count in sorted(first_hours.items(), key=lambda item: int(item[0]))],
        "weekdays": [{"label": day, "count": weekdays[day], "share": ratio(weekdays[day], len(timeline_rows))} for day in ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]],
        "entryMonths": [{"label": month, "count": count, "share": ratio(count, len(summary_rows))} for month, count in sorted(entry_months.items())],
        "activeEventMonths": [{"label": month, "count": count, "share": ratio(count, len(timeline_rows))} for month, count in sorted(active_months.items())],
        # Named examples are intentionally confined to the internal report and appendix.
        # They support auditability of the aggregate time findings without exposing all users in the main narrative.
        "topProfiles": summary_rows[:12],
        "longSpanProfiles": sorted(
            [row for row in summary_rows if float(row["活跃跨度天"] or 0) > 0],
            key=lambda row: (-float(row["活跃跨度天"]), -int(row["评论数"])),
        )[:12],
        "files": {"profileCsv": SUMMARY_CSV.name, "timelineCsv": TIMELINE_CSV.name, "htmlAppendix": APPENDIX_HTML.name},
    }
    return summary_rows, timeline_rows, temporal


def write_appendix_html(summary_rows: list[dict[str, Any]], timeline_rows: list[dict[str, Any]], temporal: dict[str, Any]) -> None:
    by_user: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in timeline_rows:
        by_user[row["匿名受众ID"]].append(row)
    cards = []
    for index, summary in enumerate(summary_rows, start=1):
        events = by_user[summary["匿名受众ID"]]
        search = " ".join([summary["昵称（样本期常用）"], summary["命中语境信号"], summary["语境层"], summary["严格×萌化"], *[event["评论内容"] for event in events]]).lower()
        rows = "".join(
            "<tr>"
            f"<td>{html_text(event['用户内评论序号'])}</td><td>{html_text(event['评论时间'])}</td>"
            f"<td>{html_text(event['所属视频标题'])}</td><td class=raw>{html_text(event['评论内容'])}</td>"
            f"<td>{html_text(event['评论点赞数'])}</td><td>{html_text(event['回复层级'])}</td>"
            f"<td>{html_text(event['开放编码'])}</td>"
            "</tr>" for event in events
        )
        profile = html_text(summary["主页"])
        cards.append(
            f"<details class=user data-search=\"{html_text(search)}\"><summary><b>{index:04d} · {html_text(summary['昵称（样本期常用）'])}</b>"
            f"<span>{html_text(summary['评论数'])}评 · {html_text(summary['涉及视频数'])}视频 · 首评 {html_text(summary['首评精确时间'])}</span></summary>"
            "<div class=meta>"
            f"<a href=\"{profile}\" target=\"_blank\" rel=\"noreferrer\">主页</a> <code>{profile}</code>"
            f"<span>二评：{html_text(summary['二评精确时间'])}</span><span>末评：{html_text(summary['末评精确时间'])}</span>"
            f"<span>跨度：{html_text(summary['活跃跨度天'])}天</span><span>会话：{html_text(summary['会话数（相邻间隔>6小时断开）'])}</span>"
            f"<span>语境：{html_text(summary['语境层'])} / {html_text(summary['严格×萌化'])}</span>"
            f"<span>信号：{html_text(summary['命中语境信号'])}</span></div>"
            f"<table><thead><tr><th>#</th><th>精确时间</th><th>视频</th><th>原始评论</th><th>赞</th><th>层级</th><th>开放编码</th></tr></thead><tbody>{rows}</tbody></table></details>"
        )
    headline = temporal["scope"]
    APPENDIX_HTML.write_text(f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>多次评论用户具名时序附录</title><style>
body{{margin:0;background:#f4f3ee;color:#28302e;font:14px/1.65 "Microsoft YaHei",Arial,sans-serif}}main{{max-width:1500px;margin:auto;padding:28px}}header{{background:#425653;color:#fff;padding:28px 32px}}h1{{margin:0 0 8px;font-size:28px}}header p{{margin:0;color:#d9e5e0}}.warning{{margin:18px 0;padding:14px 16px;border-left:4px solid #a6753e;background:#f5ede2}}input{{width:100%;padding:12px;border:1px solid #bdc8c2;font:inherit;margin:18px 0}}details{{background:#fff;border:1px solid #d8ddd8;margin:9px 0}}summary{{cursor:pointer;padding:14px 16px;display:flex;justify-content:space-between;gap:16px}}summary span{{color:#65706c;font-size:12px}}.meta{{padding:0 16px 14px;display:flex;gap:8px 16px;flex-wrap:wrap;color:#4e5c58;font-size:12px}}code{{word-break:break-all;color:#527f8e}}table{{border-collapse:collapse;width:100%;min-width:980px;font-size:12px}}th,td{{text-align:left;vertical-align:top;padding:8px 10px;border-top:1px solid #e5e8e3}}th{{background:#eef1ed}}td.raw{{white-space:pre-wrap;min-width:360px}}@media(max-width:700px){{main{{padding:12px}}header{{padding:20px}}summary{{display:block}}summary span{{display:block;margin-top:5px}}}}
</style></head><body><main><header><h1>多次评论用户具名时序附录</h1><p>{fmt(headline['repeatUsers'])} 位复评用户 · {fmt(headline['repeatCommentEvents'])} 条逐条评论 · 昵称、主页、原文与精确时间均保留</p></header><div class="warning"><strong>内部使用：</strong>本附录包含用户提供数据中的昵称、抖音主页、原始评论及精确评论时间。不得公开转载、二次分发或用于与本分析无关的用途。</div><input id="q" placeholder="搜索昵称、主页、原文、语境标签"><section id="users">{''.join(cards)}</section></main><script>const q=document.querySelector('#q');const rows=[...document.querySelectorAll('.user')];q.addEventListener('input',()=>{{const s=q.value.trim().toLowerCase();rows.forEach(x=>x.hidden=!!s&&!x.dataset.search.includes(s));}});</script></body></html>''', encoding="utf-8")


def main() -> None:
    summary_rows, timeline_rows, temporal = build()
    summary_fields = [
        "昵称（样本期常用）", "主页", "匿名受众ID", "评论数", "涉及视频数", "评论日期数",
        "会话数（相邻间隔>6小时断开）", "平均每会话评论数", "首评精确时间", "二评精确时间",
        "末评精确时间", "活跃跨度天", "中位评论间隔小时", "P90评论间隔小时", "根评论数", "回复评论数",
        "累计点赞", "最高单评点赞", "主要评论地点标签", "语境层", "严格×萌化", "命中语境信号",
        "最早评论时间", "最早评论原文", "最高赞评论时间", "最高赞评论原文", "最新评论时间", "最新评论原文",
    ]
    timeline_fields = [
        "昵称", "主页", "匿名受众ID", "用户内评论序号", "评论ID", "评论时间", "评论内容", "评论点赞数", "评论地点",
        "所属视频ID", "所属视频标题", "所属视频URL", "回复层级", "关系类型", "父评论ID", "视频作者是否回复",
        "评论图片URL", "开放编码", "主轴编码", "参与深度",
    ]
    write_csv(SUMMARY_CSV, summary_rows, summary_fields)
    write_csv(TIMELINE_CSV, timeline_rows, timeline_fields)
    write_appendix_html(summary_rows, timeline_rows, temporal)
    TEMPORAL_JSON.write_text(json.dumps(temporal, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": str(SUMMARY_CSV), "timeline": str(TIMELINE_CSV), "html": str(APPENDIX_HTML), "temporal": str(TEMPORAL_JSON), "users": len(summary_rows), "events": len(timeline_rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
