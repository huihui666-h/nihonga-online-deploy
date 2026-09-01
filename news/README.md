# Nihonga Now pipeline

This package is an independent news pipeline. It does not import or call the
Instagram crawler, Instagram parser, or Artist write path.

```text
trusted source config -> NewsCrawler -> AIProcessor -> publication rules -> news store
```

## Manual run

From `nihonga-online-deploy`:

```powershell
python scripts/news_crawler.py --out imports/news-candidates.json
```

This fetches the configured official sources, follows only configured detail
URL prefixes, writes bounded excerpts to the local report/state for AI input,
and produces `candidate` records. It does not write the database unless
`--write` is explicitly supplied. Crawler excerpts are never mapped to the
database `summary` field.

To enable AI processing:

```powershell
$env:OPENAI_API_KEY = "..."
$env:OPENAI_MODEL = "gpt-4o-mini" # optional
$env:OPENAI_BASE_URL = "https://api.openai.com/v1/chat/completions" # optional
python scripts/news_crawler.py --process-ai --out imports/news-processed.json
```

When `OPENAI_API_KEY` is absent, the command still succeeds. Candidates remain
in `imports/news-crawler-state.json` with `ai_processed: false`; a later
`--process-ai` run resumes those bounded snapshots without fetching every
detail page again.

Database writes reuse the existing Supabase service:

```powershell
$env:SUPABASE_URL = "..."
$env:SUPABASE_SERVICE_ROLE_KEY = "..."
python scripts/news_crawler.py --process-ai --write
```

`--write` only upserts `news` and `news_artists`. Each item insert/link failure
is recorded and the rest of the batch continues. It also marks already stored
`published` exhibitions/open calls as `expired` when their `end_date` is before
the current Tokyo date. Run `seed/nihonga-now-news.sql` once before the first
write; it is not applied automatically.

## Source configuration

Edit `news/sources.json` or pass `--config PATH`. Each entry supports:

- `key`, `name`, `url`, and `kind` (`html`, `rss`, `atom`, or `auto`)
- `allowed_domains` and `link_prefixes` to constrain detail URLs
- `keywords` and `max_items`
- `fetch_details` for per-item fact extraction
- `allow_images`, disabled for all MVP sources

An invalid individual source entry is skipped. Failure of one source or one
detail page does not stop other sources or candidates.

## Service API

```python
from news import AIProcessor, NewsCrawler, determine_status, process_news_with_ai

result = NewsCrawler(sources).crawl(known_urls, known_titles)
metadata = process_news_with_ai(raw_item, processor=AIProcessor())
status = determine_status(metadata, raw_item, trusted_source=True)
```

`process_news_with_ai` returns `None` when AI is not configured. When enabled,
the output is validated as strict JSON and its category, score, dates, names,
tags, and lengths are bounded. The model never writes `status`; only
`determine_status` can return `candidate`, `published`, `rejected`, or
`expired`. Transient request failures, HTTP 429, and provider 5xx responses use
bounded exponential retries. An exhausted quota/authentication failure pauses
the remaining AI work while keeping candidates resumable.

Automatic publication requires all of the following:

- the configured source key is in the current trusted-source configuration
- AI returns `relevant: true` and `relevance_score >= 0.85`
- the category is one of the five allowed values
- title, canonical source URL, and an original AI summary are present
- URL/title fingerprint deduplication succeeds
- parsed date fields are structurally valid and not anomalous

Low relevance is `rejected`; incomplete but potentially useful data remains
`candidate`; a qualifying record becomes `published`. Past exhibitions and
open calls become `expired` without deletion.

Artist names are matched by `news.matching.match_artists`. It compares exact
normalized `name`, Japanese name, roman name, and aliases, and only returns an
association when exactly one Artist row matches. Unmatched names remain in
`raw_artist_names`.

The crawler does not save full articles. Local processor excerpts are bounded
at 1,400 characters, public AI summaries are bounded at 600 characters, and
all configured MVP image capture is disabled. Only original AI summaries are
written to `news.summary`; unprocessed candidates use an empty summary.
