import argparse
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from news.ai_processor import AIProcessor, AIProcessorError, determine_status, normalize_ai_result
from news.config import NewsSource, load_sources
from news.crawler import NewsCrawler, RawNewsItem, canonical_url, parse_detail_document, parse_feed_document, parse_html_document
from news.matching import match_artists
from scripts.news_crawler import SupabaseNewsStore, _deduplicate, _expire, _public_item, _record, _state_entry_merge
import scripts.news_crawler as news_command


class NewsPipelineTests(unittest.TestCase):
    def test_state_merge_keeps_ai_payload_coherent_after_later_failure(self):
        successful = {
            "status": "published",
            "processed_at": "2026-09-01T06:00:00+00:00",
            "ai_processed": True,
            "database_written": False,
            "links_written": False,
            "record": {
                "title": "日本画展",
                "summary": "公式発表の要点をまとめた摘要。",
                "category": "exhibition",
                "source_name": "日本美術院",
                "source_url": "https://example.test/news/1",
                "source_item_id": "item-1",
                "content_fingerprint": "a" * 64,
                "published_at": "2026-09-01",
                "start_date": "2026-10-01",
                "end_date": "2026-10-31",
                "venue": "中央美術館",
                "raw_artist_names": ["山田花子"],
                "tags": ["日本画"],
                "relevance_score": 0.95,
                "status": "published",
                "raw_excerpt": "会期 2026年10月1日から10月31日。",
            },
        }
        later_failure = {
            "status": "candidate",
            "processed_at": "2026-09-01T06:01:00+00:00",
            "ai_processed": False,
            "database_written": False,
            "links_written": False,
            "record": {
                "title": "日本画展",
                "summary": "",
                "category": "exhibition",
                "source_name": "日本美術院",
                "source_url": "https://example.test/news/1",
                "source_item_id": "item-1",
                "content_fingerprint": "b" * 64,
                "published_at": "2026-09-01",
                "start_date": "2026-10-01",
                "end_date": "2026-10-31",
                "venue": "中央美術館",
                "raw_artist_names": [],
                "tags": [],
                "relevance_score": None,
                "status": "candidate",
                "raw_excerpt": "会期 2026年10月1日から10月31日。",
            },
        }
        merged = _state_entry_merge(successful, later_failure)
        self.assertTrue(merged["ai_processed"])
        self.assertEqual(merged["record"]["summary"], successful["record"]["summary"])
        self.assertEqual(merged["status"], "published")
        self.assertFalse(merged["database_written"])

    def test_canonical_url_removes_tracking_and_fragment(self):
        self.assertEqual(
            canonical_url("HTTPS://Example.TEST/news/?utm_source=x&id=4#top"),
            "https://example.test/news?id=4",
        )

    def test_html_parser_extracts_bounded_candidate(self):
        source = NewsSource(key="museum", name="美術館", url="https://example.test/news", keywords=("日本画",))
        html = """
        <html><head><meta name='description' content='日本画の展覧会。会場：中央美術館。2026年10月1日 - 2026年12月1日'></head>
        <body><a href='/exhibition/1?utm_medium=mail'>日本画 新作展</a><a href='/about'>概要</a></body></html>
        """
        items = parse_html_document(html, source)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].source_url, "https://example.test/exhibition/1")
        self.assertEqual(items[0].start_date, "2026-10-01")
        self.assertEqual(items[0].end_date, "2026-12-01")
        self.assertIn("中央美術館", items[0].venue)
        self.assertLessEqual(len(items[0].excerpt), 1400)

    def test_html_parser_uses_heading_for_generic_detail_link(self):
        source = NewsSource(
            key="institute",
            name="日本美術院",
            url="https://example.test/exhibitions_list.php",
            keywords=("院展",),
            link_prefixes=("/exhibitions_detail.php",),
        )
        body = "<div><h4>第111回院展</h4><a href='exhibitions_detail.php?id=1'>詳細はこちら　＞</a></div>"
        items = parse_html_document(body, source)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].title, "第111回院展")

    def test_rss_parser_supports_atom_namespaces(self):
        source = NewsSource(key="museum", name="美術館", url="https://example.test/feed.xml", kind="rss")
        feed = """<?xml version='1.0'?><feed xmlns='http://www.w3.org/2005/Atom'><entry><title>日本画展</title><link href='/a'/><summary>概要</summary><published>2026-09-01T10:00:00Z</published></entry></feed>"""
        items = parse_feed_document(feed, source)
        self.assertEqual(items[0].source_url, "https://example.test/a")
        self.assertEqual(items[0].published_at, "2026-09-01")

    def test_detail_parser_carries_year_and_extracts_venue(self):
        source = NewsSource(key="nitten-events", name="日展", url="https://example.test/event/", keywords=())
        item = RawNewsItem(
            title="開催中 日本画展 2026.8.29(土)～9.6(日)",
            source_name="日展",
            source_url="https://example.test/event/event-1",
            source_key=source.key,
        )
        detail = """
        <html><head><meta property='og:title' content='日本画展 - 日展'></head><body>
        <main><h1>日本画展</h1><p>＜会期＞ 2026.8.29(土)～9.6(日)</p>
        <p>＜会場＞ 愛知県・名古屋市 アートサロン光玄</p><p>＜作家情報＞ 山田花子</p></main>
        </body></html>
        """
        result = parse_detail_document(detail, source, item)
        self.assertEqual(result.start_date, "2026-08-29")
        self.assertEqual(result.end_date, "2026-09-06")
        self.assertEqual(result.venue, "愛知県・名古屋市 アートサロン光玄")
        self.assertLessEqual(len(result.excerpt), 1400)

    def test_detail_parser_supports_plain_museum_labels(self):
        source = NewsSource(key="museum", name="山種美術館", url="https://example.test/exhibitions/", keywords=())
        item = RawNewsItem(
            title="展覧会",
            source_name=source.name,
            source_url="https://example.test/exhibitions/2026/show.html",
            source_key=source.key,
        )
        result = parse_detail_document(
            "<main><p>会期 2026年10月10日(土)～12月6日(日)</p><p>会場 山種美術館</p><p>主催 山種美術館</p></main>",
            source,
            item,
        )
        self.assertEqual(result.start_date, "2026-10-10")
        self.assertEqual(result.end_date, "2026-12-06")
        self.assertEqual(result.venue, "山種美術館")

    def test_crawler_isolates_source_error_and_deduplicates_known_url(self):
        good = NewsSource(key="good", name="Good", url="https://good.test/news", keywords=())
        bad = NewsSource(key="bad", name="Bad", url="https://bad.test/news", keywords=())
        html = "<a href='/one'>日本画 event</a><a href='/one?utm_source=x'>日本画 event duplicate</a>"

        def fetch(url, timeout):
            if "bad.test" in url:
                raise TimeoutError("source timeout")
            return html, "text/html"

        result = NewsCrawler([bad, good], fetcher=fetch, retry_attempts=1).crawl(known_urls={"https://good.test/one"})
        self.assertEqual(len(result["items"]), 0)
        self.assertEqual(len(result["errors"]), 1)
        self.assertTrue(result["sources"][1]["fetched"])

    def test_crawler_reports_scanned_and_duplicate_counts(self):
        source = NewsSource(key="official", name="公式", url="https://example.test/news", keywords=())
        html = "<a href='/one'>日本画 event</a><a href='/one?utm_source=x'>日本画 event duplicate</a>"
        result = NewsCrawler([source], fetcher=lambda _url, _timeout: (html, "text/html")).crawl()
        self.assertEqual(result["scanned"], 1)
        self.assertEqual(result["duplicates"], 0)

    def test_duplicate_item_and_expiry_rules(self):
        raw = RawNewsItem(title="日展 日本画展", source_name="日展", source_url="https://example.test/event/1", end_date="2026-01-01")
        item = _record(raw)
        unique, duplicates = _deduplicate([item, dict(item)])
        self.assertEqual(len(unique), 1)
        self.assertEqual(duplicates, 1)
        unique[0]["status"] = "published"
        _expire(unique[0], date(2026, 9, 1))
        self.assertEqual(unique[0]["status"], "expired")

    def test_raw_excerpt_is_local_only_and_not_a_public_summary(self):
        item = _record(
            RawNewsItem(
                title="日本画展",
                source_name="公式",
                source_url="https://example.test/news/1",
                excerpt="公式ページから取得した限定的な本文抜粋",
            )
        )
        self.assertEqual(item["summary"], "")
        self.assertEqual(item["raw_excerpt"], "公式ページから取得した限定的な本文抜粋")
        self.assertNotIn("raw_excerpt", _public_item(item))

    def test_record_preserves_state_status_and_marks_bad_dates(self):
        item = _record(
            {
                "title": "日本画展",
                "source_name": "公式",
                "source_url": "https://example.test/news/1",
                "status": "published",
                "end_date": "2026-99-10",
            }
        )
        self.assertEqual(item["status"], "published")
        self.assertIsNone(item["end_date"])
        self.assertTrue(item["date_parse_error"])
        self.assertEqual(
            determine_status(
                {
                    "relevant": True,
                    "relevance_score": 0.95,
                    "category": "exhibition",
                    "title": "日本画展",
                    "summary": "公式発表の要点をまとめた短い摘要。",
                    "start_date": None,
                    "end_date": None,
                    "source_url": "https://example.test/news/1",
                },
                item,
                trusted_source=True,
                now=date(2026, 9, 1),
            ),
            "published",
        )

    def test_sync_links_adds_before_removing_stale_links(self):
        calls = []
        store = object.__new__(SupabaseNewsStore)

        def request(path, method="GET", payload=None, headers=None):
            calls.append((path, method, payload, headers))
            if method == "GET":
                return [{"artist_id": "old-artist"}]
            return []

        store.request = request
        store.sync_links("news-1", ["new-artist"])
        self.assertEqual([call[1] for call in calls], ["GET", "POST", "DELETE"])
        self.assertEqual(calls[1][2], [{"news_id": "news-1", "artist_id": "new-artist"}])
        self.assertIn("artist_id=in.(old-artist)", calls[2][0])

    def test_upsert_does_not_patch_other_url_for_fingerprint_duplicate(self):
        calls = []
        store = object.__new__(SupabaseNewsStore)
        item = _record(
            {
                "title": "同一展覧会",
                "source_name": "公式B",
                "source_url": "https://source-b.example/news/1",
                "content_fingerprint": "f" * 64,
            }
        )

        def request(path, method="GET", payload=None, headers=None):
            calls.append((path, method, payload, headers))
            if method == "POST":
                return []
            if "source_url=eq." in path:
                return []
            if "content_fingerprint=eq." in path:
                return [{"id": "existing", "source_url": "https://source-a.example/news/1", "status": "published"}]
            return []

        store.request = request
        saved = store.upsert(item)
        self.assertTrue(saved.get("_duplicate"))
        self.assertFalse(saved.get("_write_applied"))
        self.assertFalse(any(method == "PATCH" for _path, method, _payload, _headers in calls))

    def test_store_expires_existing_published_records(self):
        calls = []
        store = object.__new__(SupabaseNewsStore)
        store.request = lambda path, method="GET", payload=None, headers=None: calls.append(
            (path, method, payload, headers)
        ) or [{"id": "n1"}, {"id": "n2"}]
        self.assertEqual(store.expire_published(date(2026, 9, 1)), 2)
        self.assertIn("status=eq.published", calls[0][0])
        self.assertIn("category=in.(exhibition,open_call)", calls[0][0])
        self.assertIn("end_date=lt.2026-09-01", calls[0][0])
        self.assertEqual(calls[0][1], "PATCH")
        self.assertEqual(calls[0][2], {"status": "expired"})

    def test_missing_end_date_is_allowed(self):
        item = _record(RawNewsItem(title="日本美術院のお知らせ", source_name="日本美術院", source_url="https://example.test/news/1"))
        self.assertIsNone(item["end_date"])

    def test_ai_disabled_mode_and_strict_normalization(self):
        self.assertFalse(AIProcessor(api_key="").enabled)
        raw = {"title": "日本画展", "source_url": "https://example.test/a"}
        result = normalize_ai_result(
            {
                "relevant": True,
                "relevance_score": 0.9,
                "category": "exhibition",
                "title": "日本画展",
                "summary": "短い事实摘要",
                "artist_names": ["A", "A"],
                "venue": "中央美術館",
                "start_date": "2026-10-01",
                "end_date": None,
                "tags": ["展覧会", "展覧会"],
            },
            raw,
        )
        self.assertEqual(result["artist_names"], ["A"])
        self.assertEqual(determine_status(result, raw, trusted_source=True), "published")
        self.assertEqual(
            determine_status(
                {**result, "start_date": "2026-01-01", "end_date": "2026-02-01"},
                raw,
                trusted_source=True,
                now=date(2026, 9, 1),
            ),
            "expired",
        )
        self.assertEqual(determine_status({**result, "relevance_score": 0.2}, raw, trusted_source=True), "rejected")
        with self.assertRaises(AIProcessorError):
            normalize_ai_result({"relevant": True, "relevance_score": 1.1, "category": "exhibition"}, raw)
        with self.assertRaises(AIProcessorError):
            normalize_ai_result(
                {
                    "relevant": True,
                    "relevance_score": 0.9,
                    "category": "exhibition",
                    "title": "日本画展",
                    "summary": "摘要",
                    "start_date": "2026-10-01T00:00:00Z",
                },
                raw,
            )

    def test_ai_processor_accepts_strict_json_response(self):
        content = {
            "relevant": True,
            "relevance_score": 0.93,
            "category": "exhibition",
            "title": "日本画展",
            "summary": "日本画展の開催情報をまとめた短い摘要。",
            "artist_names": ["山田花子"],
            "venue": "中央美術館",
            "start_date": "2026-10-01",
            "end_date": "2026-10-31",
            "tags": ["日本画", "展覧会"],
        }
        processor = AIProcessor(
            api_key="test-key",
            request_fn=lambda _url, _payload, _timeout: {
                "choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)}}]
            },
        )
        result = processor.process({"title": "日本画展", "source_url": "https://example.test/news/1"})
        self.assertEqual(result["category"], "exhibition")
        self.assertEqual(result["artist_names"], ["山田花子"])

    def test_ai_processor_retries_rate_limit_then_recovers(self):
        calls = 0

        def request(_url, _payload, _timeout):
            nonlocal calls
            calls += 1
            if calls < 3:
                raise AIProcessorError("AI HTTP error 429")
            return {
                "relevant": True,
                "relevance_score": 0.9,
                "category": "nihonga_news",
                "title": "日本画のお知らせ",
                "summary": "日本画に関する公式情報の要点。",
                "artist_names": [],
                "venue": "",
                "start_date": None,
                "end_date": None,
                "tags": ["日本画"],
            }

        processor = AIProcessor(
            api_key="test-key",
            request_fn=request,
            retry_attempts=3,
            retry_backoff=0,
        )
        result = processor.process(
            {
                "title": "日本画のお知らせ",
                "source_url": "https://example.test/news/1",
                "raw_excerpt": "AI にだけ渡す抜粋",
            }
        )
        self.assertEqual(calls, 3)
        self.assertEqual(result["summary"], "日本画に関する公式情報の要点。")

    def test_state_resumes_candidates_when_ai_was_not_configured(self):
        class FakeCrawler:
            items = []

            def __init__(self, *_args, **_kwargs):
                pass

            def crawl(self, *_args):
                return {"items": list(self.items), "errors": [], "sources": [], "scanned": len(self.items), "duplicates": 0}

        class DisabledProcessor:
            enabled = False

            def __init__(self, **_kwargs):
                pass

            def process(self, _raw):
                return None

        with tempfile.TemporaryDirectory() as folder:
            state_path = Path(folder) / "state.json"
            args = argparse.Namespace(
                config=None,
                known_file=None,
                state_file=str(state_path),
                out=str(Path(folder) / "first.json"),
                log_file=None,
                timeout=1,
                retry_attempts=1,
                retry_backoff=0,
                process_ai=False,
                write=False,
                refresh=False,
            )
            FakeCrawler.items = [
                RawNewsItem(
                    title="日本画展",
                    source_name="公式",
                    source_url="https://example.test/news/1",
                    source_key="official",
                )
            ]
            with patch.object(news_command, "NewsCrawler", FakeCrawler):
                first = news_command.run(args)
            self.assertEqual(first["stats"]["new"], 1)

            FakeCrawler.items = []
            args.process_ai = True
            args.out = str(Path(folder) / "second.json")
            with patch.object(news_command, "NewsCrawler", FakeCrawler), patch.object(news_command, "AIProcessor", DisabledProcessor):
                second = news_command.run(args)
            self.assertEqual(second["stats"]["resumed_candidates"], 1)
            self.assertEqual(second["ai"]["paused"], 1)

    def test_database_setup_failure_keeps_local_batch_output(self):
        class FakeCrawler:
            def __init__(self, *_args, **_kwargs):
                pass

            def crawl(self, *_args):
                return {
                    "items": [
                        RawNewsItem(
                            title="日本画展",
                            source_name="公式",
                            source_url="https://example.test/news/1",
                            source_key="official",
                        )
                    ],
                    "errors": [],
                    "sources": [],
                    "scanned": 1,
                    "duplicates": 0,
                }

        with tempfile.TemporaryDirectory() as folder:
            args = argparse.Namespace(
                config=None,
                known_file=None,
                state_file=str(Path(folder) / "state.json"),
                out=str(Path(folder) / "report.json"),
                log_file=None,
                timeout=1,
                retry_attempts=1,
                retry_backoff=0,
                process_ai=False,
                write=True,
                refresh=False,
            )
            with patch.object(news_command, "NewsCrawler", FakeCrawler), patch.object(
                news_command, "SupabaseNewsStore", side_effect=RuntimeError("database unavailable")
            ):
                result = news_command.run(args)
            self.assertEqual(result["stats"]["new"], 1)
            self.assertEqual(result["stats"]["failed"], 1)
            self.assertTrue(Path(args.out).exists())

    def test_artist_lookup_failure_does_not_disable_news_writes(self):
        class FakeCrawler:
            def __init__(self, *_args, **_kwargs):
                pass

            def crawl(self, *_args):
                return {
                    "items": [
                        RawNewsItem(
                            title="日本画展",
                            source_name="公式",
                            source_url="https://example.test/news/artist-lookup",
                            source_key="official",
                        )
                    ],
                    "errors": [],
                    "sources": [],
                    "scanned": 1,
                    "duplicates": 0,
                }

        class FakeStore:
            def __init__(self, *_args, **_kwargs):
                pass

            def existing(self):
                return set(), set()

            def artists(self):
                raise RuntimeError("artists endpoint unavailable")

            def expire_published(self, _today):
                return 0

            def upsert(self, _item):
                return {"id": "news-1", "_write_applied": True}

            def sync_links(self, *_args):
                return None

        with tempfile.TemporaryDirectory() as folder:
            args = argparse.Namespace(
                config=None,
                known_file=None,
                state_file=str(Path(folder) / "state.json"),
                out=str(Path(folder) / "report.json"),
                log_file=None,
                timeout=1,
                retry_attempts=1,
                retry_backoff=0,
                process_ai=False,
                write=True,
                refresh=False,
            )
            with patch.object(news_command, "NewsCrawler", FakeCrawler), patch.object(
                news_command, "SupabaseNewsStore", FakeStore
            ):
                result = news_command.run(args)
            self.assertEqual(result["stats"]["updated"], 1)
            self.assertEqual(result["stats"]["failed"], 1)
            self.assertTrue(Path(args.out).exists())

    def test_matching_requires_unambiguous_exact_name_or_alias(self):
        artists = [
            {"id": "a1", "name": "山田 花子", "japanese_name": "山田花子", "aliases": ["Hanako Yamada"]},
            {"id": "a2", "name": "山田太郎"},
        ]
        result = match_artists(["山田花子", "Hanako Yamada", "山田"], artists)
        self.assertEqual([row["id"] for row in result["matched"]], ["a1"])
        self.assertIn("山田", result["unmatched"])

    def test_load_sources_falls_back_when_config_is_invalid(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "invalid.json"
            path.write_text("not json", encoding="utf-8")
            self.assertTrue(load_sources(path))


if __name__ == "__main__":
    unittest.main()
