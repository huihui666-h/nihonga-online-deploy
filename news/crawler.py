"""Independent, failure-isolated crawler for trusted Nihonga sources."""

from __future__ import annotations

import hashlib
import html
import json
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urldefrag, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from .config import NewsSource, default_sources, load_sources


USER_AGENT = "nihonga-news-crawler/1.0 (+official-source-index)"
DEFAULT_TIMEOUT = 20
DEFAULT_RETRY_ATTEMPTS = 2
MAX_EXCERPT_LENGTH = 1400
TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
    }
)
DATE_PATTERNS = (
    re.compile(r"(?P<year>20\d{2})[年./-](?P<month>\d{1,2})[月./-](?P<day>\d{1,2})日?"),
    re.compile(r"(?P<year>20\d{2})年(?P<month>\d{1,2})月(?P<day>\d{1,2})日?"),
)
DATE_RANGE_PATTERN = re.compile(
    r"(?P<year>20\d{2})\s*[年./-]\s*(?P<start_month>\d{1,2})\s*[月./-]\s*(?P<start_day>\d{1,2})\s*日?"
    r"(?:\s*[（(][^）)]{0,8}[）)])?\s*(?:から|～|〜|~|－|–|—|-)\s*"
    r"(?:(?P<end_year>20\d{2})\s*[年./-]\s*)?(?P<end_month>\d{1,2})\s*[月./-]\s*(?P<end_day>\d{1,2})\s*日?",
    re.IGNORECASE,
)
NIHONGA_TERMS = frozenset(
    {
        "日本画",
        "日本絵画",
        "日本画家",
        "日本美術院",
        "日展",
        "nihonga",
        "japanese painting",
    }
)


@dataclass
class RawNewsItem:
    """Small factual candidate captured from a source page.

    ``excerpt`` is intentionally bounded; full third-party article bodies are
    never persisted by this package.
    """

    title: str
    source_name: str
    source_url: str
    source_item_id: str = ""
    excerpt: str = ""
    published_at: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    venue: str = ""
    image_url: str | None = None
    source_key: str = ""

    @property
    def summary(self) -> str:
        return self.excerpt

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["summary"] = self.excerpt
        return value


def normalize_text(value: Any, limit: int | None = None) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] if limit else text


def _plain_text(value: Any, limit: int | None = None) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]{1,240}>", " ", text)
    text = text.replace("<", " ").replace(">", " ")
    return normalize_text(text, limit).rstrip("&/").strip()


def canonical_url(value: Any, base_url: str | None = None) -> str:
    """Normalize a source URL and remove common tracking-only parameters."""

    text = normalize_text(value)
    if not text:
        return ""
    try:
        text = urljoin(base_url or "", text)
        text, _fragment = urldefrag(text)
        parsed = urlsplit(text)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            return ""
        query = [(key, val) for key, val in parse_qsl(parsed.query, keep_blank_values=True) if key.lower() not in TRACKING_PARAMS]
        path = parsed.path or "/"
        if path != "/":
            path = path.rstrip("/") or "/"
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, urlencode(query), ""))
    except (TypeError, ValueError):
        return ""


def source_url_allowed(url: str, source: NewsSource) -> bool:
    canonical = canonical_url(url, source.url)
    if not canonical:
        return False
    host = (urlsplit(canonical).hostname or "").lower().strip(".")
    if not any(host == domain or host.endswith(f".{domain}") for domain in source.allowed_domains):
        return False
    if source.link_prefixes and not any(urlsplit(canonical).path.startswith(prefix) for prefix in source.link_prefixes):
        return False
    return True


def _parse_date(value: Any) -> str | None:
    text = normalize_text(value)
    if not text:
        return None
    for pattern in DATE_PATTERNS:
        match = pattern.search(text)
        if match:
            try:
                result = datetime(
                    int(match.group("year")), int(match.group("month")), int(match.group("day")), tzinfo=timezone.utc
                )
                return result.date().isoformat()
            except ValueError:
                return None
    try:
        parsed = parsedate_to_datetime(text)
        return parsed.date().isoformat()
    except (TypeError, ValueError, OverflowError):
        pass
    try:
        value = text.replace("Z", "+00:00")
        return datetime.fromisoformat(value).date().isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


