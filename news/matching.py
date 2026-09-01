"""Conservative matching of AI-extracted artist names to existing artists."""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable, Mapping


def normalize_artist_name(value: Any) -> str:
    """Normalize punctuation/case while retaining Japanese characters."""

    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    text = re.sub(r"[\(（][^\)）]*[\)）]", "", text)
    text = re.sub(r"[\s\u3000·・.,，、:：;；/／\\_|_\-‐‑–—]+", "", text)
    text = re.sub(r"(?:氏|先生|画伯)$", "", text)
    return text.strip()


def _values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [item.strip() for item in re.split(r"[,，、;；/／\n]", value) if item.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def artist_keys(artist: Mapping[str, Any]) -> set[str]:
    values: list[str] = []
    for key in ("name", "japanese_name", "japaneseName", "roman_name", "romanName", "aliases", "alias"):
        values.extend(_values(artist.get(key)))
    return {normalized for value in values if (normalized := normalize_artist_name(value))}


def match_artists(
    artist_names: Iterable[Any],
    artists: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Return only unambiguous exact normalized matches.

    Similarity/fuzzy matching is deliberately excluded; a false artist link is
    more damaging than retaining an unmatched extracted name for later review.
    """

    index: dict[str, list[Mapping[str, Any]]] = {}
    for artist in artists:
        if not isinstance(artist, Mapping):
            continue
        for key in artist_keys(artist):
            index.setdefault(key, []).append(artist)
    matched: list[dict[str, Any]] = []
    unmatched: list[str] = []
    ambiguous: list[str] = []
    seen_ids: set[str] = set()
    for value in artist_names or ():
        display = str(value or "").strip()
        key = normalize_artist_name(display)
        if not display or not key:
            continue
        candidates = index.get(key, [])
        unique = {str(item.get("id")): item for item in candidates if item.get("id") is not None}
        if len(unique) != 1:
            if len(unique) > 1:
                ambiguous.append(display)
            else:
                unmatched.append(display)
            continue
        artist = next(iter(unique.values()))
        artist_id = str(artist["id"])
        if artist_id in seen_ids:
            continue
        seen_ids.add(artist_id)
        matched.append({"id": artist["id"], "name": artist.get("name", ""), "source_name": display})
    return {"matched": matched, "unmatched": unmatched, "ambiguous": ambiguous}


__all__ = ["artist_keys", "match_artists", "normalize_artist_name"]
