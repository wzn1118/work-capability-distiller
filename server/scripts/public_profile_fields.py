"""Bounded aggregation for public creator-profile content samples.

The browser collectors pass only fields that are visibly rendered on a target
creator profile.  This module keeps those observations structured without
turning content text into unverified account or audience facts.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime
from typing import Any


MAX_SAMPLE_TAGS = 24
MAX_SAMPLE_TOPICS = 24
MAX_SAMPLE_DATES = 12
MAX_SAMPLE_MARKERS = 12
MAX_CONTENT_TYPES = 6
MAX_CONTENT_FORMATS = 8
MAX_ACCOUNT_FIELD_NAMES = 16
MAX_DURATION_SECONDS = 86_400

_METRIC_ALIASES = {
    "likes": ("digg_count", "like_count", "likes", "likeCount", "diggCount"),
    "collects": ("collect_count", "collects", "favorite_count", "favourite_count", "collectCount"),
    "comments": ("comment_count", "comments", "commentCount"),
    "shares": ("share_count", "shares", "forward_count", "repost_count", "shareCount"),
    "plays": ("play_count", "plays", "view_count", "views", "playCount", "viewCount"),
}

_ENGAGEMENT_METRICS = ("likes", "comments", "collects", "shares")
_TIME_PATTERN = re.compile(r"(?<!\d)([01]?\d|2[0-3]):[0-5]\d(?!\d)")
_DATE_PATTERN = re.compile(r"(?<!\d)(20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?!\d)")


def _text(value: Any, maximum: int = 120) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()[:maximum]


def _unique(values: list[Any], maximum: int, item_limit: int = 120) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = _text(value, item_limit)
        key = item.casefold()
        if not item or key in seen:
            continue
        seen.add(key)
        output.append(item)
        if len(output) >= maximum:
            break
    return output


def _metric(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value) if value >= 0 else None
    raw = _text(value, 80).lower().replace(",", "")
    match = re.search(r"(\d+(?:\.\d+)?)\s*(w|k|\u4e07|\u4ebf)?", raw)
    if not match:
        return None
    amount = float(match.group(1))
    unit = match.group(2) or ""
    multiplier = 100_000_000 if unit == "\u4ebf" else 10_000 if unit in ("\u4e07", "w") else 1_000 if unit == "k" else 1
    result = round(amount * multiplier)
    return result if result >= 0 else None


def _duration(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return seconds if 0 < seconds <= MAX_DURATION_SECONDS else None


def _sample_duration(sample: dict[str, Any]) -> int | None:
    for key in ("duration_seconds", "durationSeconds"):
        value = _duration(sample.get(key))
        if value is not None:
            return value
    for key in ("duration_ms", "durationMs"):
        milliseconds = _metric(sample.get(key))
        if milliseconds is None:
            continue
        seconds = round(milliseconds / 1_000)
        if 0 < seconds <= MAX_DURATION_SECONDS:
            return seconds
    return None


def _sample_metric_values(statistics: dict[str, Any]) -> dict[str, int]:
    values: dict[str, int] = {}
    for canonical, aliases in _METRIC_ALIASES.items():
        for alias in aliases:
            value = _metric(statistics.get(alias))
            if value is not None:
                values[canonical] = value
                break
    return values


def _topic_label(value: Any) -> str:
    return _text(value, 80).lstrip("#\uff03").strip()


def _publish_time_bucket(sample: dict[str, Any]) -> str:
    candidates = (
        sample.get("published_time_text"),
        sample.get("publishedTimeText"),
        sample.get("published_at"),
        sample.get("publishedAt"),
    )
    for candidate in candidates:
        match = _TIME_PATTERN.search(_text(candidate, 100))
        if not match:
            continue
        hour = int(match.group(1))
        if hour < 5:
            return "late_night"
        if hour < 11:
            return "morning"
        if hour < 14:
            return "midday"
        if hour < 18:
            return "afternoon"
        return "evening"
    return ""


def _publish_weekday(sample: dict[str, Any]) -> str:
    published_at = _text(sample.get("published_at") or sample.get("publishedAt"), 100)
    match = _DATE_PATTERN.search(published_at)
    if not match:
        return ""
    try:
        return ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")[
            datetime(int(match.group(1)), int(match.group(2)), int(match.group(3))).weekday()
        ]
    except ValueError:
        return ""


def _observed_public_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (dict, list, tuple, set)):
        return bool(value)
    return True


def _coverage_entry(observed_count: int, sample_count: int) -> dict[str, Any]:
    """Keep missing public fields distinct from a zero-valued public metric."""
    if sample_count <= 0:
        status = "no_visible_samples"
    elif observed_count > 0:
        status = "observed"
    else:
        status = "not_observed_in_visible_samples"
    return {
        "status": status,
        "observed_count": observed_count,
        "sample_count": sample_count,
        "coverage_rate": round(observed_count / sample_count, 4) if sample_count else None,
    }


def _sample_has_any_value(sample: dict[str, Any], keys: tuple[str, ...]) -> bool:
    return any(_observed_public_value(sample.get(key)) for key in keys)


def summarize_visible_sample_coverage(
    samples: list[dict[str, Any]],
    interaction_coverage: Counter[str],
) -> dict[str, Any]:
    """Describe exactly which public-card fields were visible in this capture."""
    sample_count = len(samples)
    field_keys = {
        "source_url": ("note_url", "source_url", "share_url", "url", "link"),
        "title": ("title", "name", "caption"),
        "body": ("body", "summary", "description", "caption", "detail_text", "detailText"),
        "published_at": ("published_at", "publishedAt", "published_time_text", "publishedTimeText"),
        "content_type": ("content_type", "contentType", "type"),
        "content_format": ("content_format", "contentFormat"),
        "duration": ("duration_seconds", "durationSeconds", "duration_ms", "durationMs"),
        "cover": ("cover_url", "coverUrl", "image_url", "thumbnail_url"),
        "hashtags": ("hashtags", "tags", "topic_labels", "topicLabels"),
        "pinned_state": ("is_pinned", "isPinned", "pinned"),
        "commercial_markers": ("commercial_markers", "commercialMarkers", "commercial_disclosures", "commercialDisclosures"),
        "brand_mentions": ("brand_mentions", "brandMentions", "brands"),
        "risk_flags": ("risk_flags", "riskFlags", "compliance_flags", "complianceFlags"),
        "video_state": ("has_video", "hasVideo"),
        "image_count": ("content_image_count", "contentImageCount", "image_count", "imageCount"),
    }
    fields = {
        name: _coverage_entry(
            sum(1 for sample in samples if _sample_has_any_value(sample, keys)),
            sample_count,
        )
        for name, keys in field_keys.items()
    }
    interactions = {
        name: _coverage_entry(count, sample_count)
        for name, count in interaction_coverage.items()
    }
    for name in _METRIC_ALIASES:
        interactions.setdefault(name, _coverage_entry(0, sample_count))
    return {
        "status": "observed" if sample_count else "no_visible_samples",
        "visible_sample_count": sample_count,
        "fields": fields,
        "interaction_metrics": interactions,
    }


def summarize_visible_account_fields(record: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Describe which existing account fields came from public page observations."""
    observed: list[str] = []
    metric_fields: list[str] = []

    def has(*keys: str) -> bool:
        return any(_observed_public_value(profile.get(key)) or _observed_public_value(record.get(key)) for key in keys)

    for field, keys in (
        ("handle", ("handle",)),
        ("bio", ("bio", "signature")),
        ("location", ("location", "ip_location")),
        ("verification", ("verified_label",)),
        ("avatar", ("avatar", "avatar_url")),
        ("profile_tags", ("profile_tags",)),
        ("audience_signals", ("public_audience_signals",)),
    ):
        if has(*keys):
            observed.append(field)

    metrics = profile.get("metrics") if isinstance(profile.get("metrics"), dict) else {}
    root_metric_keys = {
        "followers": ("followers", "follower_count"),
        "following": ("following", "following_count"),
        "likes": ("likes", "like_count", "total_favorited"),
        "works": ("works", "work_count", "aweme_count"),
    }
    for metric, keys in root_metric_keys.items():
        if _observed_public_value(metrics.get(metric)) or has(*keys):
            metric_fields.append(metric)
            observed.append(f"metric_{metric}")

    expected_fields = [
        "handle", "bio", "location", "verification", "avatar", "profile_tags", "audience_signals",
        "metric_followers", "metric_following", "metric_likes", "metric_works",
    ]
    missing_fields = [field for field in expected_fields if field not in observed]
    observed_count = len(observed)
    return {
        "observed_fields": observed[:MAX_ACCOUNT_FIELD_NAMES],
        "observed_field_count": observed_count,
        "observed_metric_fields": metric_fields,
        "field_coverage": {
            "status": "observed" if observed_count == len(expected_fields)
            else "partial" if observed_count else "not_observed",
            "observed_field_count": observed_count,
            "possible_field_count": len(expected_fields),
            "coverage_rate": round(observed_count / len(expected_fields), 4),
            "missing_fields": missing_fields,
        },
    }


