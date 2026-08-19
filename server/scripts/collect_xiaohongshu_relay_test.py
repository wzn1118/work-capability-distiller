import importlib.util
import pathlib
import sys
import types
import unittest
from unittest import mock


SCRIPT_DIRECTORY = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))
SCRIPT_PATH = SCRIPT_DIRECTORY / "collect_xiaohongshu_relay.py"


def ensure_playwright_stub():
    try:
        import playwright.sync_api  # noqa: F401
    except ModuleNotFoundError:
        playwright = types.ModuleType("playwright")
        sync_api = types.ModuleType("playwright.sync_api")
        sync_api.sync_playwright = None
        sys.modules["playwright"] = playwright
        sys.modules["playwright.sync_api"] = sync_api


def load_module():
    ensure_playwright_stub()
    spec = importlib.util.spec_from_file_location("collect_xiaohongshu_relay_under_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


MODULE = load_module()


class FakePage:
    def __init__(self, payload):
        self.payload = payload
        self.script = ""
        self.arguments = None

    def evaluate(self, script, arguments):
        self.script = script
        self.arguments = arguments
        return self.payload


class FakeClock:
    def __init__(self):
        self.seconds = 0.0

    def monotonic(self):
        return self.seconds


class WaitPage:
    def __init__(self, clock):
        self.clock = clock
        self.waits = []

    def wait_for_timeout(self, milliseconds):
        self.waits.append(milliseconds)
        self.clock.seconds += milliseconds / 1000


class FakeMouse:
    def __init__(self):
        self.wheels = []

    def wheel(self, horizontal, vertical):
        self.wheels.append((horizontal, vertical))


class ProfileWaitPage(WaitPage):
    def __init__(self, clock):
        super().__init__(clock)
        self.mouse = FakeMouse()


class XiaohongshuVisibleProfileCardTests(unittest.TestCase):
    def test_visible_snapshot_retains_public_card_fields_and_provenance(self):
        page = FakePage({
            "sourceProfileUrl": "https://www.xiaohongshu.com/user/profile/creator?xsec_token=temporary",
            "renderedCardCount": 1,
            "samples": [{
                "note_url": "https://www.xiaohongshu.com/explore/abc123?xsec_token=temporary#share",
                "title": "夏日护肤记录",
                "body": "夏日护肤记录 #护肤",
                "published_at": "2026-07-20 10:30",
                "published_time_text": "2026-07-20 10:30",
                "statistics": {
                    "like_count": "1.2w",
                    "collect_count": "340",
                    "comment_count": "12",
                    "share_count": "7",
                },
                "captured_at": "2026-07-24T01:02:03.000Z",
            }],
        })

        snapshot = MODULE.extract_visible_profile_samples(page, 10)

        self.assertEqual(snapshot["rendered_card_count"], 1)
        self.assertEqual(len(snapshot["samples"]), 1)
        sample = snapshot["samples"][0]
        self.assertEqual(sample["note_url"], "https://www.xiaohongshu.com/explore/abc123")
        self.assertEqual(sample["source_url"], sample["note_url"])
        self.assertEqual(sample["content_id"], "abc123")
        self.assertEqual(sample["statistics"]["like_count"], "1.2w")
        self.assertEqual(sample["statistics"]["collect_count"], "340")
        self.assertEqual(sample["source_evidence"]["scope"], "visible_public_profile_card")
        self.assertEqual(sample["source_evidence"]["source_profile_url"], "https://www.xiaohongshu.com/user/profile/creator")
        self.assertEqual(sample["source_evidence"]["fields"]["statistics.collect_count"], "rendered_visible_card")
        self.assertNotIn("temporary", str(sample))
        self.assertIn("collect_count", page.script)
        self.assertIn("visiblePublishedAt", page.script)

    def test_invalid_or_non_content_urls_are_not_emitted_as_source_works(self):
        samples = MODULE.normalize_profile_card_samples([
            {"note_url": "https://www.xiaohongshu.com/search_result/?keyword=skincare", "title": "not a work"},
            {"note_url": "https://example.com/explore/abc", "title": "not a work"},
            {"note_url": "https://www.xiaohongshu.com/explore/real-work", "title": "real work"},
        ], "https://www.xiaohongshu.com/user/profile/creator")

        self.assertEqual([sample["content_id"] for sample in samples], ["real-work"])

    def test_merge_keeps_metrics_observed_in_earlier_virtual_list_snapshot(self):
        first = MODULE.normalize_profile_card_samples([{
            "note_url": "https://www.xiaohongshu.com/explore/abc123",
            "statistics": {"like_count": "998", "collect_count": "73"},
            "captured_at": "2026-07-24T01:02:03.000Z",
        }], "https://www.xiaohongshu.com/user/profile/creator")
        later = [{
            "note_url": "https://www.xiaohongshu.com/explore/abc123?share=1",
            "title": "完整标题",
            "published_at": "2026-07-20",
            "statistics": {"comment_count": "11"},
        }]

        merged = MODULE.merge_profile_samples(first, later, limit=10)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["statistics"], {
            "like_count": "998",
            "collect_count": "73",
            "comment_count": "11",
        })
        self.assertEqual(merged[0]["title"], "完整标题")
        self.assertEqual(merged[0]["source_evidence"]["scope"], "visible_public_profile_card")

    def test_incremental_merge_reuses_identity_index_without_changing_order_or_field_fill(self):
        merged = []
        positions = {}
        first = [{
            "note_url": "https://www.xiaohongshu.com/explore/first?share=1",
            "title": "first title",
            "statistics": {"like_count": "10"},
        }]
        later = [{
            "note_url": "https://www.xiaohongshu.com/explore/first",
            "statistics": {"collect_count": "3"},
        }, {
            "note_url": "https://www.xiaohongshu.com/explore/second",
            "title": "second title",
        }]

        MODULE.merge_profile_samples_into(merged, positions, first, limit=10)
        MODULE.merge_profile_samples_into(merged, positions, later, limit=10)

        self.assertEqual([sample["title"] for sample in merged], ["first title", "second title"])
        self.assertEqual(merged[0]["statistics"], {"like_count": "10", "collect_count": "3"})
        self.assertEqual(len(positions), 2)