def _dates_from_text(text: str) -> tuple[str | None, str | None]:
    range_match = DATE_RANGE_PATTERN.search(text)
    if range_match:
        try:
            start = datetime(
                int(range_match.group("year")),
                int(range_match.group("start_month")),
                int(range_match.group("start_day")),
                tzinfo=timezone.utc,
            ).date()
            end_year = int(range_match.group("end_year") or range_match.group("year"))
            end_month = int(range_match.group("end_month"))
            end_day = int(range_match.group("end_day"))
            # A range such as Dec 20 - Jan 10 conventionally crosses a year.
            if not range_match.group("end_year") and end_month < start.month:
                end_year += 1
            end = datetime(end_year, end_month, end_day, tzinfo=timezone.utc).date()
            return start.isoformat(), end.isoformat()
        except ValueError:
            pass
    matches: list[str] = []
    for pattern in DATE_PATTERNS:
        matches.extend(
            datetime(int(m.group("year")), int(m.group("month")), int(m.group("day")), tzinfo=timezone.utc).date().isoformat()
            for m in pattern.finditer(text)
            if _valid_date_groups(m)
        )
    # Preserve ordering but remove duplicates.
    unique = list(dict.fromkeys(matches))
    if len(unique) >= 2:
        return unique[0], unique[1]
    return (unique[0], None) if unique else (None, None)


def _valid_date_groups(match: re.Match[str]) -> bool:
    try:
        datetime(int(match.group("year")), int(match.group("month")), int(match.group("day")))
        return True
    except ValueError:
        return False


def _published(value: Any) -> str | None:
    return _parse_date(value)


