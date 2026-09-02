#!/usr/bin/env python3
"""Export reviewed Instagram artist candidates for the Nihonga directory.

The script accepts a bounded list of public profile URLs, checks robots.txt,
fetches each page with Scrapling, and writes a reviewable JSON file. By default
it is read-only; pass --push with the local admin password file to add only the
new records through the site's duplicate-protected admin API.

Install the optional scraper dependency before running:
    python -m pip install "scrapling[all]>=0.4.11"

Example:
    python scripts/instagram_import.py \
      --seed https://www.instagram.com/artist_handle/ \
      --existing-file existing-artists.json \
      --out imports/instagram-candidates.json
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import inspect
import json
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, unquote, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

try:
    from scrapling.fetchers import Fetcher
    from scrapling.parser import Selector
except ImportError:  # Keep local parsing/tests usable before optional install.
    Fetcher = None
    Selector = None


USER_AGENT = "nihonga-directory-import/1.0 (+public-profile-review)"
DEFAULT_ARTISTS_API = "https://nihonga-online-deploy.vercel.app/api/artists"
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BACKOFF = 1.0
MAX_RETRY_BACKOFF = 30.0
USERNAME_RE = re.compile(r"^[a-z0-9._]{1,30}$", re.IGNORECASE)
NON_PROFILE_PATHS = {
    "accounts",
    "about",
    "challenge",
    "direct",
    "developer",
    "directory",
    "emails",
    "explore",
    "p",
    "reel",
    "reels",
    "stories",
    "tags",
    "locations",
    "hashtag",
    "tv",
    "privacy",
    "legal",
}
NIHONGA_KEYWORDS = (
    "日本画",
    "日本絵画",
    "nihonga",
    "japanese painting",
    "japanese painter",
    "岩絵具",
    "岩絵の具",
    "mineral pigment",
    "mineral pigments",
    "gofun",
)
EXTERNAL_PROVIDER_KEYWORDS = {
    "gallery": (
        "gallery", "galerie", "ギャラリー", "画廊", "画苑", "アートスペース",
    ),
    "museum": (
        "museum", "museo", "美術館", "博物館", "ミュージアム", "美術館",
    ),
    "university": (
        "university", "college", "institute", "大学", "大学院", "研究室", "学部", ".ac.jp", ".edu",
    ),
}
EXTERNAL_SOURCE_PROVIDERS = frozenset({"official-site", "gallery", "museum", "university", "external"})
SCHOOL_RULES = (
    ("東京藝術大学", "東京", ("東京藝術大学", "東京藝大", "Tokyo University of the Arts", "Geidai")),
    ("多摩美術大学", "東京", ("多摩美術大学", "多摩美", "Tama Art University")),
    ("武蔵野美術大学", "東京", ("武蔵野美術大学", "武蔵美", "Musashino Art University")),
    ("女子美術大学", "東京", ("女子美術大学", "女子美", "Joshibi")),
    ("日本大学芸術学部", "東京", ("日本大学芸術学部", "日芸", "Nihon University College of Art")),
    ("京都芸術大学", "京都", ("京都芸術大学", "京都造形芸術大学", "Kyoto University of the Arts")),
    ("京都精華大学", "京都", ("京都精華大学", "Kyoto Seika University")),
    ("東北芸術工科大学", "山形", ("東北芸術工科大学", "TUAD")),
    ("愛知県立芸術大学", "愛知", ("愛知県立芸術大学", "Aichi University of the Arts")),
    ("金沢美術工芸大学", "石川", ("金沢美術工芸大学", "Kanazawa College of Art")),
)

RETRYABLE_HTTP_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
RETRYABLE_ERROR_WORDS = (
    "temporar", "timeout", "timed out", "try again", "connection",
    "unavailable", "reset", "rate limit", "too many requests", "busy",
)
SENSITIVE_LOG_KEY_RE = re.compile(
    r"(?:bio|note|password|token|cookie|secret|body|payload|html|description)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ArtistSource:
    """Provider-neutral source identity used by the crawler.

    The database still receives the legacy Artist fields.  Keeping this small
    structure in the import report lets later providers be added without
    changing the public Artist contract.
    """

    provider: str
    username: str = ""
    external_id: str = ""
    url: str = ""

    def as_dict(self) -> dict[str, str]:
        value: dict[str, str] = {"provider": self.provider}
        if self.username:
            value["username"] = self.username
        if self.external_id:
            value["externalId"] = self.external_id
        if self.url:
            value["url"] = self.url
        return value


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CrawlerLogger:
    """Append-only JSONL logger with no credentials or raw profile text."""

    def __init__(self, path: str | Path | None = None, run_id: str | None = None) -> None:
        self.path = Path(path) if path else None
        self.run_id = clean_text(run_id) if run_id else f"crawl-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')}"
        self._lock = threading.Lock()
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def event(self, event: str, **fields: Any) -> dict[str, Any]:
        record: dict[str, Any] = {
            "timestamp": _utc_now(),
            "runId": self.run_id,
            "event": clean_text(event)[:80] or "event",
        }
        record.update(_safe_log_fields(fields))
        if self.path:
            line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            with self._lock:
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(line)
                    handle.flush()
                    os.fsync(handle.fileno())
        return record


def _emit_log(logger: Any, event: str, **fields: Any) -> None:
    if logger is None:
        return
    try:
        safe_fields = _safe_log_fields(fields)
        if hasattr(logger, "event"):
            logger.event(event, **safe_fields)
        elif callable(logger):
            logger(event, safe_fields)
        elif isinstance(logger, list):
            logger.append({"event": event, **safe_fields})
    except Exception:
        # Observability must never make a crawl fail.
        return


def _safe_log_fields(fields: Mapping[str, Any]) -> dict[str, Any]:
    """Keep crawler logs bounded and free of profile/contact payloads."""

    safe: dict[str, Any] = {}
    for key, value in fields.items():
        if value is None:
            continue
        safe_key = re.sub(r"[^A-Za-z0-9_.-]", "_", str(key))[:64]
        if not safe_key or SENSITIVE_LOG_KEY_RE.search(safe_key):
            continue
        if isinstance(value, bool | int | float):
            safe[safe_key] = value
            continue
        if not isinstance(value, (str, Path)):
            # Do not stringify mappings/lists: they can contain an unnoticed
            # bio, response body, cookie, or credential under a harmless key.
            continue
        safe_value = clean_text(value)
        safe_value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[redacted]", safe_value)
        safe_value = re.sub(r"(?<!\w)\+?\d[\d\s().-]{6,}\d(?!\w)", "[redacted]", safe_value)
        safe[safe_key] = safe_value[:300]
    return safe


def is_retryable_error(error: BaseException) -> bool:
    status = getattr(error, "code", None) or getattr(error, "status", None)
    try:
        if int(status) in RETRYABLE_HTTP_STATUS:
            return True
    except (TypeError, ValueError):
        pass
    if isinstance(error, (TimeoutError, ConnectionError, URLError)):
        return True
    message = clean_text(error).casefold()
    return any(word in message for word in RETRYABLE_ERROR_WORDS)


def retry_call(
    operation: Callable[[], Any],
    *,
    attempts: int = DEFAULT_RETRY_ATTEMPTS,
    backoff_seconds: float = DEFAULT_RETRY_BACKOFF,
    max_backoff_seconds: float = MAX_RETRY_BACKOFF,
    sleep_fn: Callable[[float], None] = time.sleep,
    should_retry: Callable[[BaseException], bool] = is_retryable_error,
    on_attempt: Callable[[int, BaseException, bool], None] | None = None,
) -> Any:
    """Run an operation with bounded exponential backoff.

    ``attempts`` counts the first call, so the default makes at most three
    requests.  Non-transient errors are raised immediately.
    """

    try:
        total_attempts = max(1, int(attempts))
    except (TypeError, ValueError):
        total_attempts = DEFAULT_RETRY_ATTEMPTS
    try:
        backoff = max(0.0, float(backoff_seconds))
    except (TypeError, ValueError):
        backoff = DEFAULT_RETRY_BACKOFF
    try:
        max_backoff = max(0.0, float(max_backoff_seconds))
    except (TypeError, ValueError):
        max_backoff = MAX_RETRY_BACKOFF

    for attempt in range(1, total_attempts + 1):
        try:
            return operation()
        except Exception as error:
            retry = attempt < total_attempts and bool(should_retry(error))
            if on_attempt:
                on_attempt(attempt, error, retry)
            if not retry:
                raise
            delay = min(max_backoff, backoff * (2 ** (attempt - 1)))
            if delay > 0:
                sleep_fn(delay)
    raise RuntimeError("retry operation exhausted")


def clean_text(value: Any) -> str:
    """Normalize public text while removing control characters."""

    text = html.unescape(str(value or ""))
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def configure_stdout() -> None:
    stream = getattr(sys, "stdout", None)
    if stream is not None and hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="backslashreplace")


def normalize_handle(value: Any) -> str:
    """Return a case-insensitive Instagram username without the @ prefix.

    Invalid URLs and non-profile paths (posts, reels, settings, etc.) return
    an empty string so they cannot accidentally become artist records.
    """

    raw = clean_text(value)
    if not raw:
        return ""

    # Treat host-like values as URLs too.  Without this guard a bare
    # ``instagram.com`` would be accepted as a (valid-looking) username.
    is_url = (
        bool(re.match(r"^(?:https?:)?//", raw, re.IGNORECASE))
        or bool(re.match(r"^(?:www\.)?instagram\.com(?::\d+)?(?:[/?#]|$)", raw, re.IGNORECASE))
        or "instagram.com/" in raw.casefold()
    )
    if is_url:
        candidate = raw
        if candidate.startswith("//"):
            candidate = f"https:{candidate}"
        elif not re.match(r"^https?://", candidate, re.IGNORECASE):
            candidate = f"https://{candidate}"
        try:
            parsed = urlsplit(candidate)
        except ValueError:
            return ""
        host = (parsed.hostname or "").casefold().rstrip(".")
        if host not in {"instagram.com", "www.instagram.com"}:
            return ""
        segments = [unquote(part).strip() for part in parsed.path.split("/") if part.strip()]
        if segments and segments[0].casefold() == "_u":
            segments = segments[1:]
        # A profile URL has exactly one path segment (apart from the optional
        # ``/_u/`` alias).  Silently accepting ``/foo/bar`` can turn a post or
        # an unrelated site route into a false artist identity.
        if len(segments) != 1 or segments[0].casefold() in NON_PROFILE_PATHS:
            return ""
        raw = segments[0].lstrip("@")
    else:
        raw = raw.split("?", 1)[0].split("#", 1)[0].strip().lstrip("@").strip("/")

        # ``instagram.com`` and ``www.instagram.com`` without a path are host
        # names, never usernames.
        if raw.casefold().rstrip(".") in {"instagram.com", "www.instagram.com"}:
            return ""

    handle = raw.casefold()
    return handle if USERNAME_RE.fullmatch(handle) else ""


def canonical_profile_url(value: Any) -> str:
    handle = normalize_handle(value)
    return f"https://www.instagram.com/{handle}/" if handle else ""


def canonical_external_url(value: Any) -> str:
    """Canonicalize a non-Instagram source URL for stable identity checks."""

    raw = clean_text(value)
    if not raw:
        return ""
    candidate = raw if re.match(r"^[a-z][a-z0-9+.-]*://", raw, re.IGNORECASE) else f"https://{raw}"
    try:
        parsed = urlsplit(candidate)
        if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
            return ""
        host = parsed.hostname.casefold().rstrip(".")
        # Drop credentials and fragments.  Preserve a non-default port because
        # it can identify a different local fixture endpoint.
        netloc = host
        if parsed.port is not None and not (
            (parsed.scheme.casefold() == "http" and parsed.port == 80)
            or (parsed.scheme.casefold() == "https" and parsed.port == 443)
        ):
            netloc = f"{netloc}:{parsed.port}"
        path = re.sub(r"/{2,}", "/", unquote(parsed.path or "/"))
        path = path.rstrip("/") or "/"
        retained = [
            (key, item)
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
            if not key.casefold().startswith("utm_")
            and key.casefold() not in {"fbclid", "gclid", "igsh", "igshid", "mc_cid", "mc_eid"}
        ]
        retained.sort(key=lambda pair: (pair[0].casefold(), pair[1]))
        query = urlencode(retained, doseq=True)
        return f"{parsed.scheme.casefold()}://{netloc}{path}{('?' + query) if query else ''}"
    except (TypeError, ValueError):
        return ""


def first_valid_handle(*values: Any) -> str:
    """Pick the first valid handle from a row's handle/URL fields."""

    for value in values:
        handle = normalize_handle(value)
        if handle:
            return handle
    return ""


