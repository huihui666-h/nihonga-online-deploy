import json
import tempfile
import unittest
from urllib.error import HTTPError
from pathlib import Path

import instagram_import as importer


class InstagramImportTests(unittest.TestCase):
    def test_canonical_profile_url_rejects_host_routes_and_accepts_u_alias(self):
        self.assertEqual(importer.normalize_handle("instagram.com"), "")
        self.assertEqual(importer.normalize_handle("https://www.instagram.com/foo/bar/"), "")
        self.assertEqual(importer.normalize_handle("https://www.instagram.com/_u/Foo/"), "foo")
        self.assertEqual(importer.canonical_profile_url("//instagram.com/Foo?utm_source=x"), "https://www.instagram.com/foo/")

    def test_external_url_and_artist_source_normalization(self):
        self.assertEqual(
            importer.canonical_external_url("HTTPS://Example.COM/artist/?utm_source=feed#about"),
            "https://example.com/artist",
        )
        sources = importer.normalize_artist_sources({
            "handle": "@Artist_Name",
            "instagram": "https://instagram.com/Artist_Name/?utm_source=seed",
            "sourcePage": "https://example.com/artist/?b=2&a=1",
            "linkType": "gallery",
        })
        self.assertEqual(
            sources,
            [
                {"provider": "instagram", "username": "artist_name", "url": "https://www.instagram.com/artist_name/"},
                {"provider": "gallery", "url": "https://example.com/artist?a=1&b=2"},
            ],
        )
        record = importer.normalize_artist_record({"name": " A  Name ", "handle": "@Artist_Name", "styles": "日本画, 岩彩"})
        self.assertEqual(record["name"], "A Name")
        self.assertEqual(record["handle"], "@artist_name")
        self.assertEqual(record["styles"], ["日本画", "岩彩"])
        self.assertEqual(record["sources"][0]["username"], "artist_name")

    def test_retry_call_retries_transient_errors_with_exponential_backoff(self):
        calls = []
        sleeps = []

        def operation():
            calls.append(len(calls) + 1)
            if len(calls) < 3:
                raise TimeoutError("temporary timeout")
            return "ok"

        self.assertEqual(
            importer.retry_call(operation, attempts=3, backoff_seconds=0.5, sleep_fn=sleeps.append),
            "ok",
        )
        self.assertEqual(calls, [1, 2, 3])
        self.assertEqual(sleeps, [0.5, 1.0])

    def test_collect_candidates_retries_and_logs_without_leaking_bio(self):
        calls = []
        events = []

        def fake_fetch(url, timeout=30):
            calls.append(url)
            if len(calls) == 1:
                raise TimeoutError("temporary timeout")
            return {
                "name": "山田花子",
                "handle": "@Artist_Name",
                "note": "private@example.com",
                "relevance": "keyword",
            }

        result = importer.collect_candidates(
            ["https://www.instagram.com/Artist_Name/?utm_source=seed"],
            [],
            delay_seconds=0,
            check_robots=False,
            fetcher=fake_fetch,
            retry_attempts=2,
            retry_backoff_seconds=0,
            sleep_fn=lambda _: None,
            logger=events,
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["newArtists"][0]["handle"], "@artist_name")
        self.assertEqual(result["newArtists"][0]["instagram"], "https://www.instagram.com/artist_name/")
        self.assertNotIn("private@example.com", json.dumps(events, ensure_ascii=False))
        self.assertIn("fetch-retry", [event["event"] for event in events])

    def test_find_duplicate_and_idempotency_key_are_stable(self):
        existing = {"id": "A-1", "name": "Old", "handle": "@ARTIST_NAME"}
        candidate = {"name": "New", "instagram": "https://instagram.com/artist_name/?x=1"}
        duplicate = importer.find_duplicate_artist(candidate, [existing])
        self.assertIsNotNone(duplicate)
        self.assertEqual(duplicate[1], "instagram:artist_name")
        self.assertEqual(importer.artist_idempotency_key(candidate), importer.artist_idempotency_key({"handle": "@Artist_Name"}))
        self.assertEqual(
            importer.artist_idempotency_key({
                "handle": "@Artist_Name",
                "sourcePage": "https://example.com/old-profile",
            }),
            importer.artist_idempotency_key({
                "handle": "@artist_name",
                "sourcePage": "https://example.com/new-profile",
            }),
        )

    def test_push_artist_retries_with_same_idempotency_key(self):
        original_urlopen = importer.urlopen
        requests = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"ok": true}'

        def fake_urlopen(request, timeout=30):
            requests.append(request)
            if len(requests) == 1:
                raise TimeoutError("temporary timeout")
            return Response()

        try:
            importer.urlopen = fake_urlopen
            result = importer.push_artist(
                "https://example.test/api/admin-artists",
                {"name": "Artist", "handle": "@Artist_Name"},
                "PASSWORD",
                retry_attempts=2,
                retry_backoff_seconds=0,
            )
        finally:
            importer.urlopen = original_urlopen
        self.assertTrue(result["ok"])
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].headers["Idempotency-key"], requests[1].headers["Idempotency-key"])

    def test_logger_and_atomic_report_are_durable_and_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            folder_path = Path(folder)
            log_path = folder_path / "crawler.jsonl"
            logger = importer.CrawlerLogger(log_path, run_id="run-1")
            logger.event("candidate-accepted", handle="@artist", bio="private@example.com", count=1)
            lines = log_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1)
            self.assertNotIn("private@example.com", lines[0])
            self.assertEqual(json.loads(lines[0])["runId"], "run-1")

            report_path = folder_path / "nested" / "report.json"
            importer.write_json_atomic(report_path, {"ok": True})
            self.assertEqual(json.loads(report_path.read_text(encoding="utf-8")), {"ok": True})
            self.assertEqual(list(report_path.parent.glob("*.tmp")), [])

    def test_push_state_round_trip_and_error_entries_are_resumable(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "state.json"
            state = {"version": 1, "records": {"key": {"status": "error"}}}
            importer.save_push_state(path, state)
            loaded = importer.load_push_state(path)
            self.assertEqual(loaded["records"]["key"]["status"], "error")
    def test_normalize_handle_and_reject_non_profile_paths(self):
        self.assertEqual(importer.normalize_handle("@Artist_Name"), "artist_name")
        self.assertEqual(
            importer.normalize_handle("https://instagram.com/Artist_Name/?utm_source=seed"),
            "artist_name",
        )
        self.assertEqual(importer.normalize_handle("https://www.instagram.com/p/ABC123/"), "")
        self.assertEqual(importer.normalize_handle("https://example.com/artist_name"), "")
        self.assertEqual(
            importer.first_valid_handle("not a handle", "https://instagram.com/artist_name/"),
            "artist_name",
        )

    def test_parse_public_metadata_without_contact_details(self):
        profile = importer.parse_profile_html(
            """
            <html><head>
              <meta property="og:title" content="山田花子 (@hana_art) • Instagram">
              <meta property="og:description" content="日本画家。岩絵具を用いた作品。1,234 Followers 20 Following">
              <meta property="og:url" content="https://www.instagram.com/hana_art/">
              <script type="application/ld+json">
                {"@type":"Person","name":"山田花子","description":"日本画家。連絡 hana@example.com"}
              </script>
            </head></html>
            """,
            "https://www.instagram.com/hana_art/",
        )
        self.assertEqual(profile["name"], "山田花子")
        self.assertEqual(profile["handle"], "@hana_art")
        self.assertIn("日本画", profile["keywordHits"])
        self.assertIn("岩彩", profile["styles"])
        self.assertNotIn("hana@example.com", profile["note"])
        self.assertNotIn("1,234 Followers", profile["note"])

    def test_parse_school_and_region_from_public_bio(self):
        profile = importer.parse_profile_html(
            """
            <html><head>
              <meta property="og:title" content="山田花子 (@hana_art) • Instagram">
              <meta property="og:description" content="日本画家。東京藝術大学 日本画専攻。">
              <meta property="og:url" content="https://www.instagram.com/hana_art/">
            </head></html>
            """,
            "https://www.instagram.com/hana_art/",
        )
        self.assertEqual(profile["school"], "東京藝術大学")
        self.assertEqual(profile["region"], "東京")
        self.assertIn("東京藝術大学", profile["styles"])

    def test_seed_loading_deduplicates_case_and_reports_invalid(self):
        urls, invalid = importer.load_seed_urls(
            [
                "@Artist_Name",
                "https://www.instagram.com/artist_name/",
                "https://www.instagram.com/p/ABC123/",
            ],
            None,
        )
        self.assertEqual(urls, ["https://www.instagram.com/artist_name/"])
        self.assertEqual(invalid, ["https://www.instagram.com/p/ABC123/"])

    def test_seed_loading_reads_instagram_following_export_json_and_html(self):
        export = {
            "relationships_following": [
                {
                    "title": "Artist_Name",
                    "string_list_data": [
                        {"href": "https://www.instagram.com/Artist_Name/", "value": "Artist_Name"}
                    ],
                },
                {"title": "Second_Artist", "string_list_data": [{"value": "Second_Artist"}]},
            ]
        }
        with tempfile.TemporaryDirectory() as folder:
            json_path = Path(folder) / "following.json"
            html_path = Path(folder) / "following.html"
            json_path.write_text(json.dumps(export), encoding="utf-8")
            html_path.write_text(
                '<a href="https://www.instagram.com/Artist_Name/">Artist_Name</a>'
                '<a href="https://www.instagram.com/second_artist/">Second_Artist</a>',
                encoding="utf-8",
            )
            json_urls, json_invalid = importer.load_seed_urls([], str(json_path))
            html_urls, html_invalid = importer.load_seed_urls([], str(html_path))
        self.assertEqual(
            json_urls,
            ["https://www.instagram.com/artist_name/", "https://www.instagram.com/second_artist/"],
        )
        self.assertEqual(json_invalid, [])
        self.assertEqual(
            html_urls,
            ["https://www.instagram.com/artist_name/", "https://www.instagram.com/second_artist/"],
        )
        self.assertEqual(html_invalid, [])

    def test_collect_candidates_deduplicates_existing_and_results(self):
        def fake_fetch(url, timeout=30):
            handle = importer.normalize_handle(url)
            return {
                "name": handle,
                "handle": f"@{handle}",
                "relevance": "keyword",
                "styles": ["日本画"],
            }

        result = importer.collect_candidates(
            [
                "https://www.instagram.com/known/",
                "https://www.instagram.com/new_artist/",
                "https://www.instagram.com/new_artist/",
            ],
            [{"handle": "@KNOWN"}],
            delay_seconds=0,
            check_robots=False,
            fetcher=fake_fetch,
        )
        self.assertEqual(result["summary"]["new"], 1)
        self.assertEqual(result["summary"]["duplicates"], 2)
        self.assertEqual(result["newArtists"][0]["handle"], "@new_artist")

    def test_collect_candidates_blocks_existing_name_without_handle_match(self):
        def fake_fetch(url, timeout=30):
            return {"name": "山田花子", "handle": "@new_handle", "relevance": "keyword"}

        result = importer.collect_candidates(
            ["https://www.instagram.com/new_handle/"],
            [{"name": "山田花子", "handle": "@old_handle"}],
            delay_seconds=0,
            check_robots=False,
            fetcher=fake_fetch,
        )
        self.assertEqual(result["newArtists"], [])
        self.assertEqual(result["duplicates"][0]["reason"], "already-in-artists-name")

    def test_require_keyword_keeps_unclassified_profiles_out(self):
        def fake_fetch(url, timeout=30):
            return {"name": "Unknown", "handle": "@unknown", "relevance": "unclassified"}

        result = importer.collect_candidates(
            ["https://www.instagram.com/unknown/"],
            [],
            delay_seconds=0,
            check_robots=False,
            require_keyword=True,
            fetcher=fake_fetch,
        )
        self.assertEqual(result["newArtists"], [])
        self.assertEqual(result["rejected"][0]["reason"], "no-nihonga-keyword")


if __name__ == "__main__":
    unittest.main()