class _PageParser(HTMLParser):
    """Lenient HTML parser that extracts links, metadata and visible text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict[str, str]] = []
        self.meta: dict[str, str] = {}
        self._anchor: dict[str, str] | None = None
        self._in_script = 0
        self._in_style = 0
        self._in_title = 0
        self._heading_level = 0
        self._heading_parts: list[str] = []
        self._last_heading = ""
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {str(key).lower(): normalize_text(value) for key, value in attrs}
        tag = tag.lower()
        if tag == "meta":
            key = attrs_map.get("property") or attrs_map.get("name") or attrs_map.get("itemprop")
            value = attrs_map.get("content", "")
            if key and value:
                self.meta[key.lower()] = value
        elif tag == "a":
            href = attrs_map.get("href", "")
            if href:
                self._anchor = {"href": href, "text": "", "heading": self._last_heading}
        elif tag in {"script", "style", "noscript", "template"}:
            if tag == "script":
                self._in_script += 1
            elif tag == "style":
                self._in_style += 1
        elif tag == "title":
            self._in_title += 1
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._heading_level += 1
            self._heading_parts = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "a" and self._anchor is not None:
            self.links.append(self._anchor)
            self._anchor = None
        elif tag == "script":
            self._in_script = max(0, self._in_script - 1)
        elif tag == "style":
            self._in_style = max(0, self._in_style - 1)
        elif tag == "title":
            self._in_title = max(0, self._in_title - 1)
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._last_heading = normalize_text(" ".join(self._heading_parts), 300)
            self._heading_parts = []
            self._heading_level = max(0, self._heading_level - 1)

    def handle_data(self, data: str) -> None:
        if self._anchor is not None and not self._in_script and not self._in_style:
            self._anchor["text"] += f" {data}"
        if not self._in_script and not self._in_style:
            text = normalize_text(data)
            if text:
                self.text_parts.append(text)
                if self._heading_level:
                    self._heading_parts.append(text)
                if self._in_title:
                    self.title_parts.append(text)


def _item_id(url: str, title: str) -> str:
    return hashlib.sha256(f"{canonical_url(url)}\n{normalize_text(title).casefold()}".encode("utf-8")).hexdigest()[:24]


def _title_from_meta(meta: Mapping[str, str]) -> str:
    for key in ("og:title", "twitter:title", "title"):
        if meta.get(key):
            return normalize_text(meta[key], 300)
    return ""


def _title_from_parser(parser: _PageParser) -> str:
    return _title_from_meta(parser.meta) or normalize_text(" ".join(parser.title_parts), 300)


def _title_key(value: Any) -> str:
    text = normalize_text(value).casefold()
    return re.sub(r"[^\w\u3040-\u30ff\u3400-\u9fff]+", "", text, flags=re.UNICODE)


def _image_from_meta(meta: Mapping[str, str], page_url: str, source: NewsSource) -> str | None:
    if not source.allow_images:
        return None
    for key in ("og:image", "twitter:image", "image"):
        value = canonical_url(meta.get(key), page_url)
        if value:
            return value
    return None


def _candidate_from_link(link: Mapping[str, str], parser: _PageParser, source: NewsSource, base_url: str) -> RawNewsItem | None:
    url = canonical_url(link.get("href"), base_url)
    title = normalize_text(link.get("text"), 300)
    generic_link = re.sub(r"[\s>＞→⇒]+", "", title).casefold()
    if generic_link in {"詳細はこちら", "詳細", "もっと見る", "続きを読む", "more", "readmore"}:
        title = normalize_text(link.get("heading"), 300)
    if not url or not title or len(title) < 4 or not source_url_allowed(url, source):
        return None
    combined = " ".join(parser.text_parts)
    # Link text is the only reliable title for generic list pages.  Keep only
    # a short adjacent-page excerpt rather than storing the entire body.
    excerpt = normalize_text(parser.meta.get("description") or parser.meta.get("og:description") or combined, MAX_EXCERPT_LENGTH)
    start, end = _dates_from_text(f"{title} {excerpt}")
    venue = _extract_venue(f"{title} {excerpt}")
    return RawNewsItem(
        title=title,
        source_name=source.name,
        source_url=url,
        source_item_id=_item_id(url, title),
        excerpt=excerpt,
        published_at=_published(parser.meta.get("article:published_time") or parser.meta.get("date")),
        start_date=start,
        end_date=end,
        venue=venue,
        image_url=_image_from_meta(parser.meta, url, source),
        source_key=source.key,
    )


def _extract_venue(text: str) -> str:
    match = re.search(
        r"(?:＜|<)?(?:会場|会期場所|開催地|場所|会場名)(?:＞|>|[:：]|\s+)\s*"
        r"(.{2,120}?)(?=\s*(?:＜|<)?(?:作家情報|会期|開催日時|主催|共催|協賛|開館時間|休館日|入場料|入館料|前の記事|次の記事|一覧へ|詳細)(?:＞|>)?|[。|｜;；]|$)",
        text,
    )
    return normalize_text(match.group(1), 120) if match else ""


def _detail_excerpt(parser: _PageParser, fallback_title: str) -> str:
    """Return a bounded, content-focused excerpt from a detail page."""

    visible = normalize_text(" ".join(parser.text_parts))
    meta_excerpt = _plain_text(parser.meta.get("description") or parser.meta.get("og:description"), MAX_EXCERPT_LENGTH)
    if meta_excerpt and len(meta_excerpt) >= 80 and not meta_excerpt.rstrip().endswith(("...", "…")):
        return meta_excerpt
    markers = [
        match.start()
        for pattern in (
            r"(?:＜|<)?会期(?:＞|>|[:：]|\s+)",
            r"(?:＜|<)?会場(?:＞|>|[:：]|\s+)",
            r"開催日時(?:[:：]|\s+)",
        )
        if (match := re.search(pattern, visible))
    ]
    if markers:
        position = min(markers)
        return normalize_text(visible[position : position + MAX_EXCERPT_LENGTH], MAX_EXCERPT_LENGTH)
    meta_title = _title_from_parser(parser)
    title_candidates = [meta_title.split("｜", 1)[0].split(" - ", 1)[0], fallback_title]
    positions = [visible.rfind(normalize_text(value)) for value in title_candidates if normalize_text(value)]
    position = max(positions, default=-1)
    if position < 0:
        position = 0
    return normalize_text(visible[position : position + MAX_EXCERPT_LENGTH], MAX_EXCERPT_LENGTH)


def parse_detail_document(body: str, source: NewsSource, item: RawNewsItem) -> RawNewsItem:
    """Enrich one listing candidate from its official detail page.

    The return value retains the listing URL and source identity.  Only a
    bounded excerpt is captured; full article text is neither returned nor
    persisted.
    """

    parser = _PageParser()
    try:
        parser.feed(body or "")
        parser.close()
    except Exception:
        pass
    excerpt = _detail_excerpt(parser, item.title)
    detail_title = _title_from_parser(parser)
    # Listing titles often include state/date prefixes useful to readers, so
    # only replace a missing or obviously generic title.
    generic_titles = {"開催中の展覧会", "次回の展覧会", "今後の展覧会", "展覧会詳細", "詳細を見る"}
    title = detail_title if (not item.title or normalize_text(item.title) in generic_titles) else item.title
    date_text = excerpt if "news" in source.key else f"{title} {excerpt}"
    start, end = _dates_from_text(date_text)
    published = item.published_at
    if not published:
        published = _published(parser.meta.get("article:published_time") or parser.meta.get("date"))
    if not published and "news" in source.key:
        published = _parse_date(title)
    is_news_source = "news" in source.key
    return RawNewsItem(
        title=title,
        source_name=item.source_name,
        source_url=item.source_url,
        source_item_id=item.source_item_id,
        excerpt=excerpt or item.excerpt,
        published_at=published,
        start_date=start if is_news_source else (start or item.start_date),
        end_date=end if is_news_source else (end or item.end_date),
        venue=_extract_venue(excerpt) or item.venue,
        image_url=_image_from_meta(parser.meta, item.source_url, source) or item.image_url,
        source_key=item.source_key,
    )


def parse_html_document(body: str, source: NewsSource, page_url: str | None = None) -> list[RawNewsItem]:
    """Parse links from an official HTML listing page without external deps."""

    page_url = canonical_url(page_url or source.url) or source.url
    parser = _PageParser()
    try:
        parser.feed(body or "")
        parser.close()
    except Exception:
        # HTMLParser is deliberately best-effort for malformed source markup.
        pass
    items: list[RawNewsItem] = []
    seen: set[str] = set()
    page_title = _title_from_parser(parser)
    page_excerpt = normalize_text(parser.meta.get("description") or parser.meta.get("og:description"), MAX_EXCERPT_LENGTH)
    # If a page is itself a detail item (no useful links), preserve its metadata.
    if page_title and source_url_allowed(page_url, source):
        start, end = _dates_from_text(f"{page_title} {page_excerpt} {' '.join(parser.text_parts)}")
        item = RawNewsItem(
            title=page_title,
            source_name=source.name,
            source_url=page_url,
            source_item_id=_item_id(page_url, page_title),
            excerpt=page_excerpt or normalize_text(" ".join(parser.text_parts), MAX_EXCERPT_LENGTH),
            published_at=_published(parser.meta.get("article:published_time") or parser.meta.get("date")),
            start_date=start,
            end_date=end,
            venue=_extract_venue(" ".join(parser.text_parts)),
            image_url=_image_from_meta(parser.meta, page_url, source),
            source_key=source.key,
        )
        # A generic homepage title (e.g. "ホーム") is not useful as a news item.
        # A listing page often has a generic description; only treat a page as
        # a detail item when it has no article links or its title is clearly a
        # configured Nihonga/news keyword.
        if not parser.links or any(term.casefold() in item.title.casefold() for term in source.keywords):
            items.append(item)
            seen.add(item.source_url)
    for link in parser.links:
        item = _candidate_from_link(link, parser, source, page_url)
        if not item or item.source_url in seen:
            continue
        # Keyword filtering keeps high-trust official pages focused and avoids
        # navigation links.  Empty keyword config means accept all article-like links.
        haystack = f"{item.title} {item.excerpt}".casefold()
        if source.keywords and not any(str(term).casefold() in haystack for term in source.keywords):
            if len(item.title) < 10:
                continue
        seen.add(item.source_url)
        items.append(item)
        if len(items) >= source.max_items:
            break
    return items[: source.max_items]


def parse_feed_document(body: str, source: NewsSource, feed_url: str | None = None) -> list[RawNewsItem]:
    """Parse RSS 2.0 and Atom feeds using the standard library."""

    feed_url = canonical_url(feed_url or source.url) or source.url
    try:
        root = ElementTree.fromstring(body or "")
    except (ElementTree.ParseError, TypeError, ValueError):
        return []
    items: list[RawNewsItem] = []
    for node in root.iter():
        local = node.tag.rsplit("}", 1)[-1].lower() if isinstance(node.tag, str) else ""
        if local not in {"item", "entry"}:
            continue
        fields: dict[str, str] = {}
        links: list[str] = []
        for child in list(node):
            child_local = child.tag.rsplit("}", 1)[-1].lower() if isinstance(child.tag, str) else ""
            value = normalize_text("".join(child.itertext()), 2000)
            if child_local == "link":
                href = child.attrib.get("href") if isinstance(child.attrib, Mapping) else None
                links.append(canonical_url(href or value, feed_url))
            elif child_local in {"title", "description", "summary", "content", "pubdate", "published", "updated", "date"}:
                fields.setdefault(child_local, value)
        url = next((candidate for candidate in links if source_url_allowed(candidate, source)), "")
        title = normalize_text(fields.get("title"), 300)
        if not url or not title:
            continue
        excerpt = normalize_text(fields.get("description") or fields.get("summary") or fields.get("content"), MAX_EXCERPT_LENGTH)
        start, end = _dates_from_text(f"{title} {excerpt}")
        items.append(
            RawNewsItem(
                title=title,
                source_name=source.name,
                source_url=url,
                source_item_id=_item_id(url, title),
                excerpt=excerpt,
                published_at=_published(fields.get("pubdate") or fields.get("published") or fields.get("updated") or fields.get("date")),
                start_date=start,
                end_date=end,
                venue=_extract_venue(excerpt),
                source_key=source.key,
            )
        )
        if len(items) >= source.max_items:
            break
    return items


def _default_fetch(url: str, timeout: float = DEFAULT_TIMEOUT) -> tuple[str, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1"})
    with urlopen(request, timeout=timeout) as response:
        raw = response.read(2_500_000)
        charset = response.headers.get_content_charset() if getattr(response, "headers", None) else None
        content_type = response.headers.get("Content-Type", "") if getattr(response, "headers", None) else ""
    encoding = charset or ("utf-8" if "utf-8" in content_type.lower() else "utf-8")
    try:
        return raw.decode(encoding, errors="replace"), content_type.lower()
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace"), content_type.lower()


def _retry_fetch(fetcher: Callable[[str, float], tuple[str, str]], url: str, timeout: float, attempts: int, backoff: float) -> tuple[str, str]:
    last_error: BaseException | None = None
    for attempt in range(max(1, attempts)):
        try:
            return fetcher(url, timeout)
        except Exception as error:
            last_error = error
            if attempt + 1 >= max(1, attempts):
                break
            if isinstance(error, HTTPError) and error.code not in {408, 425, 429, 500, 502, 503, 504}:
                break
            if (
                isinstance(error, URLError)
                or isinstance(error, (TimeoutError, ConnectionError))
                or (isinstance(error, HTTPError) and error.code in {408, 425, 429, 500, 502, 503, 504})
                or "timeout" in str(error).lower()
            ):
                time.sleep(max(0.0, min(30.0, backoff * (2**attempt))))
                continue
            break
    assert last_error is not None
    raise last_error


class NewsCrawler:
    """Fetch each configured source independently and return deduplicated items."""

    def __init__(
        self,
        sources: Sequence[NewsSource] | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
        retry_backoff: float = 0.5,
        fetcher: Callable[[str, float], tuple[str, str]] | None = None,
        logger: Callable[..., Any] | None = None,
    ) -> None:
        self.sources = list(sources or default_sources())
        self.timeout = max(1.0, float(timeout))
        self.retry_attempts = max(1, int(retry_attempts))
        self.retry_backoff = max(0.0, float(retry_backoff))
        self.fetcher = fetcher or _default_fetch
        self.logger = logger

    def _log(self, event: str, **fields: Any) -> None:
        if self.logger:
            try:
                self.logger(event, **fields)
            except TypeError:
                try:
                    self.logger({"event": event, **fields})
                except Exception:
                    pass

    def crawl(
        self,
        known_urls: Iterable[str] | None = None,
        known_titles: Iterable[str] | None = None,
    ) -> dict[str, Any]:
        known = {canonical_url(url) for url in (known_urls or ()) if canonical_url(url)}
        seen = set(known)
        # URL is the durable cross-run identity.  Title-only suppression would
        # incorrectly hide an annual show, or a separate exhibition with the
        # same name at another official venue, so it is intentionally limited
        # to the current source response below.
        _ = known_titles
        items: list[RawNewsItem] = []
        errors: list[dict[str, str]] = []
        source_results: list[dict[str, Any]] = []
        scanned = 0
        duplicates = 0
        for source in self.sources:
            try:
                body, content_type = _retry_fetch(self.fetcher, source.url, self.timeout, self.retry_attempts, self.retry_backoff)
                kind = source.kind
                is_feed = kind in {"rss", "atom"} or (kind == "auto" and ("xml" in content_type or body.lstrip().startswith("<?xml")))
                parsed = parse_feed_document(body, source, source.url) if is_feed else parse_html_document(body, source, source.url)
                scanned += len(parsed)
                accepted = 0
                detail_failures = 0
                seen_source_title_keys: set[str] = set()
                for item in parsed:
                    if item.source_url in seen:
                        duplicates += 1
                        continue
                    seen.add(item.source_url)
                    if source.fetch_details:
                        try:
                            detail_body, _detail_type = _retry_fetch(
                                self.fetcher,
                                item.source_url,
                                self.timeout,
                                self.retry_attempts,
                                self.retry_backoff,
                            )
                            item = parse_detail_document(detail_body, source, item)
                        except Exception as error:
                            detail_failures += 1
                            entry = {
                                "source": source.key,
                                "source_name": source.name,
                                "source_url": item.source_url,
                                "stage": "detail",
                                "error": normalize_text(error, 300),
                            }
                            errors.append(entry)
                            self._log("detail-error", source=source.key, url=item.source_url, error=entry["error"])
                    title_key = _title_key(item.title)
                    # A title-only duplicate check is safe only within one
                    # source listing and only for undated, venue-less entries.
                    # Detail parsing above may have supplied enough facts to
                    # distinguish otherwise identical titles.
                    title_only = title_key and not any((item.published_at, item.start_date, item.end_date, item.venue))
                    if title_only and title_key in seen_source_title_keys:
                        duplicates += 1
                        continue
                    if title_only:
                        seen_source_title_keys.add(title_key)
                    items.append(item)
                    accepted += 1
                source_results.append(
                    {"source": source.key, "fetched": True, "items": accepted, "detail_failures": detail_failures}
                )
                self._log("source-complete", source=source.key, items=accepted)
            except Exception as error:
                # A source outage never aborts another source in this batch.
                entry = {"source": source.key, "source_name": source.name, "error": normalize_text(error, 300)}
                errors.append(entry)
                source_results.append({"source": source.key, "fetched": False, "error": entry["error"]})
                self._log("source-error", source=source.key, error=entry["error"])
        return {"items": items, "errors": errors, "sources": source_results, "scanned": scanned, "duplicates": duplicates}


def crawl_sources(
    sources: Sequence[NewsSource] | None = None,
    *,
    known_urls: Iterable[str] | None = None,
    known_titles: Iterable[str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
    retry_backoff: float = 0.5,
    fetcher: Callable[[str, float], tuple[str, str]] | None = None,
    logger: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Functional convenience wrapper around :class:`NewsCrawler`."""

    return NewsCrawler(
        sources,
        timeout=timeout,
        retry_attempts=retry_attempts,
        retry_backoff=retry_backoff,
        fetcher=fetcher,
        logger=logger,
    ).crawl(known_urls, known_titles)