class XiaohongshuAdaptiveWaitTests(unittest.TestCase):
    @staticmethod
    def surface(**overrides):
        state = {
            "visible_card_roots": 1,
            "visible_content_links": 1,
            "visible_profile_links": 1,
            "visible_identity_fingerprint": "first",
            "top": 0,
            "height": 100,
            "client_height": 100,
            "at_bottom": False,
            "terminal_marker": "",
        }
        state.update(overrides)
        return state

    def test_search_update_returns_immediately_for_visible_content_mutation(self):
        clock = FakeClock()
        page = WaitPage(clock)
        before = self.surface()
        changed = self.surface(visible_identity_fingerprint="second", top=120)

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=False),
            mock.patch.object(MODULE, "has_verification_wall", return_value=False),
            mock.patch.object(MODULE, "search_surface_state", return_value=changed),
        ):
            latest = MODULE.wait_for_search_update(page, before)

        self.assertEqual(latest, changed)
        self.assertEqual(page.waits, [])

    def test_search_update_polls_after_scroll_only_state_until_content_arrives(self):
        clock = FakeClock()
        page = WaitPage(clock)
        before = self.surface()
        scroll_only = self.surface(top=120)
        changed = self.surface(top=120, visible_identity_fingerprint="second")

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=False),
            mock.patch.object(MODULE, "has_verification_wall", return_value=False),
            mock.patch.object(MODULE, "search_surface_state", side_effect=[scroll_only, changed]),
        ):
            latest = MODULE.wait_for_search_update(page, before)

        self.assertEqual(latest, changed)
        self.assertGreater(sum(page.waits), 0)
        self.assertLess(sum(page.waits), MODULE.SEARCH_SCROLL_INITIAL_SETTLE_MS)

    def test_search_update_keeps_prior_budget_when_no_surface_signal_exists(self):
        clock = FakeClock()
        page = WaitPage(clock)
        before = self.surface()

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=False),
            mock.patch.object(MODULE, "has_verification_wall", return_value=False),
            mock.patch.object(MODULE, "search_surface_state", return_value=before),
        ):
            latest = MODULE.wait_for_search_update(page, before, timeout_ms=100)

        self.assertEqual(latest, before)
        expected_budget = MODULE.SEARCH_SCROLL_INITIAL_SETTLE_MS + 100
        self.assertGreaterEqual(sum(page.waits), expected_budget)
        self.assertLessEqual(sum(page.waits), expected_budget + 2)

    def test_search_update_stops_without_waiting_when_login_appears(self):
        clock = FakeClock()
        page = WaitPage(clock)
        before = self.surface()

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=True),
        ):
            latest = MODULE.wait_for_search_update(page, before)

        self.assertEqual(latest, before)
        self.assertEqual(page.waits, [])

    def test_profile_scroll_captures_new_card_before_the_previous_fixed_wait(self):
        clock = FakeClock()
        page = ProfileWaitPage(clock)
        first_state = self.surface()
        second_state = self.surface(visible_identity_fingerprint="second")
        first = {
            "samples": [{"note_url": "https://www.xiaohongshu.com/explore/first", "title": "first"}],
            "rendered_card_count": 1,
        }
        second = {
            "samples": [{"note_url": "https://www.xiaohongshu.com/explore/second", "title": "second"}],
            "rendered_card_count": 1,
        }

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=False),
            mock.patch.object(MODULE, "has_verification_wall", return_value=False),
            mock.patch.object(MODULE, "profile_scroll_budget", return_value=1),
            mock.patch.object(MODULE, "profile_content_surface_state", side_effect=[first_state, second_state]),
            mock.patch.object(MODULE, "extract_visible_profile_samples", side_effect=[first, second]),
        ):
            result = MODULE.warm_profile_content(page, profile_sample_limit=10)

        self.assertEqual(result["stop_reason"], "scroll_budget_reached")
        self.assertEqual([sample["title"] for sample in result["latest_samples"]], ["first", "second"])
        self.assertEqual(page.waits, [])
        self.assertEqual(page.mouse.wheels, [(0, 1800)])

    def test_profile_scroll_marks_idle_grid_retryable_without_terminal_evidence(self):
        clock = FakeClock()
        page = ProfileWaitPage(clock)
        state = self.surface()
        snapshot = {
            "samples": [{"note_url": "https://www.xiaohongshu.com/explore/first", "title": "first"}],
            "rendered_card_count": 1,
        }

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=False),
            mock.patch.object(MODULE, "has_verification_wall", return_value=False),
            mock.patch.object(MODULE, "profile_scroll_budget", return_value=2),
            mock.patch.object(MODULE, "profile_idle_scroll_limit", return_value=2),
            mock.patch.object(MODULE, "profile_content_surface_state", return_value=state),
            mock.patch.object(MODULE, "extract_visible_profile_samples", return_value=snapshot),
        ):
            result = MODULE.warm_profile_content(page, profile_sample_limit=10)

        self.assertEqual(result["stop_reason"], "public_profile_settled_retryable")
        self.assertEqual(result["idle_rounds"], 2)
        self.assertEqual(result["scrolls"], 2)
        self.assertGreaterEqual(sum(page.waits), MODULE.PROFILE_SCROLL_SETTLE_TIMEOUT_MS * 2)

    def test_profile_scroll_accepts_page_exhausted_only_with_bottom_terminal_marker(self):
        clock = FakeClock()
        page = ProfileWaitPage(clock)
        state = self.surface(at_bottom=True, terminal_marker="\u6ca1\u6709\u66f4\u591a\u5185\u5bb9")
        snapshot = {
            "samples": [{"note_url": "https://www.xiaohongshu.com/explore/first", "title": "first"}],
            "rendered_card_count": 1,
        }

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=False),
            mock.patch.object(MODULE, "has_verification_wall", return_value=False),
            mock.patch.object(MODULE, "profile_scroll_budget", return_value=2),
            mock.patch.object(MODULE, "profile_idle_scroll_limit", return_value=2),
            mock.patch.object(MODULE, "profile_content_surface_state", return_value=state),
            mock.patch.object(MODULE, "extract_visible_profile_samples", return_value=snapshot),
        ):
            result = MODULE.warm_profile_content(page, profile_sample_limit=10)

        self.assertEqual(result["stop_reason"], "page_exhausted")
        self.assertEqual(result["terminal_end_evidence"], {
            "at_bottom": True,
            "terminal_marker": "\u6ca1\u6709\u66f4\u591a\u5185\u5bb9",
        })

    def test_profile_scroll_budget_is_a_safety_guard_not_a_target_conversion(self):
        self.assertEqual(MODULE.profile_scroll_budget(24), MODULE.MAX_PROFILE_CONTENT_SCROLLS)
        self.assertEqual(MODULE.profile_scroll_budget(10_000), MODULE.MAX_PROFILE_CONTENT_SCROLLS)

    def test_profile_update_returns_retryable_login_without_waiting(self):
        clock = FakeClock()
        page = ProfileWaitPage(clock)
        before = self.surface()

        with (
            mock.patch.object(MODULE.time, "monotonic", clock.monotonic),
            mock.patch.object(MODULE, "has_login_wall", return_value=True),
        ):
            latest, access_state = MODULE.wait_for_profile_content_update(page, before)

        self.assertEqual(latest, before)
        self.assertEqual(access_state, "login")
        self.assertEqual(page.waits, [])


if __name__ == "__main__":
    unittest.main()
