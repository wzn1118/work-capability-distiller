import importlib.util
import json
import pathlib
import unittest


SCRIPT_PATH = pathlib.Path(__file__).with_name("collect_video_media_relay.py")
SPEC = importlib.util.spec_from_file_location("collect_video_media_relay", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class VideoMediaRelayPureFunctionTests(unittest.TestCase):
    def test_scrub_https_url_drops_query_and_fragment(self):
        value = "https://media.example/video.mp4?signature=secret#fragment"
        self.assertEqual(MODULE.scrub_https_url(value), "https://media.example/video.mp4")
        self.assertEqual(MODULE.scrub_https_url("https://user:secret@media.example/video.mp4"), "https://media.example/video.mp4")
        self.assertEqual(MODULE.scrub_https_url("http://media.example/video.mp4"), "")
        self.assertEqual(MODULE.scrub_https_url("data:video/mp4;base64,abc"), "")

    def test_platform_validation_is_https_and_platform_scoped(self):
        self.assertTrue(MODULE.is_platform_url("douyin", "https://www.douyin.com/video/123"))
        self.assertTrue(MODULE.is_platform_url("xiaohongshu", "https://www.xiaohongshu.com/explore/abc"))
        self.assertFalse(MODULE.is_platform_url("douyin", "https://example.com/video/123"))
        self.assertFalse(MODULE.is_platform_url("douyin", "http://www.douyin.com/video/123"))

    def test_persisted_payload_does_not_contain_runtime_url_or_query(self):
        media = MODULE.clean_candidate({
            "visible": True,
            "currentSrc": "https://media.example/v.mp4?token=transient#part",
            "src": "",
            "sourceUrls": [],
            "poster": "https://media.example/p.jpg?token=transient",
            "duration": 12.5,
            "width": 1080,
            "height": 1920,
            "readyState": 4,
        })
        self.assertIsNotNone(media)
        artifact = MODULE.artifact_payload(
            "douyin",
            "https://www.douyin.com/video/123?share=1",
            "media_ready",
            "2026-07-22T00:00:00Z",
            media=media,
        )
        encoded = json.dumps(artifact)
        self.assertNotIn("runtimeMediaUrl", encoded)
        self.assertNotIn("token=transient", encoded)
        self.assertEqual(artifact["contentUrl"], "https://www.douyin.com/video/123")
        self.assertEqual(artifact["media"]["mediaUrl"], "https://media.example/v.mp4")

        runtime = MODULE.stdout_payload("media_ready", "output/result.json", media=media)
        self.assertEqual(runtime["runtimeMediaUrl"], "https://media.example/v.mp4?token=transient#part")
        self.assertEqual(runtime["mediaUrl"], "https://media.example/v.mp4")

    def test_candidate_requires_visible_https_media(self):
        self.assertIsNone(MODULE.clean_candidate({"visible": False, "currentSrc": "https://media.example/v.mp4"}))
        self.assertIsNone(MODULE.clean_candidate({"visible": True, "currentSrc": "blob:https://www.douyin.com/id"}))


if __name__ == "__main__":
    unittest.main()
