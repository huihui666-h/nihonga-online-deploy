import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import instagram_reviewed_push as reviewed


class ReviewedInstagramPushTests(unittest.TestCase):
    def test_build_report_maps_public_artist_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audit = root / "audit.json"
            approved = root / "approved.txt"
            audit.write_text(
                json.dumps(
                    {
                        "review": [
                            {
                                "handle": "@anzu_moch",
                                "publicBio": "水江 杏実 多摩美術大学 日本画専攻",
                                "score": 8,
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            approved.write_text("anzu_moch\n", encoding="utf-8")
            report = reviewed.build_report(audit, approved)
            self.assertEqual(report["summary"]["approved"], 1)
            artist = report["newArtists"][0]
            self.assertEqual(artist["name"], "水江 杏実")
            self.assertEqual(artist["handle"], "@anzu_moch")
            self.assertEqual(artist["school"], "多摩美術大学")
            self.assertEqual(artist["linkType"], "instagram")
            self.assertEqual(artist["sources"][0]["username"], "anzu_moch")

    def test_push_state_skips_successful_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audit = root / "audit.json"
            approved = root / "approved.txt"
            password = root / "password.txt"
            state = root / "state.json"
            log = root / "events.jsonl"
            audit.write_text(
                json.dumps({"review": [{"handle": "artist_1", "publicBio": "日本画"}]}, ensure_ascii=False),
                encoding="utf-8",
            )
            approved.write_text("artist_1\n", encoding="utf-8")
            password.write_text("test-password", encoding="utf-8")
            calls = []

            def fake_push(endpoint, artist, password_value, **kwargs):
                calls.append((endpoint, artist["handle"], password_value))
                return {"ok": True, "status": 200, "attempts": 1}

            report = reviewed.build_report(audit, approved)
            with patch.object(reviewed, "push_artist", fake_push):
                reviewed._push_report(
                    report,
                    endpoint="https://example.test/api/admin-artists",
                    password_file=password,
                    state_file=state,
                    log_file=log,
                    retry_attempts=1,
                    retry_backoff=0,
                )
                second_report = reviewed.build_report(audit, approved)
                reviewed._push_report(
                    second_report,
                    endpoint="https://example.test/api/admin-artists",
                    password_file=password,
                    state_file=state,
                    log_file=log,
                    retry_attempts=1,
                    retry_backoff=0,
                )

            self.assertEqual(len(calls), 1)
            self.assertEqual(second_report["pushSummary"]["skipped"], 1)
            self.assertNotIn("test-password", log.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
