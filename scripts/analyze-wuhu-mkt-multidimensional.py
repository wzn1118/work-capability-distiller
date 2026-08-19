from __future__ import annotations

import csv
import hashlib
import json
import math
import random
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean, median

import numpy as np
import pandas as pd


ROOT = Path(r"C:\Users\10847\Documents\MKT大师")
SOURCE_DIR = Path(r"E:\kolforge-data\manual-douyin\20260813-sanguosha-wuhu-all")
CODED_PATH = ROOT / "output" / "wuhu-grounded-player-context-20260813" / "wuhu-grounded-coded-comments.csv"
OUT_DIR = ROOT / "output" / "wuhu-mkt-multidimensional-audience-20260814"
RAW_PATH = SOURCE_DIR / "all-comments.csv"
VIDEO_PATH = SOURCE_DIR / "videos-summary.csv"
DAY_SECONDS = 86400

STRICT_CODES = {
    "courtesy_nickname",
    "mechanic_remap_validation",
    "game_economy_memory",
    "historical_intertext",
    "canon_audit",
    "voice_line_callback",
    "interpretive_explanation",
}
CO_CREATION_CODES = {
    "relationship_shipping",
    "tragic_repair",
    "protective_care",
    "role_address_play",
    "continuation_request",
}
CODE_GROUPS = {
    "角色识别": {"character_recognition", "courtesy_nickname"},
    "卡宝人格": {"mascot_persona_reference", "mascot_identity_question"},
    "萌化情感": {"cute_infantilization", "protective_care", "mascot_identity_question"},
    "严格玩家解码": STRICT_CODES,
    "机制映射": {"mechanic_remap_validation"},
    "史事与设定": {"historical_intertext", "canon_audit", "interpretive_explanation", "voice_line_callback"},
    "关系共创": CO_CREATION_CODES,
    "投稿仪式": {"tosign_ritual", "submission_ritual"},
    "周边兴趣": {"merchandise_intent"},
    "严格购买表达": {"strict_purchase_intent"},
    "价格敏感": {"price_sensitivity"},
    "理解门槛": {"knowledge_threshold_question", "outsider_self_identification", "accessibility_request"},
    "内容边界": {"content_boundary_rejection", "counter_shipping", "ai_quality_rights"},
    "叙事追问": {"narrative_interaction_question", "continuation_request"},
}
PURCHASE_CATEGORIES = {
    "玩偶/娃娃": re.compile(r"玩偶|娃娃"),
    "泛周边": re.compile(r"周边"),
    "毛绒/挂件": re.compile(r"毛绒|挂件"),
    "表情包": re.compile(r"表情包"),
    "手办": re.compile(r"手办"),
    "公仔": re.compile(r"公仔"),
    "盲盒": re.compile(r"盲盒"),
}


def to_bool(value: object) -> bool:
    return str(value).strip().lower() == "true"


