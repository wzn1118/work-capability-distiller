#!/usr/bin/env python3
"""Build an anonymous, reproducible background profile for repeat commenters.

The output describes observable comment behavior and textual context only. It
does not attempt to infer age, gender, occupation, income, or true fandom size.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
OUT = ROOT / "output" / "wuhu-mkt-master-strategy-20260814"
PROFILE_PATH = OUT / "wuhu-mkt-multidimensional-anonymous-profiles.csv"
CODED_PATH = OUT / "wuhu-grounded-coded-comments.csv"
SOURCE_COMMENTS = Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all\all-comments.csv")
JSON_PATH = OUT / "wuhu-repeat-commenter-background-analysis.json"
MD_PATH = OUT / "多次评论用户背景分析.md"


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def truth(value: Any) -> bool:
    return str(value).strip().lower() in {"true", "1", "yes", "是", "y"}


def number(value: Any, default: float = 0.0) -> float:
    try:
        return float(str(value).strip().replace(",", ""))
    except (TypeError, ValueError):
        return default


def integer(value: Any, default: int = 0) -> int:
    return int(round(number(value, default)))


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator else None


def anon_id(user_key: str) -> str:
    # The multidimensional profile export is the master user-level table and
    # uses this stable pseudonym namespace.
    digest = hashlib.sha256(f"wuhu-multidim-v1\0{user_key}".encode("utf-8")).hexdigest()[:16]
    return f"aud_{digest}"


def parse_time(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    text = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                pass
    return None


def clean_label(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def top_counter(counter: Counter[str], limit: int = 8) -> list[dict[str, Any]]:
    total = sum(counter.values())
    return [
        {"label": label, "count": count, "share": ratio(count, total)}
        for label, count in counter.most_common(limit)
        if label
    ]


FLAG_COLUMNS = {
    "角色识别": "角色识别",
    "卡宝人格": "卡宝人格",
    "萌化情感": "萌化情感",
    "严格玩家解码": "严格玩家解码",
    "机制映射": "机制映射",
    "史事与设定": "史事与设定",
    "关系共创": "关系共创",
    "投稿仪式": "投稿仪式",
    "周边兴趣": "周边兴趣",
    "严格购买表达": "严格购买表达",
    "价格敏感": "价格敏感",
    "理解门槛": "理解门槛",
    "内容边界": "内容边界",
    "叙事追问": "叙事追问",
}


def build() -> dict[str, Any]:
    profiles = read_csv(PROFILE_PATH)
    raw = read_csv(SOURCE_COMMENTS)
    coded = read_csv(CODED_PATH)
    by_id = {clean_label(row.get("评论ID")): row for row in coded if clean_label(row.get("评论ID"))}

    # Keep the raw join in memory only. The exported file contains aggregates,
    # labels, and anonymous IDs; it never writes text, URL, nickname, or time.
    raw_by_user: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "text_comments": 0,
            "all_comments": 0,
            "root_comments": 0,
            "reply_comments": 0,
            "likes": [],
            "text_lengths": [],
            "locations": Counter(),
            "hours": Counter(),
            "months": Counter(),
            "videos": set(),
            "codes": Counter(),
            "axes": Counter(),
            "depths": Counter(),
        }
    )
    for row in raw:
        if truth(row.get("是否视频作者")):
            continue
        user_key = clean_label(row.get("评论用户URL")) or f"name:{clean_label(row.get('评论用户'))}"
        if not user_key or user_key == "name:":
            continue
        item = raw_by_user[user_key]
        item["all_comments"] += 1
        relation = clean_label(row.get("关系类型"))
        if relation in {"根评论", "root", "根评"} or not clean_label(row.get("父评论ID")):
            item["root_comments"] += 1
        else:
            item["reply_comments"] += 1
        text = clean_label(row.get("评论内容"))
        if text:
            item["text_comments"] += 1
            item["text_lengths"].append(len(text))
        item["likes"].append(integer(row.get("评论点赞数")))
        location = clean_label(row.get("评论地点"))
        if location:
            item["locations"][location] += 1
        when = parse_time(row.get("评论时间", ""))
        if when:
            item["hours"][str(when.hour)] += 1
            item["months"][when.strftime("%Y-%m")] += 1
        video = clean_label(row.get("所属视频ID"))
        if video:
            item["videos"].add(video)
        coded_row = by_id.get(clean_label(row.get("评论ID")))
        if coded_row:
            code = clean_label(coded_row.get("开放编码"))
            axis = clean_label(coded_row.get("主轴编码"))
            depth = clean_label(coded_row.get("参与深度"))
            for token in (part.strip() for part in code.split("|")):
                if token:
                    item["codes"][token] += 1
            for token in (part.strip() for part in axis.split("|")):
                if token:
                    item["axes"][token] += 1
            if depth:
                item["depths"][depth] += 1

    raw_by_anon_id = {anon_id(user_key): values for user_key, values in raw_by_user.items()}
    # Join profile rows to raw aggregates by the same one-way anonymous key.
    users: list[dict[str, Any]] = []
    for profile in profiles:
        aid = clean_label(profile.get("匿名受众ID"))
        # Profiles are the authoritative user-level denominator. A missing raw
        # join can only affect optional style/location descriptors.
        raw_item = raw_by_anon_id.get(aid)
        if raw_item is None:
            raw_item = {
                "text_comments": integer(profile.get("文本评论数")),
                "all_comments": integer(profile.get("评论数")),
                "root_comments": integer(profile.get("根评论数")),
                "reply_comments": integer(profile.get("回复评论数")),
                "likes": [number(profile.get("总点赞"))],
                "text_lengths": [],
                "locations": Counter(),
                "hours": Counter(),
                "months": Counter(),
                "videos": set(),
                "codes": Counter(),
                "axes": Counter(),
                "depths": Counter(),
            }
        user = dict(profile)
        user["_raw"] = raw_item
        user["_text_comments"] = integer(profile.get("文本评论数"))
        users.append(user)

    text_users = [u for u in users if u["_text_comments"] > 0]
    text_comments = sum(u["_text_comments"] for u in text_users)
    audience_comments = sum(integer(u.get("评论数")) for u in users)

    def tier(user: dict[str, Any], column: str = "评论数") -> str:
        count = integer(user.get(column))
        if count <= 1:
            return "single"
        if count <= 3:
            return "2-3"
        if count <= 9:
            return "4-9"
        return "10+"

    def bool_rate(rows: list[dict[str, Any]], column: str) -> float | None:
        return ratio(sum(1 for row in rows if truth(row.get(column))), len(rows))

    def field_rate(rows: list[dict[str, Any]], column: str) -> dict[str, Any]:
        hits = sum(1 for row in rows if truth(row.get(column)))
        return {"users": hits, "rate": ratio(hits, len(rows))}

    def cohort_stats(
        rows: list[dict[str, Any]],
        label: str,
        frequency_column: str = "评论数",
        universe_users: list[dict[str, Any]] | None = None,
        universe_comments: int | None = None,
    ) -> dict[str, Any]:
        universe_users = universe_users if universe_users is not None else users
        activity_comments = [integer(u.get(frequency_column)) for u in rows]
        semantic_rows = [u for u in rows if u["_text_comments"] > 0]
        semantic_comments = sum(u["_text_comments"] for u in semantic_rows)
        videos = [integer(u.get("视频数")) for u in rows]
        spans = [number(u.get("活跃跨度天")) for u in rows]
        lag = [number(u.get("第二次互动时延小时")) for u in rows if u["_text_comments"] >= 2 and number(u.get("第二次互动时延小时")) > 0]
        likes = [x for u in rows for x in u["_raw"]["likes"]]
        text_lengths = [x for u in rows for x in u["_raw"]["text_lengths"]]
        total_roots = sum(u["_raw"]["root_comments"] for u in rows)
        total_replies = sum(u["_raw"]["reply_comments"] for u in rows)
        observed_7 = [u for u in rows if truth(u.get("可观测7日"))]
        observed_30 = [u for u in rows if truth(u.get("可观测30日"))]
        location_counts = Counter()
        dominant_location_users = Counter()
        hour_counts = Counter()
        month_counts = Counter()
        code_counts = Counter()
        axis_counts = Counter()
        depth_counts = Counter()
        for u in semantic_rows:
            location_counts.update(u["_raw"]["locations"])
            if u["_raw"]["locations"]:
                dominant_location_users[u["_raw"]["locations"].most_common(1)[0][0]] += 1
            hour_counts.update(u["_raw"]["hours"])
            month_counts.update(u["_raw"]["months"])
            code_counts.update(u["_raw"]["codes"])
            axis_counts.update(u["_raw"]["axes"])
            depth_counts.update(u["_raw"]["depths"])

        result: dict[str, Any] = {
            "label": label,
            "users": len(rows),
            "comments": sum(activity_comments),
            "textUsers": len(semantic_rows),
            "textComments": semantic_comments,
            "userShare": ratio(len(rows), len(universe_users)),
            "commentShare": ratio(sum(activity_comments), universe_comments or sum(activity_comments)),
            "textUserShareWithinCohort": ratio(len(semantic_rows), len(rows)),
            "avgComments": mean(activity_comments),
            "medianComments": median(activity_comments),
            "p90Comments": percentile(activity_comments, 0.90),
            "avgVideos": mean(videos),
            "medianVideos": median(videos),
            "avgActiveSpanDays": mean(spans),
            "medianActiveSpanDays": median(spans),
            "crossVideoRate": bool_rate(rows, "跨视频"),
            "cross7Rate": bool_rate(rows, "跨视频_大于7天"),
            "cross30Rate": bool_rate(rows, "跨视频_大于30天"),
            "observed7Rate": bool_rate(rows, "可观测7日"),
            "observed30Rate": bool_rate(rows, "可观测30日"),
            "stillComment7Rate": bool_rate(rows, "7日后仍评论"),
            "stillComment30Rate": bool_rate(rows, "30日后仍评论"),
            "stillComment7AmongObservedRate": bool_rate(observed_7, "7日后仍评论"),
            "stillComment30AmongObservedRate": bool_rate(observed_30, "30日后仍评论"),
            "continuedObservation": {
                "day7": {
                    "users": sum(1 for u in observed_7 if truth(u.get("7日后仍评论"))),
                    "denominator": len(observed_7),
                },
                "day30": {
                    "users": sum(1 for u in observed_30 if truth(u.get("30日后仍评论"))),
                    "denominator": len(observed_30),
                },
            },
            "secondLagHours": {
                "n": len(lag),
                "median": median(lag),
                "p75": percentile(lag, 0.75),
                "p90": percentile(lag, 0.90),
            },
            "likes": {
                "total": sum(likes),
                "avg": mean(likes),
                "median": median(likes),
                "p90": percentile(likes, 0.90),
                "zeroRate": ratio(sum(1 for x in likes if x == 0), len(likes)),
            },
            "textLength": {"n": len(text_lengths), "median": median(text_lengths), "p90": percentile(text_lengths, 0.90)},
            "threadShape": {
                "rootComments": total_roots,
                "replyComments": total_replies,
                "replyShare": ratio(total_replies, total_roots + total_replies),
            },
            "semanticDenominator": len(semantic_rows),
            "flags": {name: field_rate(semantic_rows, column) for name, column in FLAG_COLUMNS.items()},
            "contextLevels": top_counter(Counter(clean_label(u.get("语境层")) for u in semantic_rows), 8),
            "strictCute": top_counter(Counter(clean_label(u.get("严格×萌化")) for u in semantic_rows), 8),
            "frequencyLayers": top_counter(Counter(clean_label(u.get("互动频次层")) for u in rows), 8),
            "breadthLayers": top_counter(Counter(clean_label(u.get("视频广度层")) for u in rows), 8),
            "semanticAxes": top_counter(axis_counts, 10),
            "semanticCodes": top_counter(code_counts, 12),
            "participationDepth": top_counter(depth_counts, 8),
            "locationsByUser": top_counter(dominant_location_users, 8),
            "locationComments": top_counter(location_counts, 8),
            "hours": top_counter(hour_counts, 8),
            "timing": {
                "commentEvents": sum(hour_counts.values()),
                "noon12To13": {
                    "comments": sum(hour_counts[str(hour)] for hour in range(12, 14)),
                    "share": ratio(sum(hour_counts[str(hour)] for hour in range(12, 14)), sum(hour_counts.values())),
                },
                "evening18To22": {
                    "comments": sum(hour_counts[str(hour)] for hour in range(18, 23)),
                    "share": ratio(sum(hour_counts[str(hour)] for hour in range(18, 23)), sum(hour_counts.values())),
                },
                "evening18To23": {
                    "comments": sum(hour_counts[str(hour)] for hour in range(18, 24)),
                    "share": ratio(sum(hour_counts[str(hour)] for hour in range(18, 24)), sum(hour_counts.values())),
                },
            },
            "months": top_counter(month_counts, 8),
        }
        return result

    all_tiers = [
        cohort_stats([u for u in users if tier(u) == "single"], "单次评论", universe_comments=audience_comments),
        cohort_stats([u for u in users if tier(u) == "2-3"], "2–3次评论", universe_comments=audience_comments),
        cohort_stats([u for u in users if tier(u) == "4-9"], "4–9次评论", universe_comments=audience_comments),
        cohort_stats([u for u in users if tier(u) == "10+"], "10次以上评论", universe_comments=audience_comments),
    ]
    semantic_tiers = [
        cohort_stats([u for u in text_users if tier(u, "文本评论数") == "single"], "单次文本评论", "文本评论数", text_users, text_comments),
        cohort_stats([u for u in text_users if tier(u, "文本评论数") == "2-3"], "2–3次文本评论", "文本评论数", text_users, text_comments),
        cohort_stats([u for u in text_users if tier(u, "文本评论数") == "4-9"], "4–9次文本评论", "文本评论数", text_users, text_comments),
        cohort_stats([u for u in text_users if tier(u, "文本评论数") == "10+"], "10次以上文本评论", "文本评论数", text_users, text_comments),
    ]
    repeaters = [u for u in users if integer(u.get("评论数")) >= 2]
    high_repeaters = [u for u in users if integer(u.get("评论数")) >= 4]
    core_repeaters = [u for u in users if integer(u.get("评论数")) >= 10]

    # Four non-exclusive background hypotheses, defined by observed text codes.
    # They are deliberately labeled as behavioral proxies rather than identities.
    archetype_rules = {
        "圈内机制/考据型": ["严格玩家解码", "机制映射", "史事与设定", "理解门槛"],
        "角色萌化/收藏型": ["角色识别", "卡宝人格", "萌化情感", "周边兴趣", "严格购买表达"],
        "关系剧情/共创型": ["关系共创", "叙事追问", "内容边界"],
        "活动仪式/任务型": ["投稿仪式"],
    }
    archetypes = []
    for label, columns in archetype_rules.items():
        selected = [u for u in repeaters if any(truth(u.get(column)) for column in columns)]
        stats = cohort_stats(selected, label)
        stats["definition"] = "或命中：" + "、".join(columns)
        stats["overlapAllowed"] = True
        archetypes.append(stats)

    # An exclusive operational view avoids presenting overlapping flags as market size.
    exclusive = {
        "泛互动复评型": lambda u: not any(truth(u.get(column)) for column in ["严格玩家解码", "萌化情感", "卡宝人格", "关系共创", "投稿仪式"]),
        "机制可信度型": lambda u: truth(u.get("严格玩家解码")) and not any(truth(u.get(column)) for column in ["萌化情感", "卡宝人格", "关系共创"]),
        "萌化占有型": lambda u: any(truth(u.get(column)) for column in ["萌化情感", "卡宝人格", "周边兴趣"]) and not any(truth(u.get(column)) for column in ["严格玩家解码", "关系共创"]),
        "玩家×萌化混合核": lambda u: any(truth(u.get(column)) for column in ["严格玩家解码"]) and any(truth(u.get(column)) for column in ["萌化情感", "卡宝人格"]),
        "关系/共创种子": lambda u: truth(u.get("关系共创")) and not truth(u.get("投稿仪式")),
        "仪式参与者": lambda u: truth(u.get("投稿仪式")) and not any(truth(u.get(column)) for column in ["严格玩家解码", "萌化情感", "卡宝人格", "关系共创"]),
    }
    exclusive_segments = []
    assigned: set[str] = set()
    for label, rule in exclusive.items():
        selected = [u for u in repeaters if u["匿名受众ID"] not in assigned and rule(u)]
        assigned.update(u["匿名受众ID"] for u in selected)
        stats = cohort_stats(selected, label)
        stats["definition"] = "按顺序互斥分配；用户级语境代理，不是人口标签"
        exclusive_segments.append(stats)
    remainder = [u for u in repeaters if u["匿名受众ID"] not in assigned]
    if remainder:
        stats = cohort_stats(remainder, "其他复评型")
        stats["definition"] = "未进入前述互斥规则"
        exclusive_segments.append(stats)

    overall = cohort_stats(users, "全部评论用户", universe_comments=audience_comments)
    repeat = cohort_stats(repeaters, "所有多次评论用户", universe_comments=audience_comments)
    high = cohort_stats(high_repeaters, "4次以上评论用户", universe_comments=audience_comments)
    core = cohort_stats(core_repeaters, "10次以上评论用户", universe_comments=audience_comments)
    repeat_semantic = [u for u in repeaters if u["_text_comments"] > 0]
    repeat_semantic_comments = sum(u["_text_comments"] for u in repeat_semantic)
    strict_cute_repeat_cells = [
        cohort_stats(
            [u for u in repeat_semantic if clean_label(u.get("严格×萌化")) == label],
            label,
            "文本评论数",
            repeat_semantic,
            repeat_semantic_comments,
        )
        for label in ["二者皆无", "仅玩家", "仅萌化", "玩家×萌化"]
    ]

    # A compact answer for the report: which observable signals grow with depth.
    monotonic = []
    for field, label in [
        ("crossVideoRate", "跨视频评论"), ("cross7Rate", "跨视频且间隔超过7天"),
        ("avgVideos", "平均涉及视频数"), ("avgComments", "平均文本评论数"),
    ]:
        values = [row[field] for row in all_tiers]
        monotonic.append({"metric": label, "field": field, "values": values, "nonDecreasing": all((a or 0) <= (b or 0) for a, b in zip(values, values[1:]))})

    result = {
        "meta": {
            "generatedAt": datetime.now().astimezone().isoformat(),
            "source": str(SOURCE_COMMENTS),
            "profileSource": str(PROFILE_PATH),
            "codedSource": str(CODED_PATH),
            "audienceUsers": len(users),
            "textUsers": len(text_users),
            "textComments": text_comments,
            "repeatUsers": len(repeaters),
            "repeatUserRate": ratio(len(repeaters), len(users)),
            "repeatTextUsers": sum(1 for u in text_users if u["_text_comments"] >= 2),
            "repeatTextUserRate": ratio(sum(1 for u in text_users if u["_text_comments"] >= 2), len(text_users)),
            "definition": "多次评论用户=全量评论数至少2条；语境背景只在至少有1条文本评论的用户中计算。用户键沿用评论用户URL优先的稳定匿名ID；评论者不是完整粉丝或观看者样本。",
            "inferenceBoundary": "所有背景均为评论行为/文本语境代理，不推断年龄、性别、职业、收入、居住地或真实粉丝量。",
        },
        "overall": overall,
        "repeat": repeat,
        "highRepeat": high,
        "coreRepeat": core,
        "strictCuteRepeatCells": strict_cute_repeat_cells,
        "allTiers": all_tiers,
        "semanticTiers": semantic_tiers,
        "archetypes": archetypes,
        "exclusiveSegments": exclusive_segments,
        "monotonicSignals": monotonic,
        "methodNotes": [
            "用户频次使用文本评论数分层；空文本评论不用于语境背景，但仍保留在总体评论口径中。",
            "跨视频、活跃跨度、7/30日回访是样本内再次评论代理，不等于平台留存。",
            "地域仅保留评论地点的聚合标签；平台IP标签不等同真实常住地。",
            "语义标签允许重叠；互斥分段仅用于经营分配，不能替代用户真实身份。",
            "购买/周边是表达信号，不是订单、支付或消费能力。",
        ],
    }
    return result


def pct(value: float | None, digits: int = 1) -> str:
    return "—" if value is None else f"{value * 100:.{digits}f}%"


def num(value: float | int | None, digits: int = 1) -> str:
    if value is None:
        return "—"
    if isinstance(value, float) and not value.is_integer():
        return f"{value:,.{digits}f}"
    return f"{int(value):,}"


def markdown(data: dict[str, Any]) -> str:
    tiers = data["allTiers"]
    lines = [
        "# 多次评论用户背景分析",
        "",
        f"> 这是基于评论行为和文本语境的用户背景代理分析，不是人口统计画像。多次评论定义为全量评论至少 2 条：评论用户 {num(data['meta']['audienceUsers'])} 人，其中多次评论 {num(data['meta']['repeatUsers'])} 人（{pct(data['meta']['repeatUserRate'])}）。语境标签仅在有文本的用户中计算：文本评论用户 {num(data['meta']['textUsers'])} 人，其中多次文本评论 {num(data['meta']['repeatTextUsers'])} 人（{pct(data['meta']['repeatTextUserRate'])}）。",
        "",
        "## 一句话结论",
        "",
        f"多次评论用户不是单纯‘更爱点赞的人’，而是更可能把账号当成连续叙事和社群入口的人：他们平均留下 {num(data['repeat']['avgComments'], 2)} 条评论、涉及 {num(data['repeat']['avgVideos'], 2)} 个视频，{pct(data['repeat']['crossVideoRate'])} 跨视频参与，{pct(data['repeat']['cross7Rate'])} 的可见活动跨度超过 7 天。在具文本的多次评论用户中，最深的背景分化是：硬核玩家语境更接近内容可信度与复访代理，角色/萌化语境更接近周边与购买表达；两者同时出现的混合核，才是最值得经营的种子层。",
        "",
        "## 频次分层",
        "",
        "|层级|用户|评论|评论贡献|平均评论|平均视频|跨视频|跨视频>7天|周边兴趣|购买表达|",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in tiers:
        lines.append(f"|{row['label']}|{num(row['users'])}|{num(row['comments'])}|{pct(row['commentShare'])}|{num(row['avgComments'],2)}|{num(row['avgVideos'],2)}|{pct(row['crossVideoRate'])}|{pct(row['cross7Rate'])}|{pct(row['flags']['周边兴趣']['rate'])}|{pct(row['flags']['严格购买表达']['rate'])}|")
    lines.extend([
        "",
        "解释：10次以上评论用户只占文本用户的一小部分，却贡献明显更高的评论量；这类人适合做投票、共创、内测和关系维护，不适合被当作全体受众平均值。购买表达随频次层上升，但这是观察关联，受内容机会、活动触达和自选择影响。",
        "",
        "## 可观测的五类背景",
        "",
    ])
    archetype_copy = {
        "圈内机制/考据型": "会调用表字、技能、机制、史事或设定核验来参与；更像‘可信度审查+圈内翻译器’，商业表达不一定高，但适合承接深度剧情和世界观。",
        "角色萌化/收藏型": "用角色点名、卡宝人格、可爱/萌化、周边和实体化语言参与；更接近‘情感占有+商品想象’，是玩偶、挂件、表情包概念测试的主要入口。",
        "关系剧情/共创型": "关注双人关系、续作、投稿、剧情走向或角色互动；评论不是单向评价，而是给账号布置下一集任务。",
        "活动仪式/任务型": "集中出现在to签、投稿、固定话术或奖励机制里；可以贡献评论量和短期复访，但不能直接当作自然粉丝或购买漏斗。",
    }
    for row in data["archetypes"]:
        lines.append(f"### {row['label']}")
        lines.append(f"- 观测规模：{num(row['users'])} 位多次评论用户；其中有文本可判别语境者 {num(row['semanticDenominator'])} 人；平均 {num(row['avgComments'],2)} 条评论、涉及 {num(row['avgVideos'],2)} 个视频；跨视频 {pct(row['crossVideoRate'])}；跨视频且超过7天 {pct(row['cross7Rate'])}。")
        lines.append(f"- 语境信号（文本用户分母）：周边 {pct(row['flags']['周边兴趣']['rate'])}，严格购买表达 {pct(row['flags']['严格购买表达']['rate'])}，严格玩家解码 {pct(row['flags']['严格玩家解码']['rate'])}，关系共创 {pct(row['flags']['关系共创']['rate'])}。")
        lines.append(f"- MKT解释：{archetype_copy[row['label']]}")
        lines.append("")
    lines.extend([
        "## 最重要的经营分叉",
        "",
        "1. **复评深度与商品意向不是同一条轴。** 频次越高，跨视频和活跃跨度越强；但最硬核的玩家语境并不自动对应最高购买表达。内容要把机制可信度、角色情感和可拥有物拆成不同任务。",
        "2. **多次评论者更像‘账号叙事订阅者’，不一定只追一个角色。** 迁移分析显示，跨视频用户经常更换具名阵容，不能把复评用户简单归为某个角色粉丝或CP粉。更合理的假设是他们认同卡宝的叙事语法、玩梗方式和关系推进。",
        "3. **多次评论者是可经营的社群节点，但不是完整粉丝人口。** 他们贡献高密度评论和提案，适合建立周榜、投票、采纳公示、首发内测；效果必须用后续跨视频评论、有效提案和商品概念行动验证。",
        "",
        "## 建议动作",
        "",
        "- 对 2–3 次用户：用下一集悬念、明确问题和角色投票，目标是把偶发反应变成第二次跨视频评论。",
        "- 对 4–9 次用户：提供投稿池、机制解释、关系线选择和热评二创，目标是提高跨视频跨度与有效共创。",
        "- 对 10 次以上用户：建立小规模种子群候选，做剧情内测、角色/关系概念测试和价格敏感度测试；不以评论量直接换算订单。",
        "- 对硬核玩家：每条机制梗配一句白话字幕；对萌化用户：把‘可爱’转成尺寸、材质、使用场景和预约行动；对关系共创者：用开放结尾和采纳回执。",
        "- 把作者回复做成分层随机实验，而不是把已回复用户的高复评率写成回复导致效果。",
        "",
        "## 边界",
        "",
        "- 评论者不是播放者、关注者或成交者；数据没有年龄、性别、职业、收入、真实居住地、播放、完播、收藏、分享和订单字段。",
        "- ‘背景’指可观测的评论行为与文化语境代理；地域只保留聚合后的评论IP标签，不能外推常住地。",
        "- 语义标签可重叠；不同背景是经营任务，不是互斥的人口学分类。",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    data = build()
    JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    MD_PATH.write_text(markdown(data), encoding="utf-8")
    print(json.dumps({"json": str(JSON_PATH), "markdown": str(MD_PATH), "repeatUsers": data["meta"]["repeatUsers"], "tiers": [(row["label"], row["users"]) for row in data["allTiers"]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
