#!/usr/bin/env python3
"""Turn a reviewed local Instagram list into stable Artist records and push it.

The browser audit is intentionally separate from this writer.  This module
only consumes the saved audit JSON, applies the public Artist mapping, and
uses the existing idempotent admin writer.  It never stores the admin password
in a report or log.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

try:
    from instagram_import import (
        CrawlerLogger,
        NIHONGA_KEYWORDS,
        artist_idempotency_key,
        canonical_profile_url,
        detect_school_region,
        load_push_state,
        normalize_artist_record,
        normalize_handle,
        push_artist,
        sanitize_bio,
        save_push_state,
        write_json_atomic,
    )
except ImportError:  # Support ``python -m scripts.instagram_reviewed_push``.
    from scripts.instagram_import import (  # type: ignore[no-redef]
        CrawlerLogger,
        NIHONGA_KEYWORDS,
        artist_idempotency_key,
        canonical_profile_url,
        detect_school_region,
        load_push_state,
        normalize_artist_record,
        normalize_handle,
        push_artist,
        sanitize_bio,
        save_push_state,
        write_json_atomic,
    )


NAME_OVERRIDES = {
    "a.rn____": "あんどう りん",
    "anzu_moch": "水江 杏実",
    "93.ryuto": "琉翔",
    "mako.artworks": "板垣真子",
    "326maichi": "山口 舞 / YAMAGUCHI Mai",
    "7seiseisei": "Nanase Shinjo",
    "_makifujishiro": "藤城真生",
    "akihiro6279": "NOGUCHI",
    "j_art_koizumi": "小泉咲姫 / Koizumi Saki",
    "anju_oekaki": "あんじゅ",
    "aya.kmd9": "伊東彩那",
    "ayayayaue": "Ayane Ueki",
    "gyakuto910": "山口岳人",
    "hikaaa.52_art": "HIKARU",
    "hong_xujie": "Hong Xujie",
    "hsmoyrjp": "ほしもゆる / Hoshi Moyuru",
    "irie.aika": "いりえあいか",
    "irisa1429": "谷井 里咲 / Risa Tanii",
    "iwahashiyusaku6": "岩橋優作",
    "kita.yoshihiro_official": "喜多祥泰 / Yoshihiro Kita",
    "masataka_hr": "masataka_hr",
    "miri_00110": "みりな",
    "nakano_takafumi": "中野貴文",
    "sartakaki": "高木沙羅",
    "shulinli_art": "LI SHULIN / 李姝霖",
    "surplustokyo": "堀明日佳 / Asuka Hori",
    "taro.jpart": "安井孝汰郎",
    "yutttttpp": "麻田夕潤",
    "teitei_art": "Tei",
    "2k_lll5": "フジイ ユウナ",
    "72h0_n": "野亦夏帆",
    "__doouseii.w626": "TONGJING WANG",
    "_oh_7525": "ナナコ",
    "akkklh": "赤津昂步 / Akatsu Akiho",
    "chou_chouyou": "chou_chouyou",
    "hayata_nakae": "hayata_nakae",
    "kagamisekai_": "鏡世界",
    "kaiii.cn": "kaiii.cn",
    "lunachouo": "趙 静潔 / チョウ セイケツ",
    "rin_makino": "rin_makino",
    "satokominamitani": "satokominamitani",
    "1373hong": "1373hong",
}

SCHOOL_OVERRIDES = {
    "mako.artworks": "尾道市立大学",
    "7seiseisei": "広島市立大学",
    "hikaaa.52_art": "広島市立大学",
    "hong_xujie": "武蔵野美術大学",
    "hsmoyrjp": "多摩美術大学",
    "k_i_e_6_2": "愛知県立芸術大学",
    "kita.yoshihiro_official": "",
    "riyokii": "京都芸術大学",
    "shulinli_art": "名古屋芸術大学",
    "syuinnjyo_": "京都芸術大学",
    "2k_lll5": "東京藝術大学",
    "72h0_n": "東京藝術大学",
    "_oh_7525": "東京藝術大学",
    "akkklh": "東京藝術大学",
    "chou_chouyou": "女子美術大学",
    "hayata_nakae": "東京藝術大学",
    "kaiii.cn": "東京藝術大学",
    "lunachouo": "多摩美術大学",
    "rin_makino": "女子美術大学",
}

REGION_OVERRIDES = {
    "mako.artworks": "広島",
    "7seiseisei": "広島",
    "hikaaa.52_art": "広島",
    "hong_xujie": "東京",
    "hsmoyrjp": "東京",
    "k_i_e_6_2": "愛知",
    "ko_shimomura": "鹿児島",
    "riyokii": "京都",
    "shulinli_art": "愛知",
    "syuinnjyo_": "京都",
    "2k_lll5": "東京",
    "72h0_n": "東京",
    "_oh_7525": "東京",
    "akkklh": "東京",
    "chou_chouyou": "東京",
    "hayata_nakae": "東京",
    "kaiii.cn": "東京",
    "lunachouo": "東京",
    "rin_makino": "東京",
}


def _read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _audit_rows(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, Mapping):
        return []
    result: list[dict[str, Any]] = []
    for bucket in ("highConfidence", "review"):
        rows = payload.get(bucket)
        if isinstance(rows, list):
            result.extend(row for row in rows if isinstance(row, Mapping))
    return result


def _load_approved_handles(path: str | Path) -> set[str]:
    values = Path(path).read_text(encoding="utf-8-sig").splitlines()
    return {handle for handle in (normalize_handle(value) for value in values) if handle}


def _styles_from_bio(bio: str) -> list[str]:
    styles = ["日本画"]
    hints = (
        ("岩彩", r"岩絵具|岩絵の具|膠彩|岩彩|mineral pigment|gofun"),
        ("膠彩画", r"膠彩"),
        ("水彩画", r"水彩"),
        ("墨", r"墨"),
        ("鉛筆", r"鉛筆"),
        ("アクリル", r"アクリル"),
        ("イラスト", r"イラスト|illustrator"),
    )
    for label, pattern in hints:
        if re.search(pattern, bio, re.IGNORECASE):
            styles.append(label)
    return styles


def _keyword_hits(bio: str) -> list[str]:
    return [keyword for keyword in NIHONGA_KEYWORDS if keyword.casefold() in bio.casefold()]


def build_artist(row: Mapping[str, Any]) -> dict[str, Any]:
    handle = normalize_handle(row.get("handle"))
    if not handle:
        raise ValueError("审核记录缺少有效 Instagram handle")
    bio = sanitize_bio(row.get("publicBio") or row.get("bio"))
    school, region = detect_school_region(bio)
    school = SCHOOL_OVERRIDES.get(handle, school)
    region = REGION_OVERRIDES.get(handle, region)
    artist = normalize_artist_record(
        {
            "name": NAME_OVERRIDES.get(handle, handle),
            "handle": f"@{handle}",
            "instagram": canonical_profile_url(handle),
            "sourcePage": canonical_profile_url(handle),
            "linkType": "instagram",
            "region": region,
            "school": school,
            "styles": _styles_from_bio(bio),
            "note": f"Instagram 公开简介：{bio}" if bio else "Instagram 公开资料，待人工补充。",
            "relevance": "keyword",
            "keywordHits": _keyword_hits(bio),
            "sources": [
                {
                    "provider": "instagram",
                    "username": handle,
                    "url": canonical_profile_url(handle),
                }
            ],
        }
    )
    artist["reviewBucket"] = str(row.get("bucket") or "review")
    artist["reviewScore"] = int(row.get("score") or 0)
    return artist


def build_report(audit_file: str | Path, approved_file: str | Path) -> dict[str, Any]:
    approved = _load_approved_handles(approved_file)
    rows = _audit_rows(_read_json(audit_file))
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    excluded: list[dict[str, str]] = []
    for row in rows:
        handle = normalize_handle(row.get("handle"))
        if not handle or handle not in approved:
            continue
        if handle in seen:
            excluded.append({"handle": handle, "reason": "duplicate-review-row"})
            continue
        seen.add(handle)
        selected.append(build_artist(row))
    return {
        "source": "instagram-following-reviewed-20260901",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "writeMode": "review-only until --push; admin writes use idempotency keys",
        "summary": {"approved": len(selected), "duplicateReviewRows": len(excluded)},
        "newArtists": selected,
        "reviewDuplicates": excluded,
    }


def _push_report(
    report: dict[str, Any],
    *,
    endpoint: str,
    password_file: str | Path,
    state_file: str | Path,
    log_file: str | Path,
    retry_attempts: int,
    retry_backoff: float,
) -> None:
    # Import lazily to keep review-only runs free of credential-file access.
    try:
        from instagram_import import read_admin_password
    except ImportError:
        from scripts.instagram_import import read_admin_password  # type: ignore[no-redef]

    password = read_admin_password(str(password_file))
    if not password:
        raise ValueError("管理员密码文件为空")
    logger = CrawlerLogger(log_file)
    state = load_push_state(state_file)
    records = state.setdefault("records", {})
    pushed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for artist in report["newArtists"]:
        key = artist_idempotency_key(artist)
        previous = records.get(key)
        if isinstance(previous, Mapping) and previous.get("status") in {"pushed", "duplicate"}:
            skipped.append({"handle": artist["handle"], "idempotencyKey": key, "reason": "already-processed"})
            logger.event("write-skipped", handle=artist["handle"], idempotencyKey=key, reason="already-processed")
            continue
        response = push_artist(
            endpoint,
            artist,
            password,
            retry_attempts=retry_attempts,
            retry_backoff_seconds=retry_backoff,
            logger=logger,
        )
        if response.get("ok"):
            pushed.append({"handle": artist["handle"], "idempotencyKey": key, "response": response})
            records[key] = {"status": "pushed", "updatedAt": datetime.now(timezone.utc).isoformat(), "handle": artist["handle"]}
        elif int(response.get("status", 0) or 0) == 409:
            duplicates.append({"handle": artist["handle"], "idempotencyKey": key, "reason": "server-duplicate"})
            records[key] = {"status": "duplicate", "updatedAt": datetime.now(timezone.utc).isoformat(), "handle": artist["handle"]}
        else:
            errors.append({"handle": artist["handle"], "idempotencyKey": key, "reason": response.get("message", "import-failed")})
            records[key] = {"status": "error", "updatedAt": datetime.now(timezone.utc).isoformat(), "handle": artist["handle"], "reason": response.get("message", "import-failed")}
        save_push_state(state_file, state)
    report["writeMode"] = "admin-api-post"
    report["runId"] = logger.run_id
    report["logFile"] = str(log_file)
    report["pushed"] = pushed
    report["skipped"] = skipped
    report["duplicates"] = duplicates
    report["pushErrors"] = errors
    report["pushSummary"] = {
        "pushed": len(pushed),
        "skipped": len(skipped),
        "duplicates": len(duplicates),
        "errors": len(errors),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Push a reviewed Instagram artist list with stable identities.")
    parser.add_argument("--audit-file", required=True)
    parser.add_argument("--approved-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--artists-api", default="https://nihonga-online-deploy.vercel.app/api/admin-artists")
    parser.add_argument("--push", action="store_true")
    parser.add_argument("--admin-password-file")
    parser.add_argument("--state-file", default="imports/instagram-reviewed-push-state.json")
    parser.add_argument("--log-file", default="imports/instagram-reviewed-push.jsonl")
    parser.add_argument("--retry-attempts", type=int, default=3)
    parser.add_argument("--retry-backoff", type=float, default=1.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report = build_report(args.audit_file, args.approved_file)
    if args.push:
        if not args.admin_password_file:
            raise SystemExit("--push 需要 --admin-password-file")
        _push_report(
            report,
            endpoint=args.artists_api,
            password_file=args.admin_password_file,
            state_file=args.state_file,
            log_file=args.log_file,
            retry_attempts=max(1, args.retry_attempts),
            retry_backoff=max(0.0, args.retry_backoff),
        )
    write_json_atomic(args.out, report)
    print(json.dumps({"out": args.out, "summary": report["summary"], "pushSummary": report.get("pushSummary")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