def normalize_name(value: Any) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value)).casefold()
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def normalize_source_provider(value: Any) -> str:
    provider = re.sub(r"\s+", "-", clean_text(value).casefold())
    return provider if re.fullmatch(r"[a-z][a-z0-9-]{0,62}", provider) else "external"


def normalize_artist_source(value: Any, provider: str | None = None) -> dict[str, str] | None:
    """Return one provider-neutral source, or ``None`` when it has no identity."""

    if isinstance(value, str):
        source: Mapping[str, Any] = {"url": value}
    elif isinstance(value, Mapping):
        source = value
    else:
        return None

    requested = normalize_source_provider(
        provider
        or source.get("provider")
        or source.get("type")
        or source.get("linkType")
        or source.get("link_type")
        or "external"
    )
    raw_url = (
        source.get("url")
        or source.get("href")
        or source.get("externalUrl")
        or source.get("sourcePage")
        or source.get("source_page")
        or ""
    )
    # A raw source URL is enough to identify Instagram even when callers omit
    # the provider field (common in hand-edited review files).
    if requested == "external" and re.search(r"(?:^|//)(?:www\.)?instagram\.com(?:/|$)", clean_text(raw_url), re.IGNORECASE):
        requested = "instagram"
    username = ""
    if requested == "instagram":
        username = first_valid_handle(
            source.get("username"), source.get("handle"), source.get("externalId"),
            source.get("external_id"), raw_url,
        )
    external_id = clean_text(source.get("externalId") or source.get("external_id") or "")
    if username:
        result = {"provider": "instagram", "username": username, "url": canonical_profile_url(username)}
        if external_id:
            result["externalId"] = external_id
        return result

    url = canonical_external_url(raw_url)
    if not url and not external_id:
        return None
    result = {"provider": requested}
    if external_id:
        result["externalId"] = external_id
    if url:
        result["url"] = url
    return result


