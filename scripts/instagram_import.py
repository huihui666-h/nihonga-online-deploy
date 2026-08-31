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
import html
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

try:
    from scrapling.fetchers import Fetcher
    from scrapling.parser import Selector
except ImportError:  # Keep local parsing/tests usable before optional install.
    Fetcher = None
    Selector = None


USER_AGENT = "nihonga-directory-import/1.0 (+public-profile-review)"
DEFAULT_ARTISTS_API = "https://nihonga-online-deploy.vercel.app/api/artists"
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

    is_url = bool(re.match(r"^https?://", raw, re.IGNORECASE)) or "instagram.com/" in raw.casefold()
    if is_url:
        candidate = raw if re.match(r"^https?://", raw, re.IGNORECASE) else f"https://{raw}"
        parsed = urlsplit(candidate)
        host = (parsed.hostname or "").casefold().rstrip(".")
        if host not in {"instagram.com", "www.instagram.com"}:
            return ""
        segments = [unquote(part).strip() for part in parsed.path.split("/") if part.strip()]
        if segments and segments[0].casefold() == "_u":
            segments = segments[1:]
        if not segments or segments[0].casefold() in NON_PROFILE_PATHS:
            return ""
        raw = segments[0]
    else:
        raw = raw.split("?", 1)[0].split("#", 1)[0].strip().lstrip("@").strip("/")

    handle = raw.casefold()
    return handle if USERNAME_RE.fullmatch(handle) else ""


def canonical_profile_url(value: Any) -> str:
    handle = normalize_handle(value)
    return f"https://www.instagram.com/{handle}/" if handle else ""


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

    return {
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
    }


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
    return {
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
    }


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
        payload = payload.get("artists", [])
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


