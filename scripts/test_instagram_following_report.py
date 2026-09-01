import json
import tempfile
import unittest
from pathlib import Path

try:
    import instagram_following_report as report
except ImportError:  # Support direct module discovery from the project root.
    from scripts import instagram_following_report as report


class InstagramFollowingReportTests(unittest.TestCase):
    def test_load_following_supports_browser_and_accounts_center_shapes(self):
        payload = {
            "following": [
                {"display": "山田花子", "handle": "hana_art"},
                {
                    "title": "佐藤太郎",
                    "string_list_data": [{"href": "https://www.instagram.com/taro_art/"}],
                },
            ]
        }
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "following.json"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            rows = report.load_following(path)
        self.assertEqual([row["handle"] for row in rows], ["hana_art", "taro_art"])
        self.assertEqual(rows[1]["name"], "佐藤太郎")

    def test_load_following_supports_plain_url_list(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "following.txt"
            path.write_text(
                "https://www.instagram.com/first_artist/\n@second_artist\n# comment\n",
                encoding="utf-8",
            )
            rows = report.load_following(path)
        self.assertEqual([row["handle"] for row in rows], ["first_artist", "second_artist"])

    def test_load_following_supports_discovery_profile_snapshot(self):
        payload = {
            "profiles": [
                {"handle": "@discovered_artist", "name": "发现画家"},
            ]
        }
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "discovery.json"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            rows = report.load_following(path)
        self.assertEqual(rows, [{"handle": "discovered_artist", "name": "发现画家"}])

    def test_classifier_separates_artist_institution_and_aspirant(self):
        artist = report.classify_profile({
            "handle": "hana_art",
            "name": "山田花子",
            "publicBio": "日本画家。岩絵具を用いて制作しています。",
        })
        institution = report.classify_profile({
            "handle": "example_nihonga",
            "name": "美術大学 日本画研究室",
        })
        aspirant = report.classify_profile({
            "handle": "future_nihonga",
            "name": "日本画志望の受験生",
        })
        self.assertEqual(artist["bucket"], "highConfidence")
        self.assertEqual(institution["bucket"], "excluded")
        self.assertEqual(aspirant["bucket"], "review")

    def test_material_phrase_is_not_mislabeled_as_artist_phrase(self):
        profile = report.classify_profile({
            "handle": "materials_only",
            "name": "材料记录",
            "publicBio": "I paint mainly with Japanese painting materials.",
        })
        self.assertNotIn("Japanese painting artist", profile["evidence"])

    def test_classifier_redacts_contact_details(self):
        profile = report.classify_profile({
            "handle": "contact_artist",
            "name": "日本画家",
            "publicBio": "日本画家 contact@example.com +81 90 1234 5678",
        })
        self.assertNotIn("contact@example.com", profile["publicBio"])
        self.assertNotIn("+81 90", profile["publicBio"])

    def test_build_report_deduplicates_before_classification(self):
        result = report.build_report(
            [
                {"handle": "known", "name": "既存"},
                {"handle": "new_artist", "name": "新人"},
            ],
            {"known"},
            set(),
            {"new_artist": {"publicBio": "Nihonga artist using mineral pigments."}},
        )
        self.assertEqual(result["summary"]["duplicates"], 1)
        self.assertEqual(result["summary"]["highConfidence"], 1)
        self.assertEqual(result["writeMode"], "local-review-only; no network and no website mutations")

    def test_build_report_preserves_candidate_source_label(self):
        result = report.build_report([], set(), set(), {}, source="instagram-discover-people")
        self.assertEqual(result["source"], "instagram-discover-people")

    def test_discovery_following_status_is_preserved(self):
        profile = report.classify_profile({
            "handle": "discovered_artist",
            "name": "发现画家",
            "publicBio": "日本画家",
            "followingStatus": "not-following-at-observation",
        })
        self.assertEqual(profile["followingStatus"], "not-following-at-observation")


if __name__ == "__main__":
    unittest.main()