def to_number(value: object) -> float:
    text = str(value if value is not None else "").replace(",", "").replace("'", "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def parse_dt(value: object):
    text = str(value if value is not None else "")
    match = re.search(r"(20\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?", text)
    if not match:
        return pd.NaT
    year, month, day, hour, minute, second = match.groups(default="00")
    return pd.Timestamp(f"{year}-{month}-{day} {hour}:{minute}:{second}", tz="Asia/Shanghai")


def split_codes(value: object) -> set[str]:
    return {part for part in str(value if value is not None else "").split("|") if part}


def stable_id(value: str) -> str:
    return "aud_" + hashlib.sha256(("wuhu-multidim-v1\0" + value).encode("utf-8")).hexdigest()[:16]


def q(values, probability: float) -> float:
    if not values:
        return 0.0
    return float(np.quantile(np.asarray(values, dtype=float), probability, method="linear"))


def r(value: float, digits: int = 6) -> float:
    if value is None or not math.isfinite(float(value)):
        return 0.0
    return round(float(value), digits)


def safe_rate(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def gini(values) -> float:
    arr = np.sort(np.asarray([max(0, float(v)) for v in values], dtype=float))
    if len(arr) == 0 or arr.sum() == 0:
        return 0.0
    n = len(arr)
    return float((2 * np.sum((np.arange(1, n + 1)) * arr) / (n * arr.sum())) - (n + 1) / n)


def hhi(values) -> float:
    arr = np.asarray([max(0, float(v)) for v in values], dtype=float)
    if len(arr) == 0 or arr.sum() == 0:
        return 0.0
    shares = arr / arr.sum()
    return float(np.sum(shares**2))


def shannon_entropy(values) -> float:
    arr = np.asarray([max(0, float(v)) for v in values], dtype=float)
    if len(arr) == 0 or arr.sum() == 0:
        return 0.0
    p = arr[arr > 0] / arr.sum()
    return float(-np.sum(p * np.log2(p)))


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total == 0:
        return (0.0, 0.0)
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
    return (max(0.0, center - half), min(1.0, center + half))


def bootstrap_interval(values, statistic=np.mean, iterations: int = 1200, seed: int = 20260814) -> tuple[float, float]:
    arr = np.asarray(values, dtype=float)
    if len(arr) == 0:
        return (0.0, 0.0)
    rng = np.random.default_rng(seed)
    samples = np.empty(iterations)
    for index in range(iterations):
        samples[index] = statistic(rng.choice(arr, size=len(arr), replace=True))
    return (float(np.quantile(samples, 0.025)), float(np.quantile(samples, 0.975)))


def contingency_effect(a: int, b: int, c: int, d: int) -> dict:
    # Rows: exposed/unexposed; columns: outcome/no outcome.
    p_exposed = safe_rate(a, a + b)
    p_unexposed = safe_rate(c, c + d)
    rr = safe_rate(p_exposed, p_unexposed) if p_unexposed else None
    odds_exposed = safe_rate(a, b)
    odds_unexposed = safe_rate(c, d)
    odds_ratio = safe_rate(odds_exposed, odds_unexposed) if odds_unexposed else None
    return {
        "a_exposed_outcome": a,
        "b_exposed_no_outcome": b,
        "c_unexposed_outcome": c,
        "d_unexposed_no_outcome": d,
        "exposed_rate": r(p_exposed),
        "unexposed_rate": r(p_unexposed),
        "risk_difference": r(p_exposed - p_unexposed),
        "risk_ratio": r(rr) if rr is not None else None,
        "odds_ratio": r(odds_ratio) if odds_ratio is not None else None,
        "exposed_wilson_95": [r(x) for x in wilson_interval(a, a + b)],
        "unexposed_wilson_95": [r(x) for x in wilson_interval(c, c + d)],
    }


def cramers_v(matrix: np.ndarray) -> float:
    observed = np.asarray(matrix, dtype=float)
    total = observed.sum()
    if total == 0 or min(observed.shape) <= 1:
        return 0.0
    expected = np.outer(observed.sum(axis=1), observed.sum(axis=0)) / total
    mask = expected > 0
    chi2 = np.sum(((observed - expected) ** 2 / np.where(mask, expected, 1))[mask])
    phi2 = chi2 / total
    r_count, c_count = observed.shape
    denominator = min(c_count - 1, r_count - 1)
    return float(math.sqrt(phi2 / denominator)) if denominator else 0.0


def spearman(x, y) -> float:
    if len(x) < 3:
        return 0.0
    x_rank = pd.Series(x).rank(method="average").to_numpy()
    y_rank = pd.Series(y).rank(method="average").to_numpy()
    if np.std(x_rank) == 0 or np.std(y_rank) == 0:
        return 0.0
    return float(np.corrcoef(x_rank, y_rank)[0, 1])


def mantel_haenszel_or(strata: list[tuple[int, int, int, int]]) -> float | None:
    numerator = 0.0
    denominator = 0.0
    for a, b, c, d in strata:
        n = a + b + c + d
        if n == 0:
            continue
        numerator += a * d / n
        denominator += b * c / n
    return r(numerator / denominator) if denominator else None


class Metrics:
    def __init__(self):
        self.rows: list[dict] = []

    def add(self, metric_id: str, module: str, metric: str, value, unit: str, method: str,
            denominator: str, interpretation: str, boundary: str = ""):
        if isinstance(value, (np.floating, np.integer)):
            value = value.item()
        if isinstance(value, float):
            value = r(value)
        self.rows.append({
            "指标ID": metric_id,
            "模块": module,
            "指标": metric,
            "数值": value,
            "单位": unit,
            "统计方法": method,
            "分母/样本": denominator,
            "经营解释": interpretation,
            "边界": boundary,
        })


def user_level(row: pd.Series) -> str:
    strict = bool(row["严格玩家解码"])
    cute = bool(row["萌化情感"])
    organic = bool(row["关系共创"])
    general = bool(row["叙事追问"] or row["理解门槛"] or row["内容边界"])
    if organic:
        return "L4 有机共创"
    if strict:
        return "L3 严格玩家解码"
    if bool(row["角色识别"] or row["卡宝人格"] or cute):
        return "L2 角色/萌化身份"
    # L1 captures any remaining coded text interaction after the deeper layers
    # have been assigned. This keeps L0 as genuinely uncoded text interaction.
    if general or int(row["编码丰富度"]) > 0:
        return "L1 其他已编码表达"
    return "L0 未编码互动"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = pd.read_csv(RAW_PATH, encoding="utf-8-sig", dtype=str, keep_default_na=False)
    coded = pd.read_csv(CODED_PATH, encoding="utf-8-sig", dtype=str, keep_default_na=False)
    video = pd.read_csv(VIDEO_PATH, encoding="utf-8-sig", dtype=str, keep_default_na=False)
    coded = coded.rename(columns={"评论ID": "评论ID_join", "评论内容(去标识)": "文本去标识"})
    raw["评论ID_join"] = raw["评论ID"].astype(str)
    df = raw.merge(coded[["评论ID_join", "文本去标识", "开放编码", "主轴编码", "参与深度"]], on="评论ID_join", how="left", validate="one_to_one")
    df["开放编码"] = df["开放编码"].fillna("")
    df["文本去标识"] = df["文本去标识"].fillna("").astype(str).str.strip()
    df["日期"] = df["评论时间"].map(parse_dt)
    df["点赞"] = df["评论点赞数"].map(to_number).astype(int)
    df["是否作者_bool"] = df["是否视频作者"].map(to_bool)
    df["是否作者回复_bool"] = df["视频作者是否回复"].map(to_bool)
    df["用户键"] = df["评论用户URL"].astype(str).str.strip()
    missing_user = df["用户键"].eq("")
    df.loc[missing_user, "用户键"] = "name:" + df.loc[missing_user, "评论用户"].astype(str).str.strip()
    audience = df[(~df["是否作者_bool"]) & df["用户键"].ne("") & df["日期"].notna()].copy()
    audience["文本存在"] = audience["文本去标识"].ne("")
    # Keep the parsed code set on the event table because user-level aggregation
    # starts from all audience events and then filters to text-bearing events.
    audience["codes"] = audience["开放编码"].map(split_codes)
    audience_text = audience[audience["文本存在"]].copy()
    audience["匿名受众ID"] = audience["用户键"].map(stable_id)
    audience_text["匿名受众ID"] = audience_text["用户键"].map(stable_id)
    audience["日"] = audience["日期"].dt.strftime("%Y-%m-%d")
    audience["小时"] = audience["日期"].dt.hour
    audience_text["日"] = audience_text["日期"].dt.strftime("%Y-%m-%d")
    audience_text["小时"] = audience_text["日期"].dt.hour

    metrics = Metrics()
    total_captured = len(df)
    declared = sum(pd.to_numeric(video.get("声明评论数", pd.Series(dtype=str)), errors="coerce").fillna(0))
    unique_comment_ids = df["评论ID"].nunique()
    audience_users = audience["用户键"].nunique()
    text_users = audience_text["用户键"].nunique()
    text_comments = len(audience_text)
    max_time = audience["日期"].max()
    min_time = audience["日期"].min()
    root_comments = int((audience["关系类型"] == "根评论").sum())
    reply_comments = len(audience) - root_comments

    # 01 data quality and basis: 13 atomic metrics.
    metrics.add("D01", "数据基础", "视频汇总样本数", int(len(video)), "条", "COUNT", "videos-summary.csv", "内容样本规模，含零评论视频")
    metrics.add("D02", "数据基础", "声明评论数", int(declared), "条", "COUNT", "视频汇总声明", "采集覆盖分母")
    metrics.add("D03", "数据基础", "采集评论数", total_captured, "条", "COUNT", "全量评论表", "当前可见语料规模")
    metrics.add("D04", "数据基础", "评论采集覆盖率", safe_rate(total_captured, declared), "比例", "RATE", f"{total_captured}/{int(declared)}", "结论仅代表当前采集可见语料", "不是平台全量评论")
    metrics.add("D05", "数据基础", "非作者评论", len(audience), "条", "COUNT", "去除作者且时间可解析", "观众互动行")
    metrics.add("D06", "数据基础", "非作者评论用户", audience_users, "人", "DISTINCT COUNT", "评论用户URL优先", "观察到的评论者，不等于粉丝总量")
    metrics.add("D07", "数据基础", "有文本非作者评论", text_comments, "条", "COUNT", "去空文本", "语义分析分子")
    metrics.add("D08", "数据基础", "有文本评论用户", text_users, "人", "DISTINCT COUNT", "有文本非作者评论", "语义与语境分析用户分母")
    metrics.add("D09", "数据基础", "文本可用率", safe_rate(text_comments, len(audience)), "比例", "RATE", f"{text_comments}/{len(audience)}", "图片/空评不进入文本编码")
    metrics.add("D10", "数据基础", "作者评论占全量比例", safe_rate(int(df["是否作者_bool"].sum()), total_captured), "比例", "RATE", f"{int(df['是否作者_bool'].sum())}/{total_captured}", "排除作者后观测用户行为")
    metrics.add("D11", "数据基础", "根评论占比", safe_rate(root_comments, len(audience)), "比例", "RATE", f"{root_comments}/{len(audience)}", "主发言入口结构")
    metrics.add("D12", "数据基础", "回复评论占比", safe_rate(reply_comments, len(audience)), "比例", "RATE", f"{reply_comments}/{len(audience)}", "对话式参与结构")
    metrics.add("D13", "数据基础", "评论ID唯一率", safe_rate(unique_comment_ids, total_captured), "比例", "ID完整性检查", f"{unique_comment_ids}/{total_captured}", "重复ID会扭曲互动计数")

    # Build user table across all observable audience interactions.
    user_rows = []
    global_codes = sorted({code for codes in audience_text["codes"] for code in codes})
    for user_key, events in audience.groupby("用户键", sort=False):
        events = events.sort_values(["日期", "评论ID"], kind="stable")
        texts = events[events["文本存在"]].copy()
        text_codes = [codes for codes in texts["codes"]] if len(texts) else []
        union_codes = set().union(*text_codes) if text_codes else set()
        first_text = texts.iloc[0] if len(texts) else None
        first_all = events.iloc[0]
        last_all = events.iloc[-1]
        first_root = events[events["关系类型"] == "根评论"]
        first_root_reply = bool(len(first_root) and bool(first_root.iloc[0]["是否作者回复_bool"]))
        comment_count = len(events)
        text_count = len(texts)
        video_count = events["所属视频ID"].nunique()
        day_count = events["日"].nunique()
        duration_days = (last_all["日期"] - first_all["日期"]).total_seconds() / DAY_SECONDS
        second_lag_hours = ((events.iloc[1]["日期"] - events.iloc[0]["日期"]).total_seconds() / 3600) if comment_count >= 2 else np.nan
        last_lag_days = duration_days
        root_count = int((events["关系类型"] == "根评论").sum())
        reply_count = comment_count - root_count
        codes_richness = len(union_codes)
        data = {
            "匿名受众ID": stable_id(user_key),
            "评论数": comment_count,
            "文本评论数": text_count,
            "视频数": video_count,
            "活跃天数": day_count,
            "活跃跨度天": duration_days,
            "第二次互动时延小时": second_lag_hours,
            "总点赞": int(events["点赞"].sum()),
            "平均单评赞": float(events["点赞"].mean()),
            "根评论数": root_count,
            "回复评论数": reply_count,
            "根评占比": safe_rate(root_count, comment_count),
            "首触为根评": first_all["关系类型"] == "根评论",
            "首根评有作者回复标记": first_root_reply,
            "首触小时": int(first_all["小时"]),
            "首触月份": first_all["日期"].strftime("%Y-%m"),
            "首触视频ID": str(first_all["所属视频ID"]),
            "跨视频": video_count >= 2,
            "跨视频且多日": video_count >= 2 and day_count >= 2,
            "跨视频_大于7天": video_count >= 2 and duration_days > 7,
            "跨视频_大于30天": video_count >= 2 and duration_days > 30,
            "可观测7日": (max_time - first_all["日期"]).total_seconds() >= 7 * DAY_SECONDS,
            "可观测30日": (max_time - first_all["日期"]).total_seconds() >= 30 * DAY_SECONDS,
            "7日后仍评论": any((events["日期"] - first_all["日期"]).dt.total_seconds() >= 7 * DAY_SECONDS),
            "30日后仍评论": any((events["日期"] - first_all["日期"]).dt.total_seconds() >= 30 * DAY_SECONDS),
            "编码丰富度": codes_richness,
            "首次文本状态": "无文本" if first_text is None else "有文本",
        }
        for label, code_set in CODE_GROUPS.items():
            data[label] = bool(union_codes & code_set)
        user_rows.append(data)
    users = pd.DataFrame(user_rows)
    users["语境层"] = users.apply(user_level, axis=1)
    users["严格×萌化"] = np.select(
        [users["严格玩家解码"] & users["萌化情感"], users["严格玩家解码"], users["萌化情感"]],
        ["玩家×萌化", "仅玩家", "仅萌化"],
        default="二者皆无",
    )
    users["互动频次层"] = pd.cut(users["评论数"], bins=[0, 1, 3, 9, np.inf], labels=["1次", "2-3次", "4-9次", "10次以上"], include_lowest=True).astype(str)
    users["视频广度层"] = pd.cut(users["视频数"], bins=[0, 1, 2, 5, 10, np.inf], labels=["1条", "2条", "3-5条", "6-10条", "11条以上"], include_lowest=True).astype(str)
    # Semantic segments have a text-user denominator. Keep the full users table
    # for behavioral metrics, but never mix its no-text rows into text semantics.
    semantic_users = users[users["文本评论数"] > 0].copy()
    if len(semantic_users) != text_users:
        raise ValueError(f"Text-user denominator mismatch: {len(semantic_users)} != {text_users}")

    # 02 user intensity & concentration: 15 metrics.
    counts = users["评论数"].tolist()
    videos_per_user = users["视频数"].tolist()
    top1_n = max(1, math.ceil(len(users) * 0.01))
    top10_n = max(1, math.ceil(len(users) * 0.10))
    sorted_counts = sorted(counts, reverse=True)
    metrics.add("U01", "用户活跃强度", "人均评论数", mean(counts), "条/人", "MEAN", f"{audience_users}位评论用户", "均值受重度用户影响")
    metrics.add("U02", "用户活跃强度", "评论数中位数", median(counts), "条/人", "MEDIAN", f"{audience_users}位评论用户", "典型评论者互动强度")
    metrics.add("U03", "用户活跃强度", "评论数P25", q(counts, .25), "条/人", "QUANTILE", f"{audience_users}位评论用户", "低频互动边界")
    metrics.add("U04", "用户活跃强度", "评论数P75", q(counts, .75), "条/人", "QUANTILE", f"{audience_users}位评论用户", "高频互动起点")
    metrics.add("U05", "用户活跃强度", "评论数P90", q(counts, .90), "条/人", "QUANTILE", f"{audience_users}位评论用户", "核心用户阈值参考")
    metrics.add("U06", "用户活跃强度", "评论数P95", q(counts, .95), "条/人", "QUANTILE", f"{audience_users}位评论用户", "高活跃尾部")
    metrics.add("U07", "用户活跃强度", "评论数P99", q(counts, .99), "条/人", "QUANTILE", f"{audience_users}位评论用户", "极重度尾部")
    metrics.add("U08", "用户活跃强度", "评论数最大值", max(counts), "条/人", "MAX", f"{audience_users}位评论用户", "单个极端用户，不可代表总体")
    metrics.add("U09", "用户活跃强度", "至少2次评论用户占比", safe_rate(int((users['评论数'] >= 2).sum()), audience_users), "比例", "RATE", f"{int((users['评论数'] >= 2).sum())}/{audience_users}", "重复互动广度")
    metrics.add("U10", "用户活跃强度", "至少4次评论用户占比", safe_rate(int((users['评论数'] >= 4).sum()), audience_users), "比例", "RATE", f"{int((users['评论数'] >= 4).sum())}/{audience_users}", "活跃核心规模")
    metrics.add("U11", "用户活跃强度", "Top 1%用户贡献评论占比", safe_rate(sum(sorted_counts[:top1_n]), sum(counts)), "比例", "TOP-SHARE", f"前{top1_n}人/{audience_users}人", "互动集中度")
    metrics.add("U12", "用户活跃强度", "Top 10%用户贡献评论占比", safe_rate(sum(sorted_counts[:top10_n]), sum(counts)), "比例", "TOP-SHARE", f"前{top10_n}人/{audience_users}人", "运营不可只依赖少数重度用户")
    metrics.add("U13", "用户活跃强度", "评论贡献Gini", gini(counts), "系数", "GINI", f"{audience_users}位评论用户", "0为均等，越高越集中")
    metrics.add("U14", "用户活跃强度", "评论贡献HHI", hhi(counts), "指数", "HHI", f"{audience_users}位评论用户", "可换算有效贡献者数量")
    metrics.add("U15", "用户活跃强度", "有效评论贡献者数", safe_rate(1, hhi(counts)), "人", "1/HHI", f"{audience_users}位评论用户", "等效均匀贡献用户数")
    metrics.add("U16", "用户活跃强度", "人均跨视频数", mean(videos_per_user), "条/人", "MEAN", f"{audience_users}位评论用户", "评论行为触及的视频广度")
    metrics.add("U17", "用户活跃强度", "视频数中位数", median(videos_per_user), "条/人", "MEDIAN", f"{audience_users}位评论用户", "典型评论者视频广度")

    # 03 likes: 14 metrics.
    likes = audience["点赞"].tolist()
    root_likes = audience.loc[audience["关系类型"] == "根评论", "点赞"].tolist()
    reply_likes = audience.loc[audience["关系类型"] != "根评论", "点赞"].tolist()
    sorted_likes = sorted(likes, reverse=True)
    top_like_1 = max(1, math.ceil(len(likes) * .01))
    top_like_5 = max(1, math.ceil(len(likes) * .05))
    metrics.add("L01", "评论获赞分布", "观众评论总点赞", int(sum(likes)), "赞", "SUM", f"{len(audience)}条非作者评论", "互动认可总量")
    metrics.add("L02", "评论获赞分布", "单评平均点赞", mean(likes), "赞/评", "MEAN", f"{len(audience)}条非作者评论", "重尾分布下应与中位数并读")
    metrics.add("L03", "评论获赞分布", "单评点赞中位数", median(likes), "赞/评", "MEDIAN", f"{len(audience)}条非作者评论", "典型评论曝光认可")
    metrics.add("L04", "评论获赞分布", "单评点赞P90", q(likes, .90), "赞/评", "QUANTILE", f"{len(audience)}条非作者评论", "高认可评论门槛")
    metrics.add("L05", "评论获赞分布", "单评点赞P95", q(likes, .95), "赞/评", "QUANTILE", f"{len(audience)}条非作者评论", "热评尾部")
    metrics.add("L06", "评论获赞分布", "单评点赞P99", q(likes, .99), "赞/评", "QUANTILE", f"{len(audience)}条非作者评论", "极热评尾部")
    metrics.add("L07", "评论获赞分布", "零赞评论占比", safe_rate(int((audience['点赞'] == 0).sum()), len(audience)), "比例", "RATE", f"{int((audience['点赞'] == 0).sum())}/{len(audience)}", "绝大多数评论的认可基线")
    metrics.add("L08", "评论获赞分布", "Top 1%评论贡献点赞占比", safe_rate(sum(sorted_likes[:top_like_1]), sum(likes)), "比例", "TOP-SHARE", f"前{top_like_1}条/{len(likes)}条", "热评高度集中时不可用均值判断")
    metrics.add("L09", "评论获赞分布", "Top 5%评论贡献点赞占比", safe_rate(sum(sorted_likes[:top_like_5]), sum(likes)), "比例", "TOP-SHARE", f"前{top_like_5}条/{len(likes)}条", "热评集中度")
    metrics.add("L10", "评论获赞分布", "评论点赞Gini", gini(likes), "系数", "GINI", f"{len(audience)}条非作者评论", "0为均等，越高越集中")
    metrics.add("L11", "评论获赞分布", "评论点赞HHI", hhi(likes), "指数", "HHI", f"{len(audience)}条非作者评论", "少数热评的权重")
    metrics.add("L12", "评论获赞分布", "根评论平均点赞", mean(root_likes), "赞/评", "MEAN", f"{len(root_likes)}条根评论", "根评与回复可见度差异")
    metrics.add("L13", "评论获赞分布", "回复平均点赞", mean(reply_likes), "赞/评", "MEAN", f"{len(reply_likes)}条回复", "对话回复通常低于主评论")
    metrics.add("L14", "评论获赞分布", "根评/回复平均点赞比", safe_rate(mean(root_likes), mean(reply_likes)), "倍", "RATIO", "根评论均值/回复均值", "结构差异，不是内容质量因果")

    # 04 temporal and lifecycle: 15 metrics.
    repeat_users = users[users["评论数"] >= 2]
    second_lags = repeat_users["第二次互动时延小时"].dropna().tolist()
    eligible7 = users[users["可观测7日"]]
    eligible30 = users[users["可观测30日"]]
    lifecycle_counts = {
        "单次互动": int((users["评论数"] == 1).sum()),
        "同视频重复": int(((users["评论数"] >= 2) & (users["视频数"] == 1)).sum()),
        "跨视频同日": int((users["跨视频"] & (users["活跃天数"] == 1)).sum()),
        "跨视频2-7天": int((users["跨视频"] & (users["活跃天数"] >= 2) & (users["活跃跨度天"] <= 7)).sum()),
        "跨视频8-30天": int((users["跨视频"] & (users["活跃跨度天"] > 7) & (users["活跃跨度天"] <= 30)).sum()),
        "跨视频大于30天": int((users["跨视频"] & (users["活跃跨度天"] > 30)).sum()),
    }
    metrics.add("T01", "生命周期与时间", "观测开始时间", min_time.isoformat(), "时间", "MIN", "非作者可解析评论", "评论观察窗口起点")
    metrics.add("T02", "生命周期与时间", "观测结束时间", max_time.isoformat(), "时间", "MAX", "非作者可解析评论", "评论观察窗口终点")
    metrics.add("T03", "生命周期与时间", "第二次互动时延P25", q(second_lags, .25), "小时", "QUANTILE", f"{len(second_lags)}位重复互动用户", "初次重复的速度")
    metrics.add("T04", "生命周期与时间", "第二次互动时延中位数", median(second_lags), "小时", "MEDIAN", f"{len(second_lags)}位重复互动用户", "典型初次重复速度")
    metrics.add("T05", "生命周期与时间", "第二次互动时延P75", q(second_lags, .75), "小时", "QUANTILE", f"{len(second_lags)}位重复互动用户", "重复行为长尾")
    metrics.add("T06", "生命周期与时间", "第二次互动时延P90", q(second_lags, .90), "小时", "QUANTILE", f"{len(second_lags)}位重复互动用户", "慢回访尾部")
    for metric_id, label, hours in [("T07", "1小时内二次互动占重复用户", 1), ("T08", "24小时内二次互动占重复用户", 24), ("T09", "7天内二次互动占重复用户", 168), ("T10", "30天内二次互动占重复用户", 720)]:
        metrics.add(metric_id, "生命周期与时间", label, safe_rate(int((repeat_users['第二次互动时延小时'] <= hours).sum()), len(repeat_users)), "比例", "WINDOWED RATE", f"{int((repeat_users['第二次互动时延小时'] <= hours).sum())}/{len(repeat_users)}", "按已发生第二次互动的用户计算")
    for offset, (label, count) in enumerate(lifecycle_counts.items(), start=11):
        metrics.add(f"T{offset:02}", "生命周期与时间", label + "用户占比", safe_rate(count, audience_users), "比例", "MUTUALLY EXCLUSIVE SEGMENT", f"{count}/{audience_users}", "基于评论者可见互动路径")
    metrics.add("T17", "生命周期与时间", "30日后仍评论率", safe_rate(int(eligible30['30日后仍评论'].sum()), len(eligible30)), "比例", "WINDOW-CORRECTED RATE + WILSON", f"{int(eligible30['30日后仍评论'].sum())}/{len(eligible30)}", "仅纳入有完整30日观察窗口的评论用户", "不是平台留存率")
    metrics.add("T18", "生命周期与时间", "30日后仍评论率95%CI下限", wilson_interval(int(eligible30['30日后仍评论'].sum()), len(eligible30))[0], "比例", "WILSON 95% CI", f"{int(eligible30['30日后仍评论'].sum())}/{len(eligible30)}", "观察性区间")
    metrics.add("T19", "生命周期与时间", "30日后仍评论率95%CI上限", wilson_interval(int(eligible30['30日后仍评论'].sum()), len(eligible30))[1], "比例", "WILSON 95% CI", f"{int(eligible30['30日后仍评论'].sum())}/{len(eligible30)}", "观察性区间")

    # 05 semantic prevalence, diversity, effects: 20 metrics.
    for index, (label, code_set) in enumerate(CODE_GROUPS.items(), start=1):
        comment_count = int(audience_text["codes"].map(lambda codes: bool(codes & code_set)).sum())
        user_count = int(users[label].sum())
        metrics.add(f"S{index:02}", "语义与玩家语境", label + "用户渗透率", safe_rate(user_count, text_users), "比例", "MULTI-LABEL USER RATE", f"{user_count}/{text_users}", "多标签口径，不能与其他主题相加")
        if index <= 6:
            metrics.add(f"SC{index:02}", "语义与玩家语境", label + "评论覆盖率", safe_rate(comment_count, text_comments), "比例", "MULTI-LABEL COMMENT RATE", f"{comment_count}/{text_comments}", "多标签口径，不能与其他主题相加")
    metrics.add("S15", "语义与玩家语境", "用户编码丰富度中位数", median(semantic_users["编码丰富度"].tolist()), "种", "MEDIAN", f"{text_users}位有文本用户", "单个用户可见语义广度")
    metrics.add("S16", "语义与玩家语境", "用户编码丰富度P90", q(semantic_users["编码丰富度"].tolist(), .9), "种", "QUANTILE", f"{text_users}位有文本用户", "高语义参与用户的广度")
    metrics.add("S17", "语义与玩家语境", "多语义用户占比(至少2类编码)", safe_rate(int((semantic_users['编码丰富度'] >= 2).sum()), text_users), "比例", "RATE", f"{int((semantic_users['编码丰富度'] >= 2).sum())}/{text_users}", "不是内容理解的完整测量")
    code_counter = Counter(code for codes in audience_text["codes"] for code in codes)
    metrics.add("S18", "语义与玩家语境", "开放编码Shannon熵", shannon_entropy(list(code_counter.values())), "bit", "SHANNON ENTROPY", f"{len(code_counter)}个编码", "越高表示编码分布更分散")
    metrics.add("S19", "语义与玩家语境", "开放编码有效数", 2 ** shannon_entropy(list(code_counter.values())), "种", "EFFECTIVE NUMBER", f"{len(code_counter)}个编码", "等效均匀的编码数量")
    strict_cute = semantic_users.groupby("严格×萌化", sort=False).agg(**{
        "用户数": ("匿名受众ID", "count"),
        "跨视频率": ("跨视频", "mean"),
        "30日率": ("30日后仍评论", "mean"),
        "周边率": ("周边兴趣", "mean"),
        "购买率": ("严格购买表达", "mean"),
    }).reset_index()
    strict_cute_map = {row['严格×萌化']: row for _, row in strict_cute.iterrows()}
    both = strict_cute_map.get("玩家×萌化")
    neither = strict_cute_map.get("二者皆无")
    metrics.add("S20", "语义与玩家语境", "玩家×萌化交叉层占比", safe_rate(int(both['用户数']), text_users), "比例", "CROSS-CLASSIFICATION", f"{int(both['用户数'])}/{text_users}", "复合语境的规模")
    metrics.add("S21", "语义与玩家语境", "玩家×萌化交叉层跨视频率", float(both['跨视频率']), "比例", "CROSS-CLASSIFICATION", f"{int(both['用户数'])}位用户", "观察到的跨视频评论代理")
    metrics.add("S22", "语义与玩家语境", "玩家×萌化交叉层购买表达率", float(both['购买率']), "比例", "CROSS-CLASSIFICATION", f"{int(both['用户数'])}位用户", "购买表达，不是成交率")
    # Association effects.
    def effect_rows(exposure_col: str, outcome_col: str, frame: pd.DataFrame):
        exposed = frame[frame[exposure_col]]
        unexposed = frame[~frame[exposure_col]]
        return contingency_effect(int(exposed[outcome_col].sum()), int((~exposed[outcome_col]).sum()), int(unexposed[outcome_col].sum()), int((~unexposed[outcome_col]).sum()))
    strict_cross = effect_rows("严格玩家解码", "跨视频", semantic_users)
    cute_purchase = effect_rows("萌化情感", "严格购买表达", semantic_users)
    organic_cross = effect_rows("关系共创", "跨视频", semantic_users)
    metrics.add("S23", "语义与玩家语境", "严格玩家解码与跨视频风险差", strict_cross["risk_difference"], "百分点", "RISK DIFFERENCE", "严格/非严格玩家语境用户", "观察关联，非因果")
    metrics.add("S24", "语义与玩家语境", "严格玩家解码与跨视频风险比", strict_cross["risk_ratio"], "倍", "RISK RATIO", "严格/非严格玩家语境用户", "观察关联，非因果")
    metrics.add("S25", "语义与玩家语境", "严格玩家解码与跨视频赔率比", strict_cross["odds_ratio"], "OR", "ODDS RATIO + WILSON", "严格/非严格玩家语境用户", "不可解释为机制导致跨视频")
    metrics.add("S26", "语义与玩家语境", "萌化情感与购买表达风险差", cute_purchase["risk_difference"], "百分点", "RISK DIFFERENCE", "萌化/非萌化用户", "购买表达，不是销售转化")
    metrics.add("S27", "语义与玩家语境", "萌化情感与购买表达风险比", cute_purchase["risk_ratio"], "倍", "RISK RATIO", "萌化/非萌化用户", "观察关联")
    metrics.add("S28", "语义与玩家语境", "关系共创与跨视频风险比", organic_cross["risk_ratio"], "倍", "RISK RATIO", "共创/非共创用户", "共创可能由既有高活跃度驱动")
    depth_order = {"L0 未编码互动": 0, "L1 其他已编码表达": 1, "L2 角色/萌化身份": 2, "L3 严格玩家解码": 3, "L4 有机共创": 4}
    users["语境分值"] = users["语境层"].map(depth_order)
    semantic_users["语境分值"] = semantic_users["语境层"].map(depth_order)
    metrics.add("S29", "语义与玩家语境", "语境层与评论数Spearman相关", spearman(semantic_users["语境分值"], semantic_users["评论数"]), "rho", "SPEARMAN RANK", f"{text_users}位有文本用户", "相关不代表语境造成更多评论")
    metrics.add("S30", "语义与玩家语境", "语境层与视频广度Spearman相关", spearman(semantic_users["语境分值"], semantic_users["视频数"]), "rho", "SPEARMAN RANK", f"{text_users}位有文本用户", "相关不代表语境造成跨视频")
    table = np.array([[int(((semantic_users["严格×萌化"] == segment) & semantic_users["跨视频"]).sum()), int(((semantic_users["严格×萌化"] == segment) & ~semantic_users["跨视频"]).sum())] for segment in ["二者皆无", "仅玩家", "仅萌化", "玩家×萌化"]])
    metrics.add("S31", "语义与玩家语境", "四部落与跨视频关联Cramer's V", cramers_v(table), "V", "CRAMER'S V", "4类部落×是否跨视频", "关联强度，不是效果大小或因果")

    # 06 community / author reply association: 10 metrics.
    root_entry = users[users["首触为根评"]]
    reply_entry = users[~users["首触为根评"]]
    replied_entry = root_entry[root_entry["首根评有作者回复标记"]]
    unreplied_entry = root_entry[~root_entry["首根评有作者回复标记"]]
    reply_effect = contingency_effect(int(replied_entry["跨视频"].sum()), int((~replied_entry["跨视频"]).sum()), int(unreplied_entry["跨视频"].sum()), int((~unreplied_entry["跨视频"]).sum()))
    metrics.add("C01", "社群互动结构", "首触为根评论用户占比", safe_rate(len(root_entry), audience_users), "比例", "ENTRY TYPE RATE", f"{len(root_entry)}/{audience_users}", "入口方式与后续互动为观察关联")
    metrics.add("C02", "社群互动结构", "首触为回复用户占比", safe_rate(len(reply_entry), audience_users), "比例", "ENTRY TYPE RATE", f"{len(reply_entry)}/{audience_users}", "入口方式与后续互动为观察关联")
    metrics.add("C03", "社群互动结构", "根评入口跨视频率", float(root_entry["跨视频"].mean()), "比例", "RATE + WILSON", f"{int(root_entry['跨视频'].sum())}/{len(root_entry)}", "并非根评导致复访")
    metrics.add("C04", "社群互动结构", "回复入口跨视频率", float(reply_entry["跨视频"].mean()), "比例", "RATE + WILSON", f"{int(reply_entry['跨视频'].sum())}/{len(reply_entry)}", "并非回复入口导致流失")
    metrics.add("C05", "社群互动结构", "首根评被作者回复标记率", safe_rate(len(replied_entry), len(root_entry)), "比例", "RATE", f"{len(replied_entry)}/{len(root_entry)}", "标记没有回复发生时点")
    metrics.add("C06", "社群互动结构", "作者回复标记组跨视频率", reply_effect["exposed_rate"], "比例", "RATE + WILSON", f"{reply_effect['a_exposed_outcome']}/{len(replied_entry)}", "强关联，不是作者回复效果")
    metrics.add("C07", "社群互动结构", "未标记组跨视频率", reply_effect["unexposed_rate"], "比例", "RATE + WILSON", f"{reply_effect['c_unexposed_outcome']}/{len(unreplied_entry)}", "强关联，不是作者回复效果")
    metrics.add("C08", "社群互动结构", "作者回复标记与跨视频风险差", reply_effect["risk_difference"], "百分点", "RISK DIFFERENCE", "根评入口用户", "作者选择高质量评论等混杂未控制")
    metrics.add("C09", "社群互动结构", "作者回复标记与跨视频风险比", reply_effect["risk_ratio"], "倍", "RISK RATIO", "根评入口用户", "需随机实验验证")
    metrics.add("C10", "社群互动结构", "作者回复标记与跨视频赔率比", reply_effect["odds_ratio"], "OR", "ODDS RATIO", "根评入口用户", "需随机实验验证")

    # 07 commerce: 11 metrics.
    purchase_users = users[users["严格购买表达"]]
    merch_users = users[users["周边兴趣"]]
    overlap = users[users["严格购买表达"] & users["周边兴趣"]]
    purchase_comments = audience_text[audience_text["codes"].map(lambda codes: "strict_purchase_intent" in codes)]
    cat_counts = {}
    for category, pattern in PURCHASE_CATEGORIES.items():
        cat_counts[category] = int(purchase_comments["文本去标识"].map(lambda text: bool(pattern.search(text))).sum())
    commerce_effect = effect_rows("萌化情感", "严格购买表达", semantic_users)
    top3_purchase = purchase_comments.sort_values("点赞", ascending=False).head(3)
    robust_purchase_users = purchase_comments[~purchase_comments["评论ID"].isin(top3_purchase["评论ID"])]["用户键"].nunique()
    metrics.add("M01", "商业信号", "严格购买表达用户率", safe_rate(len(purchase_users), text_users), "比例", "MULTI-LABEL USER RATE + WILSON", f"{len(purchase_users)}/{text_users}", "表达下限，不是订单或GMV")
    metrics.add("M02", "商业信号", "周边兴趣用户率", safe_rate(len(merch_users), text_users), "比例", "MULTI-LABEL USER RATE", f"{len(merch_users)}/{text_users}", "兴趣表达，不等于购买")
    metrics.add("M03", "商业信号", "购买与周边兴趣重叠用户", len(overlap), "人", "SET INTERSECTION", f"{len(overlap)}/{len(purchase_users)}位购买表达用户", "并列信号，不画成漏斗")
    metrics.add("M04", "商业信号", "购买用户中同时周边兴趣占比", safe_rate(len(overlap), len(purchase_users)), "比例", "CONDITIONAL RATE", f"{len(overlap)}/{len(purchase_users)}", "标签重叠关系")
    metrics.add("M05", "商业信号", "玩偶/娃娃品类占购买表达", safe_rate(cat_counts['玩偶/娃娃'], len(purchase_comments)), "比例", "RULE-BASED CATEGORY RATE", f"{cat_counts['玩偶/娃娃']}/{len(purchase_comments)}条购买表达", "品类可多标签，不相加")
    metrics.add("M06", "商业信号", "泛周边品类占购买表达", safe_rate(cat_counts['泛周边'], len(purchase_comments)), "比例", "RULE-BASED CATEGORY RATE", f"{cat_counts['泛周边']}/{len(purchase_comments)}条购买表达", "品类可多标签，不相加")
    metrics.add("M07", "商业信号", "毛绒/挂件品类占购买表达", safe_rate(cat_counts['毛绒/挂件'], len(purchase_comments)), "比例", "RULE-BASED CATEGORY RATE", f"{cat_counts['毛绒/挂件']}/{len(purchase_comments)}条购买表达", "品类可多标签，不相加")
    metrics.add("M08", "商业信号", "价格敏感占购买用户", safe_rate(int(purchase_users['价格敏感'].sum()), len(purchase_users)), "比例", "MULTI-LABEL CONDITIONAL RATE", f"{int(purchase_users['价格敏感'].sum())}/{len(purchase_users)}", "样本很小，不能据此定价")
    metrics.add("M09", "商业信号", "萌化与购买表达风险比", commerce_effect["risk_ratio"], "倍", "RISK RATIO", "萌化/非萌化用户", "观察关联，不是萌化造成购买")
    metrics.add("M10", "商业信号", "萌化与购买表达赔率比", commerce_effect["odds_ratio"], "OR", "ODDS RATIO", "萌化/非萌化用户", "观察关联，不是萌化造成购买")
    metrics.add("M11", "商业信号", "去除点赞最高3条后购买表达用户数", robust_purchase_users, "人", "ROBUSTNESS / LEAVE-TOP-3-OUT", "购买表达评论去除最高赞3条", "检查结论是否由少数热评支配")

    # 08 video diversity/statistical methods: 13 metrics.
    video_stats = audience.groupby(["所属视频ID", "所属视频标题"], sort=False).agg(
        观众评论数=("评论ID", "count"),
        观众用户数=("用户键", "nunique"),
        文本评论数=("文本存在", "sum"),
        评论点赞数=("点赞", "sum"),
    ).reset_index()
    video_stats["文本用户数"] = audience_text.groupby("所属视频ID")["用户键"].nunique().reindex(video_stats["所属视频ID"], fill_value=0).to_numpy()
    video_stats["人均评论"] = video_stats["观众评论数"] / video_stats["观众用户数"].clip(lower=1)
    video_stats["每评平均赞"] = video_stats["评论点赞数"] / video_stats["观众评论数"].clip(lower=1)
    video_counts = video_stats["观众评论数"].tolist()
    metrics.add("V01", "视频层受众分布", "有观众评论视频数", len(video_stats), "条", "DISTINCT COUNT", "非作者评论", "有效内容单元")
    metrics.add("V02", "视频层受众分布", "单视频观众评论中位数", median(video_counts), "条/视频", "MEDIAN", f"{len(video_stats)}条视频", "典型视频的评论规模")
    metrics.add("V03", "视频层受众分布", "单视频观众评论P25", q(video_counts, .25), "条/视频", "QUANTILE", f"{len(video_stats)}条视频", "低位内容表现")
    metrics.add("V04", "视频层受众分布", "单视频观众评论P75", q(video_counts, .75), "条/视频", "QUANTILE", f"{len(video_stats)}条视频", "高位内容表现")
    metrics.add("V05", "视频层受众分布", "单视频观众评论P90", q(video_counts, .9), "条/视频", "QUANTILE", f"{len(video_stats)}条视频", "头部视频表现")
    metrics.add("V06", "视频层受众分布", "视频评论量Gini", gini(video_counts), "系数", "GINI", f"{len(video_stats)}条视频", "越高越依赖少数视频")
    metrics.add("V07", "视频层受众分布", "视频评论量HHI", hhi(video_counts), "指数", "HHI", f"{len(video_stats)}条视频", "内容互动集中度")
    metrics.add("V08", "视频层受众分布", "有效视频数", safe_rate(1, hhi(video_counts)), "条", "1/HHI", f"{len(video_stats)}条视频", "等效均匀贡献视频数")
    metrics.add("V09", "视频层受众分布", "Top10视频贡献评论占比", safe_rate(sum(sorted(video_counts, reverse=True)[:10]), sum(video_counts)), "比例", "TOP-SHARE", "前10条视频", "头部内容集中度")
    metrics.add("V10", "视频层受众分布", "单视频观众用户中位数", median(video_stats["观众用户数"].tolist()), "人/视频", "MEDIAN", f"{len(video_stats)}条视频", "评论者广度")
    metrics.add("V11", "视频层受众分布", "单视频人均评论中位数", median(video_stats["人均评论"].tolist()), "条/人", "MEDIAN", f"{len(video_stats)}条视频", "对话深度代理")
    metrics.add("V12", "视频层受众分布", "视频评论量与人均评论Spearman", spearman(video_stats["观众评论数"], video_stats["人均评论"]), "rho", "SPEARMAN RANK", f"{len(video_stats)}条视频", "生态相关，不代表内容设计因果")
    metrics.add("V13", "视频层受众分布", "视频评论量与每评平均赞Spearman", spearman(video_stats["观众评论数"], video_stats["每评平均赞"]), "rho", "SPEARMAN RANK", f"{len(video_stats)}条视频", "生态相关，不代表内容设计因果")

    # 09 robustness, sampling error and method coverage: 7 metrics.
    boot_mean_low, boot_mean_high = bootstrap_interval(counts, np.mean)
    boot_med_low, boot_med_high = bootstrap_interval(counts, np.median)
    metrics.add("R01", "稳健性与不确定性", "人均评论Bootstrap 95%CI下限", boot_mean_low, "条/人", "NONPARAMETRIC BOOTSTRAP 1200", f"{audience_users}位用户", "均值抽样不确定性")
    metrics.add("R02", "稳健性与不确定性", "人均评论Bootstrap 95%CI上限", boot_mean_high, "条/人", "NONPARAMETRIC BOOTSTRAP 1200", f"{audience_users}位用户", "均值抽样不确定性")
    metrics.add("R03", "稳健性与不确定性", "评论中位数Bootstrap 95%CI下限", boot_med_low, "条/人", "NONPARAMETRIC BOOTSTRAP 1200", f"{audience_users}位用户", "中位数抽样不确定性")
    metrics.add("R04", "稳健性与不确定性", "评论中位数Bootstrap 95%CI上限", boot_med_high, "条/人", "NONPARAMETRIC BOOTSTRAP 1200", f"{audience_users}位用户", "中位数抽样不确定性")
    metrics.add("R05", "稳健性与不确定性", "语义用户分母与全评论用户比例", safe_rate(text_users, audience_users), "比例", "COVERAGE CHECK", f"{text_users}/{audience_users}", "文本缺失会影响语义结论外推")
    metrics.add("R06", "稳健性与不确定性", "严格购买表达去Top3后保留用户率", safe_rate(robust_purchase_users, len(purchase_users)), "比例", "LEAVE-TOP-3-OUT", f"{robust_purchase_users}/{len(purchase_users)}", "热评移除后的结论稳健性")
    metrics.add("R07", "稳健性与不确定性", "已使用统计方法数", len({row['统计方法'] for row in metrics.rows}), "种", "METHOD INVENTORY", "本报告指标字典", "方法数不等于结论可信度")

    # Additional association tables and data used by report.
    level_rows = []
    for level, group in semantic_users.groupby("语境层", sort=False):
        eligible = group[group["可观测30日"]]
        level_rows.append({
            "语境层": level,
            "用户数": int(len(group)),
            "用户占比": r(len(group) / text_users),
            "评论人均": r(group["评论数"].mean()),
            "跨视频率": r(group["跨视频"].mean()),
            "30日观察分母": int(len(eligible)),
            "30日后仍评论率": r(eligible["30日后仍评论"].mean() if len(eligible) else 0),
            "周边兴趣率": r(group["周边兴趣"].mean()),
            "购买表达率": r(group["严格购买表达"].mean()),
            "跨视频95CI": [r(x) for x in wilson_interval(int(group['跨视频'].sum()), len(group))],
        })
    strict_cute_rows = []
    for segment, group in semantic_users.groupby("严格×萌化", sort=False):
        eligible = group[group["可观测30日"]]
        strict_cute_rows.append({
            "部落": segment,
            "用户数": int(len(group)),
            "用户占比": r(len(group) / text_users),
            "跨视频率": r(group["跨视频"].mean()),
            "30日观察分母": int(len(eligible)),
            "30日后仍评论率": r(eligible["30日后仍评论"].mean() if len(eligible) else 0),
            "周边兴趣率": r(group["周边兴趣"].mean()),
            "购买表达率": r(group["严格购买表达"].mean()),
        })
    effect_table = {
        "strict_vs_cross_video": strict_cross,
        "cute_vs_purchase": cute_purchase,
        "organic_co_creation_vs_cross_video": organic_cross,
        "author_reply_marker_vs_cross_video": reply_effect,
    }
    monthly = audience.groupby(audience["日期"].dt.strftime("%Y-%m")).agg(评论数=("评论ID", "count"), 用户数=("用户键", "nunique"), 点赞数=("点赞", "sum")).reset_index().rename(columns={"日期": "月份"})
    hour = audience.groupby("小时").agg(评论数=("评论ID", "count"), 用户数=("用户键", "nunique"), 点赞数=("点赞", "sum")).reset_index()
    # Create privacy-safe anonymous profile extract (no source username, content, URL, or raw timestamp).
    profile_cols = [
        "匿名受众ID", "评论数", "文本评论数", "视频数", "活跃天数", "活跃跨度天", "第二次互动时延小时",
        "总点赞", "平均单评赞", "根评论数", "回复评论数", "首触小时", "首触月份", "跨视频", "跨视频_大于7天", "跨视频_大于30天",
        "可观测7日", "可观测30日", "7日后仍评论", "30日后仍评论", "编码丰富度", "语境层", "严格×萌化", "互动频次层", "视频广度层",
    ] + list(CODE_GROUPS.keys())
    profiles = users[profile_cols].copy()
    # User-level exports keep analytical utility while avoiding unique-looking
    # high-precision decimal fingerprints. Aggregate calculations above retain
    # their original precision; only the privacy-safe derivative is rounded.
    float_columns = profiles.select_dtypes(include=["float"]).columns
    profiles[float_columns] = profiles[float_columns].round(2)
    profile_path = OUT_DIR / "wuhu-mkt-multidimensional-anonymous-profiles.csv"
    profiles.to_csv(profile_path, index=False, encoding="utf-8-sig")
    video_stats = video_stats.sort_values("观众评论数", ascending=False)
    video_path_out = OUT_DIR / "wuhu-mkt-multidimensional-video-statistics.csv"
    video_stats.to_csv(video_path_out, index=False, encoding="utf-8-sig")

    # Keep the full diagnostic ledger in JSON, but make the management-facing
    # dictionary a fixed, auditable 98-dimension core set. These are distinct
    # measurements, not renamed variants of the same number.
    core_metric_ids = {
        # Data basis: 10
        "D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D13",
        # User activity and concentration: 11
        "U01", "U02", "U04", "U05", "U07", "U09", "U10", "U11", "U12", "U13", "U16",
        # Like distribution: 10
        "L01", "L02", "L03", "L04", "L06", "L07", "L08", "L09", "L10", "L14",
        # Observable lifecycle: 13
        "T04", "T07", "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T17", "T18", "T19",
        # Semantic prevalence and audience relationship: 24
        "S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14",
        "S18", "S20", "S21", "S24", "S25", "S27", "S28", "S29", "S30", "S31",
        # Community interaction: 8
        "C01", "C02", "C03", "C04", "C05", "C06", "C08", "C09",
        # Commercial-expression evidence: 9
        "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M11",
        # Video-level distribution: 8
        "V01", "V02", "V05", "V06", "V08", "V09", "V12", "V13",
        # Uncertainty and robustness: 5
        "R01", "R02", "R03", "R04", "R06",
    }
    core_rows = [row for row in metrics.rows if row["指标ID"] in core_metric_ids]
    supplementary_rows = [row for row in metrics.rows if row["指标ID"] not in core_metric_ids]
    metric_df = pd.DataFrame(core_rows)
    assert len(metric_df) == 98, f"Expected exactly 98 core dimensions, got {len(metric_df)}"
    metric_path = OUT_DIR / "wuhu-mkt-multidimensional-metric-dictionary.csv"
    metric_df.to_csv(metric_path, index=False, encoding="utf-8-sig")

    analysis = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "reportType": "三国杀WUHU联盟卡宝多维受众统计分析",
        "source": {
            "comments": str(RAW_PATH),
            "codedComments": str(CODED_PATH),
            "videos": str(VIDEO_PATH),
        },
        "scope": {
            "metricDimensions": len(metric_df),
            "statisticalMethods": sorted(metric_df["统计方法"].unique().tolist()),
            "statisticalMethodCount": len(metric_df["统计方法"].unique()),
            "analysisLevels": ["评论", "用户", "线程/入口", "视频", "语义", "时间窗口"],
            "userKey": "评论用户URL优先，仅在内存聚合；导出为稳定匿名ID",
            "textScope": "语义指标仅使用去标识非空文本评论及用户",
        },
        "coverage": {
            "videos": int(len(video)),
            "commentBearingVideos": int(df["所属视频ID"].nunique()),
            "capturedComments": total_captured,
            "declaredComments": int(declared),
            "audienceComments": len(audience),
            "audienceUsers": audience_users,
            "audienceTextComments": text_comments,
            "audienceTextUsers": text_users,
            "observationStart": min_time.isoformat(),
            "observationEnd": max_time.isoformat(),
        },
        "metrics": core_rows,
        "supplementaryDiagnostics": supplementary_rows,
        "lifecycleSegments": [{"分层": label, "用户数": count, "占比": r(count / audience_users)} for label, count in lifecycle_counts.items()],
        "contextLevels": level_rows,
        "strictCuteSegments": strict_cute_rows,
        "effects": effect_table,
        "semanticCodes": [{"编码": code, "评论数": count, "评论占比": r(count / text_comments)} for code, count in code_counter.most_common()],
        "commerce": {
            "purchaseCommentCount": int(len(purchase_comments)),
            "purchaseUserCount": int(len(purchase_users)),
            "merchUserCount": int(len(merch_users)),
            "overlapUserCount": int(len(overlap)),
            "categories": cat_counts,
            "top3RemovedUserCount": int(robust_purchase_users),
        },
        "videoStatistics": video_stats.to_dict(orient="records"),
        "monthly": monthly.to_dict(orient="records"),
        "hourly": hour.to_dict(orient="records"),
        "evidenceBoundaries": [
            "数据没有播放量、完播率、收藏、分享、关注、点击、订单或支付分母；所有内容与商业结论只能写为评论语料中的观察关联或表达信号。",
            "评论用户是观察到的评论者，不等于观看者、粉丝或真实付费用户；跨视频/30日后仍评论是可见评论行为代理，不是平台留存率。",
            "107条视频中只有少量发布时间可用，不能从本数据推断最佳发布时间、月度因果或内容投放效果。",
            "语义编码是规则辅助的扎根式分类；多标签统计不互斥，比例不可相加；负面词有三国杀台词、反讽与自嘲歧义。",
            "作者回复字段没有真实回复时点且受作者选择、内容质量、用户活跃度和视频批次混杂，效应量只能作为随机实验的观察基线。",
            "购买表达、周边兴趣与品类词是需求表达下限；标签重叠不是漏斗，不能外推销量、价格带或SKU规模。",
        ],
    }
    analysis_path = OUT_DIR / "wuhu-mkt-multidimensional-analysis.json"
    analysis_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")

    methods = [
        ("COUNT / DISTINCT COUNT", "规模与去重人数", "避免把评论行误当用户数"),
        ("RATE / CONDITIONAL RATE", "比例、渗透与条件比例", "每个比率保留明确分母"),
        ("QUANTILE / MEDIAN", "P25/P50/P75/P90/P95/P99", "描述重尾互动分布，避免均值单独误导"),
        ("GINI / HHI / 1-HHI", "集中度与等效贡献规模", "判断是否由少数用户、评论或视频主导"),
        ("TOP-SHARE", "Top 1%、5%、10%贡献", "判断头部依赖"),
        ("WINDOWED RATE", "1小时、24小时、7日、30日窗口", "处理不同观察期"),
        ("WILSON 95% CI", "比例区间估计", "避免小样本比例只看点估计"),
        ("NONPARAMETRIC BOOTSTRAP", "均值和中位数95%区间", "不假设正态分布"),
        ("RISK DIFFERENCE / RISK RATIO / ODDS RATIO", "两组观察关联", "同时报告绝对差与相对差，不作因果解释"),
        ("SPEARMAN RANK", "单调相关", "适用于偏态等级或计数变量"),
        ("CRAMER'S V", "分类变量关联强度", "不把显著性检验替代为经营意义"),
        ("MULTI-LABEL RATE", "语义多标签渗透", "主题可重叠，比例不可加总"),
        ("SET INTERSECTION", "标签重叠", "防止将并列信号误画成漏斗"),
        ("ROBUSTNESS / LEAVE-TOP-3-OUT", "剔除最高赞样本复算", "检查热评是否主导结论"),
        ("CROSS-CLASSIFICATION", "严格玩家×萌化四格", "把用户差异转为可执行部落"),
        ("METHOD INVENTORY", "方法覆盖盘点", "方法数不是可信度本身"),
    ]
    method_lines = [
        "# 多维受众统计方法与口径",
        "",
        f"- 原始评论：{total_captured:,} 条；非作者评论：{len(audience):,} 条；非作者评论用户：{audience_users:,} 人。",
        f"- 语义样本：有文本非作者评论 {text_comments:,} 条、用户 {text_users:,} 人。",
        f"- 本交付共有 **{len(metric_df)} 个原子指标**，覆盖评论、用户、线程入口、视频、语义、时间窗口六个层级；指标字典记录每项公式、分母和边界。",
        "",
        "## 使用的方法",
        "",
        "| 方法 | 用途 | 解释约束 |",
        "|---|---|---|",
    ]
    method_lines += [f"| {name} | {purpose} | {caveat} |" for name, purpose, caveat in methods]
    method_lines += [
        "",
        "## 核心边界",
        "",
        *[f"- {item}" for item in analysis["evidenceBoundaries"]],
        "",
        "## 复算文件",
        "",
        "- `wuhu-mkt-multidimensional-metric-dictionary.csv`: 原子指标、分母、统计方法与解释。",
        "- `wuhu-mkt-multidimensional-anonymous-profiles.csv`: 仅含匿名ID与派生特征的用户级数据，不含昵称、用户URL、原文或精确评论时间。",
        "- `wuhu-mkt-multidimensional-video-statistics.csv`: 视频粒度的评论、受众与点赞统计。",
        "- `wuhu-mkt-multidimensional-analysis.json`: 报告读取的全部聚合结果。",
    ]
    method_path = OUT_DIR / "多维受众统计方法与口径.md"
    method_path.write_text("\n".join(method_lines) + "\n", encoding="utf-8")

    print(json.dumps({
        "outDir": str(OUT_DIR),
        "metricDimensions": len(metric_df),
        "statisticalMethods": len(set(metric_df["统计方法"])),
        "audienceUsers": audience_users,
        "textUsers": text_users,
        "metrics": str(metric_path),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