def load_known_urls(path: str | Path | None) -> set[str]:
    """Read URL strings or crawler JSON output for resumable dedupe."""

    if not path:
        return set()
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return set()
    values: list[Any] = []
    if isinstance(raw, list):
        values = raw
    elif isinstance(raw, Mapping):
        values = raw.get("seen_urls", raw.get("urls", [])) or []
        if not values and isinstance(raw.get("items"), list):
            values = [item.get("source_url") for item in raw["items"] if isinstance(item, Mapping)]
    return {canonical_url(value) for value in values if canonical_url(value)}


def load_known_titles(path: str | Path | None) -> set[str]:
    """Read prior item titles for cross-run title deduplication."""

    if not path:
        return set()
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return set()
    values: list[Any] = []
    if isinstance(raw, Mapping) and isinstance(raw.get("items"), list):
        values = [item.get("title") for item in raw["items"] if isinstance(item, Mapping)]
    elif isinstance(raw, Mapping) and isinstance(raw.get("titles"), list):
        values = raw["titles"]
    elif isinstance(raw, Mapping) and isinstance(raw.get("processed"), Mapping):
        values = [
            entry.get("record", {}).get("title")
            for entry in raw["processed"].values()
            if isinstance(entry, Mapping) and isinstance(entry.get("record"), Mapping)
        ]
    elif isinstance(raw, list):
        values = [item.get("title") for item in raw if isinstance(item, Mapping)]
    return {normalize_text(value) for value in values if _title_key(value)}


__all__ = [
    "NewsCrawler",
    "RawNewsItem",
    "canonical_url",
    "crawl_sources",
    "load_known_urls",
    "load_known_titles",
    "parse_feed_document",
    "parse_detail_document",
    "parse_html_document",
    "source_url_allowed",
]