def normalize_artist_sources(artist: Mapping[str, Any] | None) -> list[dict[str, str]]:
    """Merge additive ``sources`` with legacy Instagram/source fields."""

    value = artist or {}
    candidates: list[Any] = []
    raw_sources = value.get("sources")
    if isinstance(raw_sources, (list, tuple)):
        candidates.extend(raw_sources)
    legacy_instagram = normalize_artist_source(
        {"provider": "instagram", "username": value.get("handle"), "url": value.get("instagram")}
    )
    if legacy_instagram:
        candidates.append(legacy_instagram)
    legacy_source = normalize_artist_source(
        {
            "provider": value.get("link_type") or value.get("linkType") or "external",
            "url": value.get("source_page") or value.get("sourcePage"),
        }
    )
    if legacy_source:
        candidates.append(legacy_source)

    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for candidate in candidates:
        source = normalize_artist_source(candidate)
        if not source:
            continue
        key = "|".join(
            (source.get("provider", ""), source.get("username", ""),
             source.get("externalId", ""), source.get("url", ""))
        )
        if key not in seen:
            seen.add(key)
            result.append(source)
    return result


def normalize_artist_record(value: Mapping[str, Any] | None) -> dict[str, Any]:
    """Map crawler data to the stable public Artist shape.

    Existing public keys retain their names and meanings.  ``sources``,
    ``relevance`` and ``keywordHits`` are additive crawler metadata.
    """

    artist: Mapping[str, Any] = value if isinstance(value, Mapping) else {}
    sources = normalize_artist_sources(artist)
    instagram_source = next(
        (source for source in sources if source.get("provider") == "instagram" and source.get("username")),
        None,
    )
    external_source = next(
        (source for source in sources if source.get("provider") != "instagram" and source.get("url")),
        None,
    )
    handle = (
        f"@{instagram_source['username']}" if instagram_source else clean_text(artist.get("handle"))
    )
    instagram = instagram_source.get("url", "") if instagram_source else canonical_profile_url(artist.get("instagram"))
    source_page = (
        external_source.get("url", "")
        if external_source
        else canonical_external_url(artist.get("source_page") or artist.get("sourcePage"))
    )
    if not source_page and instagram:
        source_page = instagram
    styles_value = artist.get("styles", [])
    if isinstance(styles_value, (list, tuple)):
        styles = [clean_text(item) for item in styles_value if clean_text(item)]
    else:
        styles = [clean_text(item) for item in re.split(r"[,，、\n]", str(styles_value or "")) if clean_text(item)]
    name = clean_text(artist.get("name")) or (f"@{instagram_source['username']}" if instagram_source else "")
    normalized: dict[str, Any] = {
        "name": name,
        "romanName": clean_text(artist.get("romanName") or artist.get("roman_name")),
        "handle": handle,
        "instagram": instagram,
        "sourcePage": source_page,
        "linkType": (external_source.get("provider") if external_source else ("instagram" if instagram else normalize_source_provider(artist.get("linkType") or artist.get("link_type")))),
        "region": clean_text(artist.get("region")),
        "school": clean_text(artist.get("school")),
        "styles": styles,
        "note": sanitize_bio(artist.get("note")),
        "sources": sources,
    }
    if "relevance" in artist:
        normalized["relevance"] = clean_text(artist.get("relevance")) or "unclassified"
    if isinstance(artist.get("keywordHits"), (list, tuple)):
        normalized["keywordHits"] = [clean_text(item) for item in artist["keywordHits"] if clean_text(item)]
    return normalized


def artist_identity_keys(value: Mapping[str, Any] | None) -> set[str]:
    """Build deterministic identity keys for duplicate and idempotency checks."""

    artist = normalize_artist_record(value)
    keys: set[str] = set()
    artist_id = clean_text((value or {}).get("id")) if isinstance(value, Mapping) else ""
    if artist_id:
        keys.add(f"id:{artist_id.casefold()}")
    for source in artist.get("sources", []):
        provider = source.get("provider", "")
        username = source.get("username", "")
        external_id = source.get("externalId", "")
        url = source.get("url", "")
        if provider == "instagram" and username:
            keys.add(f"instagram:{username}")
        if url:
            keys.add(f"url:{url}")
        if provider and external_id:
            keys.add(f"external:{provider}:{external_id.casefold()}")
    return keys


def find_duplicate_artist(
    candidate: Mapping[str, Any] | None,
    rows: Iterable[Mapping[str, Any]],
    exclude_id: Any = "",
) -> tuple[Mapping[str, Any], str] | None:
    candidate_keys = artist_identity_keys(candidate)
    if not candidate_keys:
        return None
    excluded = clean_text(exclude_id).casefold()
    for row in rows or []:
        if not isinstance(row, Mapping):
            continue
        row_id = clean_text(row.get("id")).casefold()
        if excluded and row_id == excluded:
            continue
        overlap = candidate_keys.intersection(artist_identity_keys(row))
        if overlap:
            return row, sorted(overlap)[0]
    return None


def artist_idempotency_key(value: Mapping[str, Any] | None) -> str:
    """Stable key shared by retries and repeated crawler runs."""

    identity_keys = artist_identity_keys(value)
    # The Instagram username is the primary crawler identity. Auxiliary
    # source URLs and display metadata may change between crawls, so they must
    # not rotate the idempotency key for an otherwise identical profile.
    keys = sorted(key for key in identity_keys if key.startswith("instagram:"))
    if not keys:
        keys = sorted(key for key in identity_keys if key.startswith("external:"))
    if not keys:
        keys = sorted(key for key in identity_keys if key.startswith("url:"))
    if not keys:
        normalized = normalize_artist_record(value)
        keys = [f"name:{normalize_name(normalized.get('name'))}"]
    digest = hashlib.sha256(("nihonga-artist-v1|" + "|".join(keys)).encode("utf-8")).hexdigest()
    return f"nihonga-{digest[:40]}"


