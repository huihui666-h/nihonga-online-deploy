"""Configurable trusted sources for Nihonga News.

Sources are data, not crawler code.  Add a source by editing ``sources.json``
or by passing a JSON file to ``scripts/news_crawler.py --config``.  A source
only needs a listing URL; the generic HTML/RSS parser handles the common
official-site structures.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit


DEFAULT_KEYWORDS = (
    "日本画",
    "日本絵画",
    "日本画家",
    "展覧会",
    "展覧",
    "企画展",
    "公募",
    "作品募集",
    "美術館",
    "日本美術院",
    "日展",
    "nihonga",
)


@dataclass(frozen=True)
class NewsSource:
    """A trusted source endpoint and its extraction hints."""

    key: str
    name: str
    url: str
    kind: str = "html"
    allowed_domains: tuple[str, ...] = field(default_factory=tuple)
    keywords: tuple[str, ...] = DEFAULT_KEYWORDS
    max_items: int = 30
    allow_images: bool = False
    fetch_details: bool = True
    link_prefixes: tuple[str, ...] = field(default_factory=tuple)
    trusted_for_auto_publish: bool = False

    def __post_init__(self) -> None:
        key = str(self.key).strip()
        name = str(self.name).strip()
        url = str(self.url).strip()
        if not key or not name:
            raise ValueError("news source key and name are required")
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"source URL must be absolute HTTP(S): {url}")
        kind = str(self.kind).lower().strip() or "html"
        if kind not in {"html", "rss", "atom", "auto"}:
            raise ValueError(f"unsupported source kind: {kind}")
        domains = tuple(_normalize_domain(value) for value in self.allowed_domains if _normalize_domain(value))
        if not domains:
            domains = (_normalize_domain(parsed.hostname or ""),)
        try:
            max_items = max(1, min(200, int(self.max_items)))
        except (TypeError, ValueError):
            max_items = 30
        object.__setattr__(self, "key", key)
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "url", url)
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "allowed_domains", domains)
        object.__setattr__(self, "keywords", tuple(str(item).strip() for item in self.keywords if str(item).strip()))
        object.__setattr__(self, "max_items", max_items)
        object.__setattr__(self, "allow_images", bool(self.allow_images))
        object.__setattr__(self, "fetch_details", bool(self.fetch_details))
        object.__setattr__(self, "link_prefixes", tuple(str(item).strip() for item in self.link_prefixes if str(item).strip()))
        object.__setattr__(self, "trusted_for_auto_publish", self.trusted_for_auto_publish is True)

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "url": self.url,
            "kind": self.kind,
            "allowed_domains": list(self.allowed_domains),
            "keywords": list(self.keywords),
            "max_items": self.max_items,
            "allow_images": self.allow_images,
            "fetch_details": self.fetch_details,
            "link_prefixes": list(self.link_prefixes),
            "trusted_for_auto_publish": self.trusted_for_auto_publish,
        }


def _normalize_domain(value: Any) -> str:
    text = str(value or "").strip().lower()
    if "://" in text:
        text = urlsplit(text).hostname or ""
    text = text.split("/", 1)[0].split(":", 1)[0].strip().strip(".")
    return text


def _source_from_mapping(value: Mapping[str, Any], index: int) -> NewsSource:
    url = str(value.get("url") or value.get("listing_url") or "").strip()
    parsed = urlsplit(url)
    key = str(value.get("key") or value.get("id") or f"source-{index + 1}").strip()
    name = str(value.get("name") or value.get("source_name") or key).strip()
    domains = value.get("allowed_domains", value.get("allowedDomains", ()))
    if isinstance(domains, str):
        domains = [domains]
    keywords = value.get("keywords", DEFAULT_KEYWORDS)
    if isinstance(keywords, str):
        keywords = re.split(r"[,，、\n]", keywords)
    prefixes = value.get("link_prefixes", value.get("linkPrefixes", ()))
    if isinstance(prefixes, str):
        prefixes = [prefixes]
    return NewsSource(
        key=key,
        name=name,
        url=url,
        kind=str(value.get("kind", "auto")),
        allowed_domains=tuple(domains or (parsed.hostname or "",)),
        keywords=tuple(keywords or DEFAULT_KEYWORDS),
        max_items=value.get("max_items", value.get("maxItems", 30)),
        allow_images=bool(value.get("allow_images", value.get("allowImages", False))),
        fetch_details=bool(value.get("fetch_details", value.get("fetchDetails", True))),
        link_prefixes=tuple(prefixes or ()),
        trusted_for_auto_publish=value.get("trusted_for_auto_publish", value.get("trustedForAutoPublish", False)) is True,
    )


def default_sources() -> list[NewsSource]:
    """Return the first-party source set used when no config is supplied."""

    return [
        NewsSource(
            key="nihon-bijutsuin-exhibitions",
            name="日本美術院",
            url="https://nihonbijutsuin.or.jp/exhibitions_list.php",
            kind="auto",
            keywords=("日本画", "日本美術院", "院展", "春の院展", "再興"),
            link_prefixes=("/exhibitions_detail.php",),
            trusted_for_auto_publish=True,
        ),
        NewsSource(
            key="nihon-bijutsuin-news",
            name="日本美術院",
            url="https://nihonbijutsuin.or.jp/news_list.php",
            kind="auto",
            link_prefixes=("/news_detail.php",),
            trusted_for_auto_publish=True,
        ),
        NewsSource(
            key="nitten-events",
            name="日展",
            url="https://nitten.or.jp/event/",
            kind="auto",
            link_prefixes=("/event/event-",),
            trusted_for_auto_publish=True,
        ),
        NewsSource(
            key="nitten-news",
            name="日展",
            url="https://nitten.or.jp/news/",
            kind="auto",
            link_prefixes=("/news/news-",),
            trusted_for_auto_publish=True,
        ),
        NewsSource(
            key="yamatane-exhibitions",
            name="山種美術館",
            url="https://www.yamatane-museum.jp/exhibitions/schedule.html",
            kind="auto",
            keywords=(),
            link_prefixes=("/exhibitions/2026/", "/exhibitions/2027/"),
            trusted_for_auto_publish=True,
        ),
    ]


def load_sources(path: str | Path | None = None) -> list[NewsSource]:
    """Load source definitions from JSON, falling back to trusted defaults.

    The accepted file shape is either ``[{...}]`` or ``{"sources": [{...}]}``.
    Invalid individual entries are skipped so one typo cannot disable every
    source.  An empty or invalid file falls back to the built-in list.
    """

    if path is None:
        path = Path(__file__).with_name("sources.json")
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        values: Iterable[Any] = raw.get("sources", []) if isinstance(raw, Mapping) else raw
        if not isinstance(values, list):
            raise ValueError("sources must be a list")
        result: list[NewsSource] = []
        seen: set[str] = set()
        for index, value in enumerate(values):
            if not isinstance(value, Mapping):
                continue
            try:
                source = _source_from_mapping(value, index)
            except (TypeError, ValueError):
                continue
            if source.key in seen:
                continue
            seen.add(source.key)
            result.append(source)
        if result:
            return result
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return default_sources()


__all__ = ["NewsSource", "default_sources", "load_sources"]
