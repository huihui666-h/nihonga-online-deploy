#!/usr/bin/env python3
"""Build a read-only Nihonga candidate report from local Instagram exports.

This script never opens Instagram and never calls the website API. It combines:

* an Instagram following export (or a locally saved browser list),
* a snapshot of the site's existing artists, and
* optional locally saved public profile metadata.

The result is an audit JSON split into high-confidence, review, excluded, and
missing-metadata buckets. Nothing in the report is written to the website.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    # Works when executed as ``python scripts/...py``.
    from instagram_import import (
        _FallbackHTMLParser,
        canonical_profile_url,
        clean_text,
        normalize_handle,
        sanitize_bio,
        write_json_atomic,
    )
except ImportError:  # Also support ``python -m scripts.instagram_following_report``.
    from scripts.instagram_import import (  # type: ignore[no-redef]
        _FallbackHTMLParser,
        canonical_profile_url,
        clean_text,
        normalize_handle,
        sanitize_bio,
        write_json_atomic,
    )


STRONG_RULES = (
    ("日本画家", re.compile(r"日本画家", re.IGNORECASE), 7),
    ("日本画制作", re.compile(r"日本画(?:を)?(?:制作|描いて|描く)", re.IGNORECASE), 6),
    ("日本画専攻", re.compile(r"日本画(?:専攻|科|研究領域|コース)", re.IGNORECASE), 6),
    ("nihonga artist", re.compile(r"\bnihonga\s+(?:artist|painter)\b", re.IGNORECASE), 7),
    (
        "Japanese painting artist",
        re.compile(r"\bjapanese(?:-style)?\s+(?:painting\s+)?(?:artist|painter)\b", re.IGNORECASE),
        6,
    ),
    ("日本画专业", re.compile(r"日本画(?:专业|專業|系)", re.IGNORECASE), 6),
)

NIHONGA_RULES = (
    ("日本画", re.compile(r"日本画", re.IGNORECASE), 4),
    ("nihonga", re.compile(r"\bnihonga\b", re.IGNORECASE), 4),
    ("Japanese painting", re.compile(r"\bjapanese\s+painting\b", re.IGNORECASE), 4),
    ("岩彩", re.compile(r"岩彩", re.IGNORECASE), 3),
    ("岩絵具", re.compile(r"岩絵(?:具|の具)", re.IGNORECASE), 3),
    ("mineral pigments", re.compile(r"\bmineral\s+pigments?\b", re.IGNORECASE), 3),
    ("gofun", re.compile(r"(?:胡粉|\bgofun\b)", re.IGNORECASE), 2),
    ("nikawa", re.compile(r"(?:膠|\bnikawa\b)", re.IGNORECASE), 2),
    ("iwa-enogu", re.compile(r"\biwa[ -]?enogu\b", re.IGNORECASE), 3),
    ("矿物颜料", re.compile(r"(?:矿物颜料|礦物顏料)", re.IGNORECASE), 3),
)

ARTIST_RULES = (
    ("画家", re.compile(r"(?:画家|畫家)", re.IGNORECASE), 2),
    ("artist", re.compile(r"\bartist\b", re.IGNORECASE), 2),
    ("painter", re.compile(r"\bpainter\b", re.IGNORECASE), 2),
    ("作品制作", re.compile(r"(?:作品|制作|創作|works?)", re.IGNORECASE), 1),
)

# Institution signals are evaluated against the account identity (handle and
# display name) first. A painter may legitimately mention a university or
# materials in their bio, so those words alone must not exclude the profile.
IDENTITY_INSTITUTION_RULES = (
    ("学校/研究室", re.compile(r"(?:大学|大學|研究室|学科|學科|department|専攻\s*[【(（]?公式)", re.IGNORECASE)),
    ("美术馆/画廊", re.compile(r"(?:美術館|美术馆|museum|画廊|gallery)", re.IGNORECASE)),
    ("材料商", re.compile(r"(?:材料|絵具|画材|畫材|art\s+supply|shop|store|株式会社|\(株\))", re.IGNORECASE)),
    ("展览/媒体", re.compile(r"(?:作品展|卒業展|修了展|展覧会|triennale|magazine|月刊|新聞)", re.IGNORECASE)),
)

ASPIRANT_RULES = (
    ("备考/志望", re.compile(r"(?:志望|受験|受验|备考|備考|予備校|受験生)", re.IGNORECASE)),
)


def _read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _normalize_name(value: Any) -> str:
    text = unicodedata.normalize("NFKC", clean_text(value)).casefold()
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE)


def _first_handle(row: dict[str, Any]) -> str:
    for key in ("handle", "username", "instagram", "url", "href", "value"):
        handle = normalize_handle(row.get(key))
        if handle:
            return handle
    return ""


def _iter_following_rows(payload: Any) -> Iterable[dict[str, Any]]:
    if isinstance(payload, list):
        for row in payload:
            yield from _iter_following_rows(row)
        return
    if not isinstance(payload, dict):
        return

    if _first_handle(payload):
        yield payload

    # Browser discovery snapshots use ``profiles`` while Instagram account
    # exports use ``following``. Both are candidate sources and should share
    # the same normalization and duplicate filters.
    for key in ("following", "relationships_following", "profiles", "candidates"):
        value = payload.get(key)
        if value is not None:
            yield from _iter_following_rows(value)

    for item in payload.get("string_list_data", []) or []:
        if isinstance(item, dict):
            merged = dict(item)
            merged.setdefault("display", payload.get("title", ""))
            yield merged


def load_following(path: str | Path) -> list[dict[str, str]]:
    source = Path(path)
    suffix = source.suffix.casefold()
    if suffix in {".txt", ".list"}:
        rows = ({"handle": line.strip(), "name": ""} for line in source.read_text(encoding="utf-8-sig").splitlines())
    elif suffix == ".csv":
        with source.open("r", encoding="utf-8-sig", newline="") as handle:
            rows = (
                {
                    "handle": row.get("handle") or row.get("username") or row.get("instagram") or row.get("url") or "",
                    "name": row.get("display") or row.get("displayName") or row.get("name") or row.get("title") or "",
                }
                for row in csv.DictReader(handle)
            )
    elif suffix in {".html", ".htm"}:
        parser = _FallbackHTMLParser()
        parser.feed(source.read_text(encoding="utf-8-sig"))
        rows = ({"handle": href, "name": ""} for href in parser.links)
    else:
        payload = _read_json(source)
        rows = _iter_following_rows(payload)

    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        handle = _first_handle(row)
        if not handle or handle in seen:
            continue
        seen.add(handle)
        result.append({
            "handle": handle,
            "name": clean_text(row.get("display") or row.get("displayName") or row.get("title") or row.get("name")),
        })
    return result


def load_existing(path: str | Path) -> tuple[set[str], set[str]]:
    payload = _read_json(path)
    rows = payload.get("artists", []) if isinstance(payload, dict) else payload
    handles: set[str] = set()
    names: set[str] = set()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        handle = _first_handle(row)
        name = _normalize_name(row.get("name"))
        if handle:
            handles.add(handle)
        if name:
            names.add(name)
    return handles, names


def _iter_metadata_rows(payload: Any, bucket: str = "") -> Iterable[tuple[dict[str, Any], str]]:
    if isinstance(payload, list):
        for row in payload:
            if isinstance(row, dict):
                yield row, bucket
        return
    if not isinstance(payload, dict):
        return
    for key in ("newArtists", "highConfidence", "review", "excluded", "profiles", "artists"):
        value = payload.get(key)
        if isinstance(value, list):
            for row in value:
                if isinstance(row, dict):
                    yield row, key


def load_metadata(paths: Iterable[str | Path]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for path in paths:
        for row, bucket in _iter_metadata_rows(_read_json(path)):
            handle = _first_handle(row)
            if not handle:
                continue
            target = result.setdefault(handle, {})
            for key in ("name", "display", "displayName", "publicBio", "bio", "note", "reason", "keywordHits", "followingStatus"):
                value = row.get(key)
                if value not in (None, "", []):
                    target[key] = value
            target["sourceBucket"] = bucket
    return result


def _bio_from_metadata(row: dict[str, Any]) -> str:
    bio = clean_text(row.get("publicBio") or row.get("bio"))
    if bio:
        return sanitize_bio(bio)
    note = clean_text(row.get("note"))
    return sanitize_bio(re.sub(r"^Instagram\s*公开简介\s*[:：]\s*", "", note, flags=re.IGNORECASE))


def _rule_hits(text: str, rules: Iterable[tuple[str, re.Pattern[str], int]]) -> tuple[list[str], int]:
    hits: list[str] = []
    score = 0
    for label, pattern, weight in rules:
        if pattern.search(text):
            hits.append(label)
            score += weight
    return hits, score


def classify_profile(profile: dict[str, Any]) -> dict[str, Any]:
    handle = normalize_handle(profile.get("handle"))
    name = clean_text(profile.get("name") or profile.get("display") or profile.get("displayName"))
    bio = _bio_from_metadata(profile)
    searchable = " ".join(part for part in (handle, name, bio) if part)

    aspirant_hits = [label for label, pattern in ASPIRANT_RULES if pattern.search(searchable)]
    strong_hits, strong_score = _rule_hits(searchable, STRONG_RULES)
    nihonga_hits, nihonga_score = _rule_hits(searchable, NIHONGA_RULES)
    artist_hits, artist_score = _rule_hits(searchable, ARTIST_RULES)

    identity_text = " ".join(part for part in (handle, name) if part)
    identity_institution_hits = [
        label for label, pattern in IDENTITY_INSTITUTION_RULES if pattern.search(identity_text)
    ]
    # A handle containing "nihonga" is useful discovery evidence, but is not
    # enough by itself to call an account an artist.
    handle_signal = 3 if "nihonga" in handle else 0
    score = strong_score + nihonga_score + artist_score + handle_signal
    evidence = list(dict.fromkeys(strong_hits + nihonga_hits + artist_hits + (["handle:nihonga"] if handle_signal else [])))

    # Bio text like "日本画研究室助手" can describe an individual artist's
    # role. Only signals in the account identity itself identify organizations.
    if identity_institution_hits:
        bucket = "excluded"
        reason = "机构/学校/画廊/材料商/展览账号"
    elif aspirant_hits:
        bucket = "review"
        reason = "包含备考或志望信息，需要确认是否已作为画家公开活动"
    elif strong_hits and score >= 6:
        bucket = "highConfidence"
        reason = "公开资料明确写有日本画身份或专业"
    elif score >= 5 and nihonga_hits and artist_hits:
        bucket = "highConfidence"
        reason = "日本画材料/技法与画家身份同时命中"
    elif score >= 3:
        bucket = "review"
        reason = "存在日本画相关信号，但证据不足以自动确认"
    elif not bio:
        bucket = "missingMetadata"
        reason = "关注列表不含个人简介，需要本地补充公开简介后重跑"
    else:
        bucket = "unclassified"
        reason = "现有公开资料未命中日本画证据"

    result = {
        "handle": f"@{handle}",
        "name": name or f"@{handle}",
        "instagram": canonical_profile_url(handle),
        "publicBio": bio,
        "bucket": bucket,
        "score": score,
        "evidence": evidence,
        "reason": reason,
    }
    if profile.get("followingStatus"):
        result["followingStatus"] = clean_text(profile.get("followingStatus"))
    return result


def build_report(
    following: Iterable[dict[str, str]],
    existing_handles: set[str],
    existing_names: set[str],
    metadata: dict[str, dict[str, Any]],
    *,
    source: str = "local-instagram-following-audit",
) -> dict[str, Any]:
    buckets: dict[str, list[dict[str, Any]]] = {
        "highConfidence": [],
        "review": [],
        "excluded": [],
        "missingMetadata": [],
        "unclassified": [],
    }
    duplicates: list[dict[str, str]] = []
    rows = list(following)

    for row in rows:
        handle = normalize_handle(row.get("handle"))
        merged: dict[str, Any] = dict(row)
        merged.update(metadata.get(handle, {}))
        name = clean_text(merged.get("name") or merged.get("display") or merged.get("displayName"))
        if handle in existing_handles:
            duplicates.append({"handle": f"@{handle}", "name": name, "reason": "existing-handle"})
            continue
        name_key = _normalize_name(name)
        if name_key and name_key in existing_names:
            duplicates.append({"handle": f"@{handle}", "name": name, "reason": "existing-name"})
            continue
        classified = classify_profile(merged)
        buckets[classified.pop("bucket")].append(classified)

    for values in buckets.values():
        values.sort(key=lambda item: (-int(item.get("score", 0)), item.get("handle", "")))

    return {
        "source": clean_text(source) or "local-instagram-candidate-audit",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "writeMode": "local-review-only; no network and no website mutations",
        "summary": {
            "following": len(rows),
            "duplicates": len(duplicates),
            "highConfidence": len(buckets["highConfidence"]),
            "review": len(buckets["review"]),
            "excluded": len(buckets["excluded"]),
            "missingMetadata": len(buckets["missingMetadata"]),
            "unclassified": len(buckets["unclassified"]),
        },
        **buckets,
        "duplicates": duplicates,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit a local Instagram following export for Nihonga candidates.")
    parser.add_argument("--following-file", required=True, help="Local following JSON exported by Instagram or the browser collector.")
    parser.add_argument("--existing-file", required=True, help="Local /api/artists JSON snapshot used for duplicate filtering.")
    parser.add_argument("--metadata-file", action="append", default=[], help="Optional local JSON containing saved public bios. Repeatable.")
    parser.add_argument("--out", default="imports/instagram-following-audit.json", help="Local review report path.")
    parser.add_argument("--source-label", default="local-instagram-following-audit", help="Label for the local candidate source in the output report.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    following = load_following(args.following_file)
    existing_handles, existing_names = load_existing(args.existing_file)
    metadata = load_metadata(args.metadata_file)
    report = build_report(
        following,
        existing_handles,
        existing_names,
        metadata,
        source=args.source_label,
    )
    output = Path(args.out)
    write_json_atomic(output, report)
    summary = report["summary"]
    print(f"已生成本地审核报告: {output}")
    print(
        "关注 {following} | 已收录 {duplicates} | 高可信 {highConfidence} | "
        "待核对 {review} | 机构排除 {excluded} | 缺少简介 {missingMetadata} | 未分类 {unclassified}".format(**summary)
    )
    print("未访问 Instagram，未调用网站写入接口。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