def detect_school_region(value: Any) -> tuple[str, str]:
    searchable = clean_text(value).casefold()
    for school, region, keywords in SCHOOL_RULES:
        if any(keyword.casefold() in searchable for keyword in keywords):
            return school, region
    return "", ""


def sanitize_bio(value: Any) -> str:
    """Keep a short public bio while dropping contact details and counters."""

    text = clean_text(value)
    if not text:
        return ""
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[contact removed]", text)
    text = re.sub(r"(?<!\w)\+?\d[\d\s().-]{6,}\d(?!\w)", "[contact removed]", text)
    text = re.sub(r"\b[\d,.]+\s*(?:followers?|following|posts?)\b", "", text, flags=re.IGNORECASE)
    return clean_text(text)[:280]


class _FallbackHTMLParser(HTMLParser):
    """Small stdlib parser used only when Scrapling is not installed.

    Production fetching still requires Scrapling. This fallback keeps unit
    tests and fixture parsing deterministic on a fresh checkout.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.jsonld: list[str] = []
        self.links: list[str] = []
        self._script_depth = 0
        self._capture_jsonld = False
        self._script_buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {key.casefold(): value or "" for key, value in attrs}
        if tag.casefold() == "a" and attrs_map.get("href"):
            self.links.append(attrs_map["href"])
        if tag.casefold() == "meta":
            key = attrs_map.get("property") or attrs_map.get("name")
            content = attrs_map.get("content")
            if key and content:
                self.meta[key.casefold()] = content
        if tag.casefold() == "script":
            self._script_depth += 1
            script_type = attrs_map.get("type", "").casefold()
            self._capture_jsonld = script_type == "application/ld+json"
            self._script_buffer = []

    def handle_data(self, data: str) -> None:
        if self._script_depth and self._capture_jsonld:
            self._script_buffer.append(data)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag.casefold() == "script":
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "script" and self._script_depth:
            if self._capture_jsonld:
                self.jsonld.append("".join(self._script_buffer))
            self._script_depth -= 1
            self._capture_jsonld = False
            self._script_buffer = []


def _jsonld_people(values: Iterable[str]) -> list[dict[str, Any]]:
    people: list[dict[str, Any]] = []
    for raw in values:
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            graph = node.get("@graph")
            if isinstance(graph, list):
                nodes.extend(item for item in graph if isinstance(item, dict))
            node_type = node.get("@type", "")
            types = node_type if isinstance(node_type, list) else [node_type]
            if any(str(item).casefold() == "person" for item in types):
                people.append(node)
    return people


def _extract_fields_from_page(page: Any) -> dict[str, Any]:
    def first(selectors: Iterable[str]) -> str:
        for selector in selectors:
            try:
                values = page.css(selector).getall()
            except Exception:
                continue
            for value in values:
                text = clean_text(value)
                if text:
                    return text
        return ""

    jsonld = []
    try:
        jsonld = page.css("script[type='application/ld+json']::text").getall()
    except Exception:
        pass
    return {
        "title": first(("meta[property='og:title']::attr(content)", "meta[name='twitter:title']::attr(content)")),
        "description": first((
            "meta[property='og:description']::attr(content)",
            "meta[name='description']::attr(content)",
            "meta[name='twitter:description']::attr(content)",
        )),
        "url": first(("meta[property='og:url']::attr(content)", "link[rel='canonical']::attr(href)")),
        "jsonld": jsonld,
    }


def _extract_fields_from_html(raw_html: str) -> dict[str, Any]:
    if Selector is not None:
        return _extract_fields_from_page(Selector(raw_html))
    parser = _FallbackHTMLParser()
    parser.feed(raw_html)
    return {
        "title": parser.meta.get("og:title") or parser.meta.get("twitter:title", ""),
        "description": (
            parser.meta.get("og:description")
            or parser.meta.get("description")
            or parser.meta.get("twitter:description", "")
        ),
        "url": parser.meta.get("og:url", ""),
        "jsonld": parser.jsonld,
    }


def _name_from_title(title: str, handle: str) -> str:
    title = clean_text(title)
    if not title:
        return ""
    match = re.match(r"^(.+?)\s*\(@?[a-z0-9._]{1,30}\)\s*(?:[|•-].*)?$", title, re.IGNORECASE)
    if match:
        title = match.group(1)
    title = re.sub(r"\s*(?:on Instagram|Instagram)\s*$", "", title, flags=re.IGNORECASE)
    if title.casefold() in {"instagram", "photos and videos"}:
        return ""
    if handle and title.casefold() == handle.casefold():
        return ""
    return clean_text(title)


def _profile_description(fields: dict[str, Any], person: dict[str, Any]) -> str:
    descriptions = []
    if isinstance(person, dict):
        descriptions.append(clean_text(person.get("description", "")))
    descriptions.append(clean_text(fields.get("description", "")))
    # Metadata often repeats the same bio in JSON-LD and Open Graph tags.
    unique = list(dict.fromkeys(item for item in descriptions if item))
    return sanitize_bio(" ".join(unique))


def parse_profile_html(raw_html: str, profile_url: str) -> dict[str, Any]:
    """Parse only public profile metadata into the site's artist shape."""

    fields = _extract_fields_from_html(raw_html)
    jsonld_people = _jsonld_people(fields.get("jsonld", []))
    person = jsonld_people[0] if jsonld_people else {}

    handle = normalize_handle(fields.get("url")) or normalize_handle(profile_url)
    jsonld_url = person.get("url") if isinstance(person, dict) else ""
    handle = normalize_handle(jsonld_url) or handle
    canonical_url = canonical_profile_url(handle) or canonical_profile_url(profile_url)

    jsonld_name = clean_text(person.get("name", "")) if isinstance(person, dict) else ""
    name = jsonld_name or _name_from_title(fields.get("title", ""), handle) or (f"@{handle}" if handle else "")
    description = _profile_description(fields, person)
    school, region = detect_school_region(f"{fields.get('title', '')} {description}")

    searchable = " ".join((name, description, fields.get("title", ""))).casefold()
    keyword_hits = [keyword for keyword in NIHONGA_KEYWORDS if keyword.casefold() in searchable]
    styles = ["日本画"]
    if school:
        styles.append(school)
    if any(keyword in searchable for keyword in ("岩絵具", "岩絵の具", "mineral pigment", "gofun")):
        styles.append("岩彩")

    return normalize_artist_record({
        "name": name,
        "romanName": "",
        "handle": f"@{handle}" if handle else "",
        "instagram": canonical_url,
        "sourcePage": canonical_url,
        "linkType": "instagram",
        "region": region,
        "school": school,
        "styles": styles,
        "note": f"Instagram 公开简介：{description}" if description else "Instagram 公开资料，待人工补充。",
        "relevance": "keyword" if keyword_hits else "unclassified",
        "keywordHits": keyword_hits,
    })


