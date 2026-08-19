import importlib.util
import pathlib
import sys
import types
import unittest


SCRIPT_DIRECTORY = pathlib.Path(__file__).resolve().parent
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))


def ensure_playwright_stub():
    try:
        import playwright.sync_api  # noqa: F401
    except ModuleNotFoundError:
        playwright = types.ModuleType("playwright")
        sync_api = types.ModuleType("playwright.sync_api")
        sync_api.sync_playwright = None
        sys.modules["playwright"] = playwright
        sys.modules["playwright.sync_api"] = sync_api


def load_relay_module(filename):
    ensure_playwright_stub()
    script_path = SCRIPT_DIRECTORY / filename
    module_name = script_path.stem
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


DOUYIN = load_relay_module("collect_douyin_relay.py")
XIAOHONGSHU = load_relay_module("collect_xiaohongshu_relay.py")


class ProfileRelayLimitTests(unittest.TestCase):
    def assert_profile_limit_policy(self, module):
        self.assertEqual(module.PROFILE_SAMPLE_LIMIT, 10000)
        self.assertEqual(module.MAX_PROFILE_SAMPLE_LIMIT, 10000)
        self.assertEqual(module.profile_scroll_budget(1), 6)
        self.assertEqual(module.profile_scroll_budget(1500), 375)
        self.assertEqual(module.profile_scroll_budget(10000), 2500)
        self.assertEqual(module.profile_scroll_budget(50000), 2500)
        self.assertEqual(module.profile_idle_scroll_limit(1), 2)
        self.assertEqual(module.profile_idle_scroll_limit(1500), 5)
        self.assertEqual(module.profile_idle_scroll_limit(10000), 5)
        self.assertEqual(module.profile_idle_scroll_limit(50000), 5)

    def test_douyin_profile_limit_policy(self):
        self.assert_profile_limit_policy(DOUYIN)

    def test_xiaohongshu_profile_limit_policy(self):
        self.assert_profile_limit_policy(XIAOHONGSHU)

    def test_profile_coverage_distinguishes_requested_limit_from_page_exhaustion(self):
        for module in (DOUYIN, XIAOHONGSHU):
            capped = module.profile_collection_coverage(
                "sample_limit_reached",
                24,
                24,
            )
            self.assertEqual(capped["requested_content_sample_limit"], 24)
            self.assertEqual(capped["returned_visible_content_samples"], 24)
            self.assertTrue(capped["requested_limit_reached"])
            self.assertFalse(capped["public_profile_pages_exhausted"])
            self.assertTrue(capped["more_public_content_may_be_available"])
            self.assertFalse(capped["continuation_recommended"])
            self.assertEqual(capped["coverage_state"], "requested_limit_reached")
            self.assertEqual(capped["next_collection_action"], "increase_sample_limit")

            exhausted = module.profile_collection_coverage(
                "page_exhausted",
                1500,
                137,
            )
            self.assertTrue(exhausted["public_profile_pages_exhausted"])
            self.assertFalse(exhausted["more_public_content_may_be_available"])
            self.assertFalse(exhausted["continuation_recommended"])
            self.assertEqual(exhausted["coverage_state"], "page_exhausted")

            resumable = module.profile_collection_coverage(
                "scroll_budget_reached",
                1500,
                812,
            )
            self.assertFalse(resumable["public_profile_pages_exhausted"])
            self.assertTrue(resumable["more_public_content_may_be_available"])
            self.assertTrue(resumable["continuation_recommended"])
            self.assertEqual(resumable["coverage_state"], "resumable")
            self.assertEqual(resumable["next_collection_action"], "resume_collection")


if __name__ == "__main__":
    unittest.main()
