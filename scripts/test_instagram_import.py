import json
import tempfile
import unittest
from pathlib import Path

import instagram_import as importer


class InstagramImportTests(unittest.TestCase):
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