def parse_profile_page(page: Any, profile_url: str) -> dict[str, Any]:
    """Parse a Scrapling Response/Selector object."""

    fields = _extract_fields_from_page(page)
    # Reuse the same metadata logic as fixture parsing without serializing the
    # response object (which can be expensive for dynamic pages).
    jsonld_people = _jsonld_people(fields.get("jsonld", []))
    person = jsonld_people[0] if jsonld_people else {}
    handle = normalize_handle(fields.get("url")) or normalize_handle(profile_url)
    handle = normalize_handle(person.get("url", "")) or handle
    canonical_url = canonical_profile_url(handle) or canonical_profile_url(profile_url)
    jsonld_name = clean_text(person.get("name", "")) if isinstance(person, dict) else ""
    name = jsonld_name or _name_from_title(fields.get("title", ""), handle) or (f"@{handle}" if handle else "")
    description = _profile_description(fields, person)
    school, region = detect_school_region(f"{fields.get('title', '')} {description}")
    searchable = " ".join((name, description, fields.get("title", ""))).casefold()
    keyword_hits = [keyword for keyword in NIHONGA_KEYWORDS if keyword.casefold() in searchable]
    styles = ["日本画"]
    if school:
        styles.append(school)
    if any(keyword in searchable for keyword in ("岩絵具", "岩絵の具", "mineral pigment", "gofun")):
        styles.append("岩彩")
    return normalize_artist_record({
        "name": name,
        "romanName": "",
        "handle": f"@{handle}" if handle else "",
        "instagram": canonical_url,
        "sourcePage": canonical_url,
        "linkType": "instagram",
        "region": region,
        "school": school,
        "styles": styles,
        "note": f"Instagram 公开简介：{description}" if description else "Instagram 公开资料，待人工补充。",
        "relevance": "keyword" if keyword_hits else "unclassified",
        "keywordHits": keyword_hits,
    })


def fetch_profile(profile_url: str, timeout: int = 30) -> dict[str, Any]:
    if Fetcher is None:
        raise RuntimeError('Scrapling is not installed. Run: python -m pip install "scrapling[all]>=0.4.11"')
    page = Fetcher.get(
        profile_url,
        stealthy_headers=True,
        timeout=timeout,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8"},
    )
    return parse_profile_page(page, profile_url)


def _read_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _artist_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        # Accept both the public API envelope and a direct Supabase-like
        # ``data`` envelope while keeping malformed payloads explicit.
        payload = payload.get("artists", payload.get("data", []))
        if isinstance(payload, dict):
            payload = payload.get("artists", payload.get("data", []))
    if not isinstance(payload, list):
        raise ValueError("artists 数据必须是数组或包含 artists 数组的对象。")
    return [row for row in payload if isinstance(row, dict)]