def load_existing_artists(endpoint: str, existing_file: str | None, timeout: int = 20) -> list[dict[str, Any]]:
    if existing_file:
        return _artist_rows(_read_json_file(Path(existing_file)))
    request = Request(endpoint, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return _artist_rows(payload)


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


def robots_allowed(profile_url: str, user_agent: str = USER_AGENT, timeout: int = 15) -> tuple[bool, str]:
    parsed = urlsplit(profile_url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    request = Request(robots_url, headers={"User-Agent": user_agent, "Accept": "text/plain"})
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
    except (HTTPError, URLError, TimeoutError, ValueError):
        return False, "robots-unavailable"

    from urllib.robotparser import RobotFileParser

    parser = RobotFileParser()
    parser.set_url(robots_url)
    parser.parse(body.splitlines())
    allowed = parser.can_fetch(user_agent, profile_url)
    return allowed, "ok" if allowed else "robots-denied"


def _existing_handles(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        handle = first_valid_handle(row.get("handle"), row.get("instagram"))
        if handle:
            result.setdefault(handle, row)
    return result


def _existing_names(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = normalize_name(row.get("name"))
        if name:
            result.setdefault(name, row)
    return result


def collect_candidates(
    seed_urls: Iterable[str],
    existing_rows: Iterable[dict[str, Any]],
    *,
    delay_seconds: float = 2.0,
    require_keyword: bool = False,
    timeout: int = 30,
    check_robots: bool = True,
    fetcher: Any = fetch_profile,
) -> dict[str, Any]:
    existing = _existing_handles(existing_rows)
    existing_names = _existing_names(existing_rows)
    seen: set[str] = set()
    seen_names: set[str] = set()
    new_artists: list[dict[str, Any]] = []
    duplicates: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    robots_cache: dict[str, tuple[bool, str]] = {}
    urls = list(seed_urls)

    for index, seed_url in enumerate(urls):
        if index and delay_seconds > 0:
            time.sleep(delay_seconds)
        seed_handle = normalize_handle(seed_url)
        if not seed_handle:
            rejected.append({"url": seed_url, "reason": "invalid-profile-url"})
            continue
        if seed_handle in existing:
            duplicates.append({"url": seed_url, "handle": seed_handle, "reason": "already-in-artists"})
            continue
        if seed_handle in seen:
            duplicates.append({"url": seed_url, "handle": seed_handle, "reason": "duplicate-seed"})
            continue
        seen.add(seed_handle)

        if check_robots:
            host = urlsplit(seed_url).netloc.casefold()
            robots_cache.setdefault(host, robots_allowed(seed_url))
            allowed, reason = robots_cache[host]
            if not allowed:
                rejected.append({"url": seed_url, "handle": seed_handle, "reason": reason})
                continue

        try:
            try:
                artist = fetcher(seed_url, timeout=timeout)
            except TypeError:
                artist = fetcher(seed_url)
        except Exception as error:  # Keep one transient profile from aborting the batch.
            errors.append({"url": seed_url, "handle": seed_handle, "reason": clean_text(error)[:200]})
            continue

        handle = first_valid_handle(artist.get("handle"), artist.get("instagram"))
        if not handle:
            rejected.append({"url": seed_url, "handle": seed_handle, "reason": "profile-handle-missing"})
            continue
        artist["handle"] = f"@{handle}"
        artist["instagram"] = canonical_profile_url(handle)
        artist["sourcePage"] = artist["instagram"]
        if handle in existing:
            duplicates.append({"url": seed_url, "handle": handle, "reason": "already-in-artists-after-redirect"})
            continue
        name_key = normalize_name(artist.get("name"))
        if name_key and name_key in existing_names:
            duplicates.append({"url": seed_url, "handle": handle, "reason": "already-in-artists-name"})
            continue
        if any(normalize_handle(item.get("handle")) == handle for item in new_artists):
            duplicates.append({"url": seed_url, "handle": handle, "reason": "duplicate-profile-result"})
            continue
        if name_key and name_key in seen_names:
            duplicates.append({"url": seed_url, "handle": handle, "reason": "duplicate-profile-name"})
            continue
        if require_keyword and artist.get("relevance") != "keyword":
            rejected.append({"url": seed_url, "handle": handle, "reason": "no-nihonga-keyword"})
            continue
        new_artists.append(artist)
        if name_key:
            seen_names.add(name_key)

    return {
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


def push_artist(endpoint: str, artist: dict[str, Any], password: str, timeout: int = 30) -> dict[str, Any]:
    payload = {key: artist.get(key) for key in (
        "name", "romanName", "handle", "instagram", "sourcePage", "linkType",
        "region", "school", "styles", "note"
    )}
    request = Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "X-Admin-Password": password,
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return json.loads(body or "{}")
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(body or "{}")
        except ValueError:
            payload = {}
        payload.setdefault("ok", False)
        payload.setdefault("status", error.code)
        return payload


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
    parser.add_argument("--require-nihonga-keyword", action="store_true", help="Export only profiles whose public metadata contains a Nihonga keyword.")
    parser.add_argument("--push", action="store_true", help="POST newArtists to the website admin API after the report is generated.")
    parser.add_argument("--admin-password-file", help="Local file containing ADMIN_PASSWORD; required with --push.")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.limit < 1 or args.limit > 200:
        parser.error("--limit 必须在 1 到 200 之间。")
    if args.delay < 0:
        parser.error("--delay 不能小于 0。")
    if args.push and not args.admin_password_file:
        parser.error("--push 需要 --admin-password-file。")
    try:
        seed_urls, invalid = load_seed_urls(args.seed, args.seed_file)
        seed_urls = seed_urls[: args.limit]
        if not seed_urls:
            parser.error("请至少提供一个公开 Instagram 个人主页 URL 或 --seed-file。")
        existing = load_existing_artists(args.artists_api, args.existing_file, timeout=args.timeout)
        result = collect_candidates(
            seed_urls,
            existing,
            delay_seconds=args.delay,
            require_keyword=args.require_nihonga_keyword,
            timeout=args.timeout,
            check_robots=True,
        )
    except (OSError, ValueError, HTTPError, URLError) as error:
        print(f"读取输入失败: {error}", file=sys.stderr)
        return 2

    if invalid:
        result["rejected"].extend({"url": value, "reason": "invalid-seed"} for value in invalid)
        result["summary"]["rejected"] = len(result["rejected"])

    result["pushed"] = []
    result["pushErrors"] = []
    if args.push and result["newArtists"]:
        password = read_admin_password(args.admin_password_file)
        if not password:
            parser.error(f"在 {args.admin_password_file} 中没有找到管理员密码。")
        parsed_api = urlsplit(args.artists_api)
        admin_endpoint = f"{parsed_api.scheme}://{parsed_api.netloc}/api/admin-artists"
        for artist in result["newArtists"]:
            response = push_artist(admin_endpoint, artist, password, timeout=args.timeout)
            if response.get("ok"):
                result["pushed"].append({"handle": artist.get("handle"), "response": response})
            elif int(response.get("status", 0) or 0) == 409:
                result["duplicates"].append({
                    "url": artist.get("instagram", ""),
                    "handle": normalize_handle(artist.get("handle")),
                    "reason": "server-duplicate",
                })
                result["summary"]["duplicates"] += 1
            else:
                result["pushErrors"].append({
                    "url": artist.get("instagram", ""),
                    "handle": artist.get("handle", ""),
                    "reason": response.get("message", "import-failed"),
                })
        result["writeMode"] = "admin-api-post"
    result["generatedAt"] = datetime.now(timezone.utc).isoformat()
    result["source"] = "instagram-public-profile"
    if not args.push:
        result["writeMode"] = "review-only; no Supabase mutations"

    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
