import unittest

from public_profile_fields import enrich_profile_records, summarize_visible_content


class PublicProfileFieldsTest(unittest.TestCase):
    def test_summarizes_only_explicit_visible_sample_dimensions(self):
        summary = summarize_visible_content([
            {
                "content_type": "video",
                "hashtags": ["#skin", "#routine"],
                "published_at": "2026-07-20",
                "duration_seconds": 32,
                "commercial_markers": ["brand_collaboration"],
                "statistics": {"digg_count": "1.2w", "comment_count": 4},
            },
            {
                "content_type": "image_or_note",
                "hashtags": ["#routine", "#serum"],
                "published_at": "07/18",
                "duration_seconds": 48,
                "statistics": {"like_count": 12, "collect_count": 6, "share_count": 1},
            },
        ])

        self.assertEqual(summary["content_type_counts"], {"video": 1, "image_or_note": 1})
        self.assertEqual(summary["sample_hashtags"], ["#skin", "#routine", "#serum"])
        self.assertEqual(summary["sample_publish_dates"], ["2026-07-20", "07/18"])
        self.assertEqual(summary["sample_interaction_coverage"], {"likes": 2, "comments": 1, "collects": 1, "shares": 1})
        self.assertEqual(summary["sample_commercial_markers"], ["brand_collaboration"])
        self.assertEqual(summary["sample_commercial_disclosure_count"], 1)
        self.assertEqual(summary["sample_duration"], {"observed_count": 2, "total_seconds": 80, "average_seconds": 40})
        coverage = summary["sample_observation_coverage"]
        self.assertEqual(coverage["visible_sample_count"], 2)
        self.assertEqual(coverage["fields"]["duration"]["observed_count"], 2)
        self.assertEqual(coverage["fields"]["brand_mentions"]["status"], "not_observed_in_visible_samples")
        self.assertEqual(coverage["interaction_metrics"]["plays"]["status"], "not_observed_in_visible_samples")

    def test_keeps_existing_collector_summary_and_rejects_invalid_duration(self):
        records = enrich_profile_records([{
            "latest_samples": [{"content_type": "video", "duration_seconds": 90_000}],
            "content_summary": {"visible_sample_count": 1, "sampled_from_public_profile": True},
            "profile": {"content_summary": {"sample_interactions": {"digg_count": 12}}},
        }])

        self.assertEqual(records[0]["content_summary"]["visible_sample_count"], 1)
        self.assertTrue(records[0]["content_summary"]["sampled_from_public_profile"])
        self.assertEqual(records[0]["profile"]["content_summary"]["sample_interactions"], {"digg_count": 12})
        self.assertNotIn("sample_duration", records[0]["content_summary"])

    def test_missing_public_dimensions_do_not_create_derived_values(self):
        summary = summarize_visible_content([{
            "content_type": "video",
            "published_at": None,
            "duration_seconds": None,
            "is_pinned": None,
            "commercial_markers": None,
            "statistics": {"digg_count": "14"},
        }])

        self.assertEqual(summary["sample_publish_dates"], [])
        self.assertEqual(summary["sample_commercial_markers"], [])
        self.assertEqual(summary["sample_commercial_disclosure_count"], 0)
        self.assertNotIn("sample_duration", summary)
        self.assertNotIn("sample_publish_time_buckets", summary)
        self.assertEqual(summary["sample_interaction_totals"], {"likes": 14})
        self.assertEqual(
            summary["sample_observation_coverage"]["fields"]["duration"]["status"],
            "not_observed_in_visible_samples",
        )

    def test_derives_portrait_dimensions_from_explicit_public_fields(self):
        record = enrich_profile_records([{
            "latest_samples": [
                {
                    "content_type": "video",
                    "content_format": "video",
                    "topic_labels": ["skin", "routine"],
                    "published_at": "2026-07-20 09:15",
                    "duration_seconds": 30,
                    "is_pinned": True,
                    "commercial_markers": ["brand_collaboration"],
                    "statistics": {
                        "digg_count": "1.2w",
                        "comment_count": 4,
                        "collect_count": 6,
                        "share_count": 1,
                        "play_count": "12w",
                    },
                },
                {
                    "content_type": "image_or_note",
                    "content_format": "image_carousel",
                    "topic_labels": ["routine", "serum"],
                    "published_at": "2026-07-21 20:30",
                    "duration_ms": 48_000,
                    "statistics": {"like_count": 12},
                },
            ],
            "profile": {
                "handle": "creator-id",
                "bio": "public skincare creator",
                "location": "Shanghai",
                "verified_label": "verified",
                "avatar": "https://cdn.example/avatar.jpg",
                "profile_tags": ["beauty"],
                "public_audience_signals": ["fan club"],
                "metrics": {"followers": "1.2w", "following": 8, "likes": "2w", "works": 42},
            },
        }])[0]

        summary = record["content_summary"]
        self.assertEqual(summary["sample_content_format_counts"], {"video": 1, "image_carousel": 1})
        self.assertEqual(summary["sample_topic_labels"], ["skin", "routine", "serum"])
        self.assertEqual(summary["sample_publish_time_buckets"], {"morning": 1, "evening": 1})
        self.assertEqual(summary["sample_publish_weekday_counts"], {"monday": 1, "tuesday": 1})
        self.assertEqual(summary["sample_interaction_totals"], {
            "likes": 12012,
            "comments": 4,
            "collects": 6,
            "shares": 1,
            "plays": 120000,
        })
        self.assertEqual(summary["sample_interaction_averages"]["likes"], 6006)
        self.assertEqual(summary["sample_commercial_marker_counts"], {"brand_collaboration": 1})
        self.assertEqual(summary["sample_commercial_disclosure_rate"], 0.5)
        self.assertEqual(summary["sample_pinned_content_count"], 1)
        self.assertEqual(summary["sample_duration"], {
            "observed_count": 2,
            "total_seconds": 78,
            "average_seconds": 39,
        })

        account_fields = record["public_account_fields"]
        self.assertEqual(account_fields["observed_metric_fields"], ["followers", "following", "likes", "works"])
        self.assertEqual(account_fields["observed_field_count"], 11)
        self.assertEqual(account_fields["field_coverage"]["status"], "observed")
        self.assertEqual(account_fields["field_coverage"]["coverage_rate"], 1.0)
        self.assertIn("profile_tags", account_fields["observed_fields"])
        self.assertIn("metric_followers", account_fields["observed_fields"])

    def test_preserves_a_missing_public_account_field_state(self):
        record = enrich_profile_records([{}])[0]

        account_fields = record["public_account_fields"]
        self.assertEqual(account_fields["observed_fields"], [])
        self.assertEqual(account_fields["field_coverage"]["status"], "not_observed")
        self.assertEqual(account_fields["field_coverage"]["possible_field_count"], 11)
        self.assertIn("metric_followers", account_fields["field_coverage"]["missing_fields"])


if __name__ == "__main__":
    unittest.main()