def _seed_values_from_json(payload: Any) -> Iterable[str]:
    """Extract profile links from plain seed files and Instagram exports."""
    if isinstance(payload, str):
        yield payload
        return
    if isinstance(payload, list):
        for item in payload:
            yield from _seed_values_from_json(item)
        return
    if not isinstance(payload, dict):
        return

    for key in ("instagram", "url", "href", "link", "value"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            yield value

    # Instagram's Accounts Center export stores followed accounts in
    # relationships_following[].string_list_data[].href/value.
    for key in ("string_list_data", "relationships_following", "following", "seeds", "urls", "artists"):
        value = payload.get(key)
        if value is not None:
            yield from _seed_values_from_json(value)


def load_existing_artists(
    endpoint: str,
    existing_file: str | None,
    timeout: int = 20,
    *,
    retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
    retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF,
    sleep_fn: Callable[[float], None] | None = None,
    logger: Any = None,
) -> list[dict[str, Any]]:
    if existing_file:
        return _artist_rows(_read_json_file(Path(existing_file)))

    def read_snapshot() -> Any:
        request = Request(endpoint, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def on_attempt(attempt: int, error: BaseException, retry: bool) -> None:
        _emit_log(logger, "artists-read-retry" if retry else "artists-read-failed", attempt=attempt, retrying=retry, reason=clean_text(error)[:200])

    payload = retry_call(
        read_snapshot,
        attempts=max(1, int(retry_attempts)),
        backoff_seconds=retry_backoff_seconds,
        sleep_fn=sleep_fn or time.sleep,
        on_attempt=on_attempt,
    )
    rows = _artist_rows(payload)
    _emit_log(logger, "artists-read-finished", count=len(rows))
    return rows


def load_seed_urls(seed_values: Iterable[str], seed_file: str | None) -> tuple[list[str], list[str]]:
    raw_values = [str(value) for value in seed_values if str(value).strip()]
    invalid: list[str] = []
    if seed_file:
        path = Path(seed_file)
        if path.suffix.casefold() == ".json":
            payload = _read_json_file(path)
            raw_values.extend(_seed_values_from_json(payload))
        elif path.suffix.casefold() in {".html", ".htm"}:
            raw_html = path.read_text(encoding="utf-8-sig")
            parser = _FallbackHTMLParser()
            parser.feed(raw_html)
            raw_values.extend(parser.links)
        elif path.suffix.casefold() == ".csv":
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    raw_values.append(row.get("url") or row.get("instagram") or row.get("handle") or "")
        else:
            raw_values.extend(line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip() and not line.lstrip().startswith("#"))

    urls: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        url = canonical_profile_url(raw)
        if not url:
            invalid.append(raw)
            continue
        if url not in seen:
            urls.append(url)
            seen.add(url)
    return urls, invalid


def robots_allowed(
    profile_url: str,
    user_agent: str = USER_AGENT,
    timeout: int = 15,
    *,
    retry_attempts: int = 2,
    retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF,
    sleep_fn: Callable[[float], None] | None = None,
) -> tuple[bool, str]:
    parsed = urlsplit(profile_url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"

    def read_robots() -> str:
        request = Request(robots_url, headers={"User-Agent": user_agent, "Accept": "text/plain"})
        with urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")

    try:
        body = retry_call(
            read_robots,
            attempts=max(1, int(retry_attempts)),
            backoff_seconds=retry_backoff_seconds,
            sleep_fn=sleep_fn or time.sleep,
        )
    except HTTPError as error:
        # RFC 9309 treats a missing robots file as "unavailable": crawlers may
        # access the requested resources. Keep other HTTP failures fail-closed.
        if error.code in {404, 410}:
            return True, "robots-not-found"
        return False, "robots-unavailable"
    except (URLError, TimeoutError, ConnectionError, OSError, ValueError):
        return False, "robots-unavailable"

    from urllib.robotparser import RobotFileParser

    parser = RobotFileParser()
    parser.set_url(robots_url)
    parser.parse(body.splitlines())
    allowed = parser.can_fetch(user_agent, profile_url)
    return allowed, "ok" if allowed else "robots-denied"


def _existing_handles(rows: Iterable[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        handle = first_valid_handle(row.get("handle"), row.get("instagram"))
        if handle:
            result.setdefault(handle, row)
    return result


def _existing_names(rows: Iterable[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        name = normalize_name(row.get("name"))
        if name:
            result.setdefault(name, row)
    return result


def _invoke_fetcher(fetcher: Callable[..., Any], seed_url: str, timeout: int) -> Any:
    """Call custom fetchers with or without the optional timeout parameter."""

    try:
        signature = inspect.signature(fetcher)
        parameters = signature.parameters.values()
        accepts_timeout = any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters)
        accepts_timeout = accepts_timeout or "timeout" in signature.parameters
    except (TypeError, ValueError):
        accepts_timeout = True
    if accepts_timeout:
        return fetcher(seed_url, timeout=timeout)
    return fetcher(seed_url)


def _candidate_error(error: BaseException, attempt: int | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {
        "reason": clean_text(error)[:200] or error.__class__.__name__,
        "errorType": error.__class__.__name__,
    }
    if attempt is not None:
        value["attempt"] = attempt
    return value


def collect_candidates(
    seed_urls: Iterable[str],
    existing_rows: Iterable[Mapping[str, Any]],
    *,
    delay_seconds: float = 2.0,
    require_keyword: bool = False,
    timeout: int = 30,
    check_robots: bool = True,
    fetcher: Any = fetch_profile,
    retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
    retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF,
    max_retries: int | None = None,
    sleep_fn: Callable[[float], None] | None = None,
    logger: Any = None,
) -> dict[str, Any]:
    rows = [row for row in existing_rows if isinstance(row, Mapping)]
    existing = _existing_handles(rows)
    existing_names = _existing_names(rows)
    existing_keys: dict[str, Mapping[str, Any]] = {}
    for row in rows:
        for key in artist_identity_keys(row):
            existing_keys.setdefault(key, row)
    seen: set[str] = set()
    seen_keys: set[str] = set()
    seen_names: set[str] = set()
    new_artists: list[dict[str, Any]] = []
    duplicates: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    robots_cache: dict[str, tuple[bool, str]] = {}
    urls = list(seed_urls)
    sleeper = sleep_fn or time.sleep
    attempts = max(1, int(max_retries) + 1) if max_retries is not None else max(1, int(retry_attempts))

    _emit_log(logger, "crawl-start", seeds=len(urls), retryAttempts=attempts)

    for index, seed_url in enumerate(urls):
        if index and delay_seconds > 0:
            sleeper(delay_seconds)
        raw_seed_url = clean_text(seed_url)
        seed_url = canonical_profile_url(raw_seed_url) or raw_seed_url
        seed_handle = normalize_handle(seed_url)
        if not seed_handle:
            rejected.append({"url": seed_url, "reason": "invalid-profile-url"})
            _emit_log(logger, "candidate-rejected", url=seed_url, reason="invalid-profile-url")
            continue
        if seed_handle in existing:
            duplicates.append({"url": seed_url, "handle": seed_handle, "reason": "already-in-artists"})
            _emit_log(logger, "candidate-duplicate", url=seed_url, handle=seed_handle, reason="already-in-artists")
            continue
        if seed_handle in seen:
            duplicates.append({"url": seed_url, "handle": seed_handle, "reason": "duplicate-seed"})
            _emit_log(logger, "candidate-duplicate", url=seed_url, handle=seed_handle, reason="duplicate-seed")
            continue
        seen.add(seed_handle)
        _emit_log(logger, "fetch-start", url=seed_url, handle=seed_handle)

        if check_robots:
            host = (urlsplit(seed_url).hostname or urlsplit(seed_url).netloc).casefold()
            robots_cache.setdefault(
                host,
                robots_allowed(
                    seed_url,
                    timeout=min(timeout, 15),
                    retry_attempts=min(attempts, 2),
                    retry_backoff_seconds=retry_backoff_seconds,
                    sleep_fn=sleeper,
                ),
            )
            allowed, reason = robots_cache[host]
            if not allowed:
                rejected.append({"url": seed_url, "handle": seed_handle, "reason": reason})
                _emit_log(logger, "candidate-rejected", url=seed_url, handle=seed_handle, reason=reason)
                continue

        try:
            def on_fetch_attempt(attempt: int, error: BaseException, retry: bool) -> None:
                _emit_log(
                    logger,
                    "fetch-retry" if retry else "fetch-failed",
                    url=seed_url,
                    handle=seed_handle,
                    attempt=attempt,
                    retrying=retry,
                    reason=clean_text(error)[:200],
                )

            artist = retry_call(
                lambda: _invoke_fetcher(fetcher, seed_url, timeout),
                attempts=attempts,
                backoff_seconds=retry_backoff_seconds,
                sleep_fn=sleeper,
                on_attempt=on_fetch_attempt,
            )
        except Exception as error:  # Keep one transient profile from aborting the batch.
            item = {"url": seed_url, "handle": seed_handle, **_candidate_error(error)}
            errors.append(item)
            _emit_log(logger, "candidate-error", **item)
            continue

        if not isinstance(artist, Mapping):
            error = ValueError("fetcher returned a non-object candidate")
            item = {"url": seed_url, "handle": seed_handle, **_candidate_error(error)}
            errors.append(item)
            _emit_log(logger, "candidate-error", **item)
            continue

        artist = normalize_artist_record(artist)
        handle = first_valid_handle(artist.get("handle"), artist.get("instagram"))
        if not handle:
            rejected.append({"url": seed_url, "handle": seed_handle, "reason": "profile-handle-missing"})
            _emit_log(logger, "candidate-rejected", url=seed_url, handle=seed_handle, reason="profile-handle-missing")
            continue
        artist["handle"] = f"@{handle}"
        artist["instagram"] = canonical_profile_url(handle)
        artist["sourcePage"] = artist["instagram"]
        candidate_keys = artist_identity_keys(artist)
        overlap = candidate_keys.intersection(existing_keys)
        if handle in existing or overlap:
            reason = "already-in-artists-after-redirect" if handle in existing else "already-in-artists-source"
            duplicates.append({"url": seed_url, "handle": handle, "reason": "already-in-artists-after-redirect"})
            duplicates[-1]["reason"] = reason
            _emit_log(logger, "candidate-duplicate", url=seed_url, handle=handle, reason=reason)
            continue
        name_key = normalize_name(artist.get("name"))
        if name_key and name_key in existing_names:
            duplicates.append({"url": seed_url, "handle": handle, "reason": "already-in-artists-name"})
            _emit_log(logger, "candidate-duplicate", url=seed_url, handle=handle, reason="already-in-artists-name")
            continue
        if candidate_keys.intersection(seen_keys):
            duplicates.append({"url": seed_url, "handle": handle, "reason": "duplicate-profile-result"})
            _emit_log(logger, "candidate-duplicate", url=seed_url, handle=handle, reason="duplicate-profile-result")
            continue
        if name_key and name_key in seen_names:
            duplicates.append({"url": seed_url, "handle": handle, "reason": "duplicate-profile-name"})
            _emit_log(logger, "candidate-duplicate", url=seed_url, handle=handle, reason="duplicate-profile-name")
            continue
        if require_keyword and artist.get("relevance") != "keyword":
            rejected.append({"url": seed_url, "handle": handle, "reason": "no-nihonga-keyword"})
            _emit_log(logger, "candidate-rejected", url=seed_url, handle=handle, reason="no-nihonga-keyword")
            continue
        new_artists.append(artist)
        seen_keys.update(candidate_keys)
        if name_key:
            seen_names.add(name_key)
        _emit_log(logger, "candidate-accepted", url=artist.get("instagram"), handle=handle, name=artist.get("name"))

    result = {
        "newArtists": new_artists,
        "duplicates": duplicates,
        "rejected": rejected,
        "errors": errors,
        "summary": {
            "seeds": len(urls),
            "new": len(new_artists),
            "duplicates": len(duplicates),
            "rejected": len(rejected),
            "errors": len(errors),
        },
    }
    _emit_log(logger, "crawl-finished", **result["summary"])
    return result


def read_admin_password(path: str) -> str:
    text = Path(path).read_text(encoding="utf-8-sig")
    match = re.search(r"(?:管理员密码|Admin password)\s*[:：]\s*([^\s]+)", text, flags=re.IGNORECASE)
    if match:
        return match.group(1).strip()
    for line in text.splitlines():
        value = line.strip()
        if value and not value.startswith("#"):
            return value
    return ""


def write_json_atomic(path: str | Path, payload: Any) -> None:
    """Durably replace a JSON file without leaving a truncated report."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def load_push_state(path: str | Path | None) -> dict[str, Any]:
    if not path:
        return {}
    try:
        payload = _read_json_file(Path(path))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(payload, Mapping):
        return {}
    records = payload.get("records")
    if isinstance(records, Mapping):
        return {"version": payload.get("version", 1), "records": dict(records)}
    # Accept the original flat shape if a caller supplied one.
    return {"version": 1, "records": {key: value for key, value in payload.items() if key != "version"}}


def save_push_state(path: str | Path | None, state: Mapping[str, Any]) -> None:
    if path:
        write_json_atomic(path, dict(state))


def _response_payload(body: str, status: int, attempts: int, idempotency_key: str) -> dict[str, Any]:
    try:
        payload = json.loads(body or "{}")
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, Mapping):
        payload = {}
    result = dict(payload)
    result.setdefault("ok", 200 <= status < 300)
    result.setdefault("status", status)
    result.setdefault("attempts", attempts)
    result.setdefault("idempotencyKey", idempotency_key)
    return result


def _retry_after_seconds(error: HTTPError) -> float | None:
    try:
        value = error.headers.get("Retry-After") if error.headers else None
        return max(0.0, float(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


def push_artist(
    endpoint: str,
    artist: Mapping[str, Any],
    password: str,
    timeout: int = 30,
    *,
    retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
    retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF,
    max_retries: int | None = None,
    sleep_fn: Callable[[float], None] | None = None,
    logger: Any = None,
) -> dict[str, Any]:
    """POST one artist with a deterministic idempotency key and retries.

    The endpoint may safely retry a timed-out request because every attempt
    carries the same key.  Legacy admin endpoints ignore the header and still
    protect writes with their duplicate check.
    """

    normalized = normalize_artist_record(artist)
    payload = {key: normalized.get(key) for key in (
        "name", "romanName", "handle", "instagram", "sourcePage", "linkType",
        "region", "school", "styles", "note"
    )}
    idempotency_key = artist_idempotency_key(normalized)
    sleeper = sleep_fn or time.sleep
    attempts = max(1, int(max_retries) + 1) if max_retries is not None else max(1, int(retry_attempts))
    try:
        backoff = max(0.0, float(retry_backoff_seconds))
    except (TypeError, ValueError):
        backoff = DEFAULT_RETRY_BACKOFF

    for attempt in range(1, attempts + 1):
        request = Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "X-Admin-Password": password,
                "Idempotency-Key": idempotency_key,
                "X-Idempotency-Key": idempotency_key,
            },
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                status = int(getattr(response, "status", 200) or 200)
                result = _response_payload(response.read().decode("utf-8", errors="replace"), status, attempt, idempotency_key)
                _emit_log(logger, "write-finished", handle=normalized.get("handle"), status=status, attempt=attempt, ok=bool(result.get("ok")))
                return result
        except HTTPError as error:
            try:
                body = error.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            result = _response_payload(body, int(error.code or 0), attempt, idempotency_key)
            retry = attempt < attempts and int(error.code or 0) in RETRYABLE_HTTP_STATUS
            _emit_log(logger, "write-retry" if retry else "write-failed", handle=normalized.get("handle"), status=error.code, attempt=attempt, retrying=retry, reason=result.get("message", ""))
            if not retry:
                return result
            delay = _retry_after_seconds(error)
            if delay is None:
                delay = min(MAX_RETRY_BACKOFF, backoff * (2 ** (attempt - 1)))
            if delay > 0:
                sleeper(delay)
        except Exception as error:
            retry = attempt < attempts and is_retryable_error(error)
            _emit_log(logger, "write-retry" if retry else "write-failed", handle=normalized.get("handle"), attempt=attempt, retrying=retry, reason=clean_text(error)[:200])
            if not retry:
                return {
                    "ok": False,
                    "status": 0,
                    "message": clean_text(error)[:200] or error.__class__.__name__,
                    "attempts": attempt,
                    "idempotencyKey": idempotency_key,
                }
            delay = min(MAX_RETRY_BACKOFF, backoff * (2 ** (attempt - 1)))
            if delay > 0:
                sleeper(delay)

    return {"ok": False, "status": 0, "message": "写入重试耗尽。", "attempts": attempts, "idempotencyKey": idempotency_key}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export public Instagram Nihonga artist candidates with duplicate filtering.")
    parser.add_argument("--seed", action="append", default=[], help="Public Instagram profile URL or @handle. Repeatable.")
    parser.add_argument("--seed-file", help="TXT, CSV, or JSON file containing public profile URLs/handles.")
    parser.add_argument("--existing-file", help="Use a saved /api/artists response instead of making a GET request.")
    parser.add_argument("--artists-api", default=os.getenv("NIHONGA_ARTISTS_API", DEFAULT_ARTISTS_API), help="GET-only artists endpoint used for deduplication.")
    parser.add_argument("--out", default="imports/instagram-candidates.json", help="Review JSON output path.")
    parser.add_argument("--limit", type=int, default=50, help="Maximum number of unique seeds to process (default: 50).")
    parser.add_argument("--delay", type=float, default=2.0, help="Delay between profile requests in seconds (default: 2).")
    parser.add_argument("--timeout", type=int, default=30, help="Scrapling request timeout in seconds (default: 30).")
    parser.add_argument("--retry-attempts", type=int, default=DEFAULT_RETRY_ATTEMPTS, help="Maximum attempts for each fetch/write (default: 3).")
    parser.add_argument("--retry-backoff", type=float, default=DEFAULT_RETRY_BACKOFF, help="Initial retry backoff in seconds (default: 1).")
    parser.add_argument("--require-nihonga-keyword", action="store_true", help="Export only profiles whose public metadata contains a Nihonga keyword.")
    parser.add_argument("--push", action="store_true", help="POST newArtists to the website admin API after the report is generated.")
    parser.add_argument("--admin-password-file", help="Local file containing ADMIN_PASSWORD; required with --push.")
    parser.add_argument("--log-file", help="Optional append-only JSONL crawler log path.")
    parser.add_argument("--state-file", help="Optional JSON state file for idempotent push resumes.")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.limit < 1 or args.limit > 200:
        parser.error("--limit 必须在 1 到 200 之间。")
    if args.delay < 0:
        parser.error("--delay 不能小于 0。")
    if args.retry_attempts < 1:
        parser.error("--retry-attempts 必须至少为 1。")
    if args.retry_backoff < 0:
        parser.error("--retry-backoff 不能小于 0。")
    if args.push and not args.admin_password_file:
        parser.error("--push 需要 --admin-password-file。")
    logger = CrawlerLogger(args.log_file) if args.log_file else None
    try:
        seed_urls, invalid = load_seed_urls(args.seed, args.seed_file)
        seed_urls = seed_urls[: args.limit]
        if not seed_urls:
            parser.error("请至少提供一个公开 Instagram 个人主页 URL 或 --seed-file。")
        existing = load_existing_artists(
            args.artists_api,
            args.existing_file,
            timeout=args.timeout,
            retry_attempts=args.retry_attempts,
            retry_backoff_seconds=args.retry_backoff,
            logger=logger,
        )
        result = collect_candidates(
            seed_urls,
            existing,
            delay_seconds=args.delay,
            require_keyword=args.require_nihonga_keyword,
            timeout=args.timeout,
            check_robots=True,
            retry_attempts=args.retry_attempts,
            retry_backoff_seconds=args.retry_backoff,
            logger=logger,
        )
    except (OSError, ValueError, HTTPError, URLError) as error:
        print(f"读取输入失败: {error}", file=sys.stderr)
        return 2

    if invalid:
        result["rejected"].extend({"url": value, "reason": "invalid-seed"} for value in invalid)
        result["summary"]["rejected"] = len(result["rejected"])

    result["pushed"] = []
    result["skipped"] = []
    result["pushErrors"] = []
    result["runId"] = logger.run_id if logger else f"crawl-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')}"
    if logger and logger.path:
        result["logFile"] = str(logger.path)
    if args.push and result["newArtists"]:
        password = read_admin_password(args.admin_password_file)
        if not password:
            parser.error(f"在 {args.admin_password_file} 中没有找到管理员密码。")
        parsed_api = urlsplit(args.artists_api)
        admin_endpoint = f"{parsed_api.scheme}://{parsed_api.netloc}/api/admin-artists"
        state = load_push_state(args.state_file)
        records = state.setdefault("records", {})
        for artist in result["newArtists"]:
            key = artist_idempotency_key(artist)
            previous = records.get(key)
            if isinstance(previous, Mapping) and previous.get("status") in {"pushed", "duplicate"}:
                result["skipped"].append({"handle": artist.get("handle"), "idempotencyKey": key, "reason": "already-processed"})
                _emit_log(logger, "write-skipped", handle=artist.get("handle"), idempotencyKey=key, reason="already-processed")
                continue
            response = push_artist(
                admin_endpoint,
                artist,
                password,
                timeout=args.timeout,
                retry_attempts=args.retry_attempts,
                retry_backoff_seconds=args.retry_backoff,
                logger=logger,
            )
            if response.get("ok"):
                result["pushed"].append({"handle": artist.get("handle"), "response": response})
                records[key] = {"status": "pushed", "updatedAt": _utc_now(), "handle": artist.get("handle")}
            elif int(response.get("status", 0) or 0) == 409:
                result["duplicates"].append({
                    "url": artist.get("instagram", ""),
                    "handle": normalize_handle(artist.get("handle")),
                    "reason": "server-duplicate",
                })
                result["summary"]["duplicates"] += 1
                records[key] = {"status": "duplicate", "updatedAt": _utc_now(), "handle": artist.get("handle")}
            else:
                result["pushErrors"].append({
                    "url": artist.get("instagram", ""),
                    "handle": artist.get("handle", ""),
                    "reason": response.get("message", "import-failed"),
                })
                records[key] = {"status": "error", "updatedAt": _utc_now(), "handle": artist.get("handle"), "reason": response.get("message", "import-failed")}
            save_push_state(args.state_file, state)
        result["writeMode"] = "admin-api-post"
    result["generatedAt"] = _utc_now()
    result["source"] = "instagram-public-profile"
    if not args.push:
        result["writeMode"] = "review-only; no Supabase mutations"

    output_path = Path(args.out)
    write_json_atomic(output_path, result)
    summary = result["summary"]
    print(f"已生成待审核文件: {output_path}")
    print(f"种子 {summary['seeds']} | 新候选 {summary['new']} | 重复 {summary['duplicates']} | 拒绝 {summary['rejected']} | 错误 {summary['errors']}")
    if args.push:
        print(f"已写入网站 {len(result['pushed'])} 条；服务端重复 {len(result['duplicates'])} 条；写入错误 {len(result['pushErrors'])} 条。")
    else:
        print("脚本没有调用任何网站写入接口；检查 JSON 后可用 --push 批量添加。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