def summarize_visible_content(samples: Any) -> dict[str, Any]:
    """Return bounded aggregates derived strictly from visible content cards."""
    items = [item for item in (samples if isinstance(samples, list) else []) if isinstance(item, dict)]
    type_counts: Counter[str] = Counter()
    format_counts: Counter[str] = Counter()
    hashtags: list[Any] = []
    topic_labels: list[Any] = []
    publish_dates: list[Any] = []
    publish_time_buckets: Counter[str] = Counter()
    publish_weekdays: Counter[str] = Counter()
    disclosure_markers: list[Any] = []
    disclosure_marker_counts: Counter[str] = Counter()
    interaction_coverage: Counter[str] = Counter()
    interaction_totals: Counter[str] = Counter()
    interaction_observed: Counter[str] = Counter()
    duration_values: list[int] = []
    disclosure_sample_count = 0
    pinned_sample_count = 0

    for sample in items:
        content_type = _text(sample.get("content_type") or sample.get("contentType"), 48)
        if content_type:
            type_counts[content_type] += 1
        content_format = _text(sample.get("content_format") or sample.get("contentFormat"), 48)
        if content_format:
            format_counts[content_format] += 1
        raw_tags = sample.get("hashtags") or sample.get("tags") or []
        hashtags.extend(raw_tags if isinstance(raw_tags, list) else [raw_tags])
        raw_topics = sample.get("topic_labels") or sample.get("topicLabels") or raw_tags
        raw_topics = raw_topics if isinstance(raw_topics, list) else [raw_topics]
        topic_labels.extend(_topic_label(value) for value in raw_topics)
        published_at = _text(sample.get("published_at") or sample.get("publishedAt"), 80)
        if published_at:
            publish_dates.append(published_at)
        publish_time = _publish_time_bucket(sample)
        if publish_time:
            publish_time_buckets[publish_time] += 1
        weekday = _publish_weekday(sample)
        if weekday:
            publish_weekdays[weekday] += 1
        raw_markers = sample.get("commercial_markers") or sample.get("commercialMarkers") or []
        markers = _unique(raw_markers if isinstance(raw_markers, list) else [raw_markers], MAX_SAMPLE_MARKERS, 64)
        if markers:
            disclosure_sample_count += 1
            disclosure_markers.extend(markers)
            disclosure_marker_counts.update(markers)
        if sample.get("is_pinned") is True or sample.get("isPinned") is True:
            pinned_sample_count += 1
        duration_seconds = _sample_duration(sample)
        if duration_seconds is not None:
            duration_values.append(duration_seconds)
        statistics = sample.get("statistics") or sample.get("metrics") or sample.get("interactions")
        if not isinstance(statistics, dict):
            continue
        for canonical, value in _sample_metric_values(statistics).items():
            interaction_coverage[canonical] += 1
            interaction_observed[canonical] += 1
            interaction_totals[canonical] += value

    summary: dict[str, Any] = {
        "content_type_counts": dict(type_counts.most_common(MAX_CONTENT_TYPES)),
        "sample_hashtags": _unique(hashtags, MAX_SAMPLE_TAGS, 80),
        "sample_topic_labels": _unique(topic_labels, MAX_SAMPLE_TOPICS, 80),
        "sample_publish_dates": _unique(publish_dates, MAX_SAMPLE_DATES, 80),
        "sample_interaction_coverage": dict(interaction_coverage),
        "sample_commercial_markers": _unique(disclosure_markers, MAX_SAMPLE_MARKERS, 64),
        "sample_commercial_disclosure_count": disclosure_sample_count,
        "sample_observation_coverage": summarize_visible_sample_coverage(items, interaction_coverage),
    }
    if format_counts:
        summary["sample_content_format_counts"] = dict(format_counts.most_common(MAX_CONTENT_FORMATS))
    if publish_time_buckets:
        summary["sample_publish_time_buckets"] = dict(publish_time_buckets)
    if publish_weekdays:
        summary["sample_publish_weekday_counts"] = dict(publish_weekdays)
    if disclosure_marker_counts:
        summary["sample_commercial_marker_counts"] = dict(disclosure_marker_counts.most_common(MAX_SAMPLE_MARKERS))
    if items:
        summary["sample_commercial_disclosure_rate"] = round(disclosure_sample_count / len(items), 4)
    if pinned_sample_count:
        summary["sample_pinned_content_count"] = pinned_sample_count
    if interaction_totals:
        summary["sample_interaction_totals"] = dict(interaction_totals)
        summary["sample_interaction_averages"] = {
            metric: round(interaction_totals[metric] / interaction_observed[metric])
            for metric in interaction_totals
            if interaction_observed[metric]
        }
        engagement_total = sum(interaction_totals[metric] for metric in _ENGAGEMENT_METRICS)
        if engagement_total:
            summary["sample_interaction_composition"] = {
                metric: round(interaction_totals[metric] / engagement_total, 4)
                for metric in _ENGAGEMENT_METRICS
                if interaction_totals[metric]
            }
    if duration_values:
        summary["sample_duration"] = {
            "observed_count": len(duration_values),
            "total_seconds": sum(duration_values),
            "average_seconds": round(sum(duration_values) / len(duration_values)),
        }
    return summary


def enrich_profile_records(records: Any) -> list[dict[str, Any]]:
    """Add content-summary dimensions to target-profile records in place-safe form."""
    if not isinstance(records, list):
        return records if isinstance(records, list) else []
    output: list[dict[str, Any]] = []
    for source in records:
        if not isinstance(source, dict):
            continue
        record = dict(source)
        profile = dict(record.get("profile") or {}) if isinstance(record.get("profile"), dict) else {}
        samples = record.get("latest_samples")
        if not isinstance(samples, list):
            samples = profile.get("latest_samples")
        summary_fields = summarize_visible_content(samples)
        account_fields = summarize_visible_account_fields(record, profile)
        root_summary = dict(record.get("content_summary") or {}) if isinstance(record.get("content_summary"), dict) else {}
        profile_summary = dict(profile.get("content_summary") or {}) if isinstance(profile.get("content_summary"), dict) else {}
        root_summary.update(summary_fields)
        profile_summary.update(summary_fields)
        record["content_summary"] = root_summary
        if account_fields:
            record["public_account_fields"] = account_fields
            profile["public_account_fields"] = account_fields
        profile["content_summary"] = profile_summary
        if profile:
            record["profile"] = profile
        output.append(record)
    return output
