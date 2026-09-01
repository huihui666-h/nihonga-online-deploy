#!/usr/bin/env python3
"""Discover Nihonga students from public university pages.

This crawler is deliberately independent of Instagram.  It reads bounded,
configured university pages, extracts publicly listed students from exhibition
or course text, and maps each person to the same normalized Artist shape.  A
school-only candidate has a stable university source identity but no fake
Instagram handle; it remains review-only until a public profile is matched.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

try:
    from instagram_import import (
        CrawlerLogger,
        DEFAULT_RETRY_ATTEMPTS,
        DEFAULT_RETRY_BACKOFF,
        USER_AGENT,
        artist_identity_keys,
        canonical_external_url,
        canonical_profile_url,
        load_existing_artists,
        normalize_artist_record,
        normalize_name,
        normalize_handle,
        push_artist,
        read_admin_password,
        retry_call,
        robots_allowed,
        sanitize_bio,
        save_push_state,
        load_push_state,
        write_json_atomic,
    )
except ImportError:  # Support ``python -m scripts.school_crawler``.
    from scripts.instagram_import import (  # type: ignore[no-redef]
        CrawlerLogger,
        DEFAULT_RETRY_ATTEMPTS,
        DEFAULT_RETRY_BACKOFF,
        USER_AGENT,
        artist_identity_keys,
        canonical_external_url,
        canonical_profile_url,
        load_existing_artists,
        normalize_artist_record,
        normalize_name,
        normalize_handle,
        push_artist,
        read_admin_password,
        retry_call,
        robots_allowed,
        sanitize_bio,
        save_push_state,
        load_push_state,
        write_json_atomic,
    )


@dataclass(frozen=True)
class SchoolSource:
    school: str
    region: str
    url: str
    label: str
    provider: str = "university"
    include_alumni: bool = False
    include_faculty: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "school": self.school,
            "region": self.region,
            "url": self.url,
            "label": self.label,
            "provider": self.provider,
            "includeAlumni": self.include_alumni,
            "includeFaculty": self.include_faculty,
        }


DEFAULT_SOURCES = (
    SchoolSource(
        school="文星芸術大学",
        region="栃木",
        url="https://geidai.bunsei.ac.jp/topics/260822-2/",
        label="屏風絵展 文星芸術大学日本画有志",
    ),
)

DEGREE_RE = re.compile(
    r"(?:博士後期課程|博士前期課程|学部)\s*(?P<year>[0-9０-９]+年)?|(?P<research>研究生)",
    re.IGNORECASE,
)
SECTION_START_RE = re.compile(r"◇\s*(?:学生|在学生)\b")
SECTION_END_RE = re.compile(r"◇\s*(?:教員|卒業生|関連リンク|会場|文星芸術大学 教授)\b")
FACULTY_SECTION_RE = re.compile(r"◇\s*教員\b")
FACULTY_END_RE = re.compile(r"◇\s*(?:卒業生|関連リンク|会場)\b")
FACULTY_ROLE_RE = re.compile(r"(?P<role>客員教授|名誉教授|非常勤講師|准教授|教授|助教|講師|助手)\s*")
NOISE_RE = re.compile(r"(?:さん|氏)$")


class _VisibleTextParser(HTMLParser):
    """Capture visible text blocks and links without executing page content."""

    BLOCK_TAGS = {
        "address", "article", "br", "dd", "div", "dt", "h1", "h2", "h3",
        "h4", "li", "p", "section", "td", "th", "tr", "ul", "ol",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.links: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_name = tag.casefold()
        if tag_name in {"script", "style", "noscript", "template"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        attrs_map = {key.casefold(): value or "" for key, value in attrs}
        href = attrs_map.get("href")
        if href:
            self.links.append(href)
        if tag_name in self.BLOCK_TAGS:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.casefold()
        if tag_name in {"script", "style", "noscript", "template"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if not self._skip_depth and tag_name in self.BLOCK_TAGS:
            self.parts.append(" ")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self.parts.append(data)


def _clean_visible_text(raw_html: str) -> str:
    parser = _VisibleTextParser()
    parser.feed(raw_html)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def _source_from_mapping(value: Mapping[str, Any]) -> SchoolSource:
    url = canonical_external_url(value.get("url") or value.get("sourcePage"))
    if not url:
        raise ValueError("学校来源缺少有效 http(s) URL")
    school = str(value.get("school") or "").strip()
    if not school:
        raise ValueError("学校来源缺少 school")
    return SchoolSource(
        school=school,
        region=str(value.get("region") or "").strip(),
        url=url,
        label=str(value.get("label") or school).strip(),
        provider=str(value.get("provider") or "university").strip() or "university",
        include_alumni=bool(value.get("includeAlumni")),
        include_faculty=value.get("includeFaculty", True) is not False,
    )


def load_sources(path: str | Path | None, source_name: str | None = None) -> list[SchoolSource]:
    if not path:
        sources = list(DEFAULT_SOURCES)
    else:
        payload = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        rows = payload.get("sources", payload) if isinstance(payload, Mapping) else payload
        if not isinstance(rows, list):
            raise ValueError("学校来源文件必须是数组或包含 sources 数组的对象")
        sources = [_source_from_mapping(row) for row in rows if isinstance(row, Mapping)]
    if source_name:
        wanted = source_name.casefold()
        sources = [source for source in sources if source.school.casefold() == wanted or source.label.casefold() == wanted]
    if not sources:
        raise ValueError("没有匹配的学校来源")
    return sources


def fetch_source(source: SchoolSource, timeout: int, retry_attempts: int, retry_backoff: float, logger: Any = None) -> tuple[str, str]:
    allowed, robots_reason = robots_allowed(
        source.url,
        user_agent=USER_AGENT,
        timeout=timeout,
        retry_attempts=min(2, max(1, retry_attempts)),
        retry_backoff_seconds=retry_backoff,
    )
    if not allowed:
        if logger:
            logger.event("school-source-skipped", school=source.school, url=source.url, reason=robots_reason)
        return "", robots_reason

    def read_page() -> str:
        request = Request(
            source.url,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "ja,en;q=0.8",
                "User-Agent": "nihonga-directory-school-crawler/1.0",
            },
        )
        with urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")

    try:
        html = retry_call(
            read_page,
            attempts=max(1, retry_attempts),
            backoff_seconds=retry_backoff,
            on_attempt=(
                lambda attempt, error, retry: logger.event(
                    "school-source-retry" if retry else "school-source-failed",
                    school=source.school,
                    url=source.url,
                    attempt=attempt,
                    retrying=retry,
                    reason=str(error)[:160],
                )
                if logger
                else None
            ),
        )
    except Exception as error:
        if logger:
            logger.event("school-source-failed", school=source.school, url=source.url, reason=str(error)[:160])
        return "", error.__class__.__name__
    if logger:
        logger.event("school-source-fetched", school=source.school, url=source.url, bytes=len(html))
    return html, "ok"


def _normalize_student_name(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip(" \t\r\n・、,，/／")
    value = NOISE_RE.sub("", value).strip()
    return value


def extract_students(text: str, include_alumni: bool = False) -> list[dict[str, str]]:
    """Extract degree-labelled names from a school article's student section."""
    start = SECTION_START_RE.search(text)
    if not start:
        return []
    tail = text[start.end():]
    end = SECTION_END_RE.search(tail)
    student_text = tail[: end.start()] if end else tail
    matches = list(DEGREE_RE.finditer(student_text))
    result: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        label = match.group(0).strip()
        next_start = matches[index + 1].start() if index + 1 < len(matches) else len(student_text)
        names_text = student_text[match.end():next_start]
        names = [
            _normalize_student_name(name)
            for name in re.split(r"[・、,，]+", names_text)
            if _normalize_student_name(name)
        ]
        status = "researcher" if match.group("research") else "student"
        year = match.group("year") or ""
        for name in names:
            result.append({"name": name, "studyLevel": label, "studyYear": year, "status": status})

    if include_alumni:
        alumni_match = re.search(r"◇\s*卒業生\s+(.+?)(?=——|◇|関連リンク|$)", text)
        if alumni_match:
            for name in re.split(r"[・、,，]+", alumni_match.group(1)):
                value = _normalize_student_name(name)
                if value:
                    result.append({"name": value, "studyLevel": "卒業生", "studyYear": "", "status": "alumni"})
    return result


def extract_faculty(text: str) -> list[dict[str, str]]:
    """Extract role-labelled faculty names from an official school page."""
    start = FACULTY_SECTION_RE.search(text)
    if not start:
        return []
    tail = text[start.end():]
    end = FACULTY_END_RE.search(tail)
    faculty_text = tail[: end.start()] if end else tail
    matches = list(FACULTY_ROLE_RE.finditer(faculty_text))
    result: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        next_start = matches[index + 1].start() if index + 1 < len(matches) else len(faculty_text)
        names_text = faculty_text[match.end():next_start]
        names = [
            _normalize_student_name(name)
            for name in re.split(r"[・、,，]+", names_text)
            if _normalize_student_name(name)
        ]
        for name in names:
            result.append({
                "name": name,
                "studyLevel": match.group("role"),
                "studyYear": "",
                "status": "faculty",
                "facultyRole": match.group("role"),
            })
    return result


def _stable_external_id(source: SchoolSource, name: str, status: str) -> str:
    normalized = normalize_name(f"{source.school}:{status}:{name}") or name.casefold()
    return normalized[:120]


def build_artist(source: SchoolSource, person: Mapping[str, Any], profile_map: Mapping[str, Any] | None = None) -> dict[str, Any]:
    name = str(person.get("name") or "").strip()
    status = str(person.get("status") or "student").strip()
    study_level = str(person.get("studyLevel") or "").strip()
    study_year = str(person.get("studyYear") or "").strip()
    profile = (profile_map or {}).get(name)
    profile_value = profile if isinstance(profile, Mapping) else {"instagram": profile} if profile else {}
    handle = normalize_handle(profile_value.get("handle") or profile_value.get("instagram"))
    instagram = canonical_profile_url(handle)
    source_url = canonical_external_url(
        profile_value.get("sourcePage") or profile_value.get("source_page") or source.url
    ) or canonical_external_url(source.url)
    external_id = _stable_external_id(source, name, status)
    note_parts = [f"{source.label}：公开列名"]
    if study_level:
        note_parts.append(study_level)
    if study_year:
        note_parts.append(study_year)
    if status == "alumni":
        note_parts.append("毕业生")
    raw = {
        "name": str(profile_value.get("name") or name).strip(),
        "region": source.region,
        "school": source.school,
        "styles": ["日本画"],
        # The source URL is trusted crawler metadata.  Do not run it through
        # the bio sanitizer: its digit path can look like a phone number.
        "note": "；".join(note_parts),
        "sources": [{"provider": source.provider, "externalId": external_id, "url": source_url}],
    }
    if handle:
        raw["sources"].append({"provider": "instagram", "username": handle, "url": instagram})
    artist = normalize_artist_record(raw)
    artist.update({
        "schoolSourceId": external_id,
        "studentStatus": status,
        "personType": "faculty" if status == "faculty" else ("alumni" if status == "alumni" else "student"),
        "studyLevel": study_level,
        "studyYear": study_year,
        "facultyRole": str(person.get("facultyRole") or "") if status == "faculty" else "",
        "profileMatched": bool(handle),
    })
    return artist


def build_report(
    sources: Iterable[SchoolSource],
    existing: Iterable[Mapping[str, Any]],
    *,
    profile_map: Mapping[str, Any] | None = None,
    include_alumni: bool = False,
    timeout: int = 30,
    retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
    retry_backoff: float = DEFAULT_RETRY_BACKOFF,
    logger: Any = None,
) -> dict[str, Any]:
    existing_rows = list(existing)
    existing_names = {normalize_name(row.get("name")) for row in existing_rows if isinstance(row, Mapping)}
    existing_keys: set[str] = set()
    for row in existing_rows:
        existing_keys.update(artist_identity_keys(row))
    candidates: list[dict[str, Any]] = []
    duplicates: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    seen: set[str] = set()
    fetched_sources: list[dict[str, Any]] = []
    for source in sources:
        html, status = fetch_source(source, timeout, retry_attempts, retry_backoff, logger)
        source_result = {**source.as_dict(), "status": status}
        if not html:
            errors.append({"school": source.school, "url": source.url, "reason": status})
            fetched_sources.append(source_result)
            continue
        parser = _VisibleTextParser()
        parser.feed(html)
        text = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
        students = extract_students(text, include_alumni=include_alumni or source.include_alumni)
        faculty = extract_faculty(text) if source.include_faculty else []
        people = students + faculty
        source_result["studentsFound"] = len(students)
        source_result["peopleFound"] = len(people)
        source_result["studentCount"] = len(students)
        source_result["facultyFound"] = len(faculty)
        fetched_sources.append(source_result)
        for person in people:
            artist = build_artist(source, person, profile_map)
            source_id = artist.get("schoolSourceId", "")
            name_key = normalize_name(artist.get("name"))
            identity = artist_identity_keys(artist)
            if source_id in seen or identity.intersection(existing_keys) or (name_key and name_key in existing_names):
                duplicates.append({"school": source.school, "name": artist.get("name", ""), "reason": "existing-or-duplicate"})
                if logger:
                    logger.event("school-candidate-duplicate", school=source.school, name=artist.get("name", ""), reason="existing-or-duplicate")
                continue
            seen.add(source_id)
            candidates.append(artist)
            if logger:
                logger.event("school-candidate-accepted", school=source.school, name=artist.get("name", ""), matched=bool(artist.get("profileMatched")))
    report = {
        "source": "public-university-nihonga-pages",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "writeMode": "review-only; school candidates without a public profile are not pushed",
        "sources": fetched_sources,
        "summary": {
            "sources": len(fetched_sources),
            "studentsFound": sum(int(row.get("studentsFound", 0)) for row in fetched_sources),
            "peopleFound": sum(int(row.get("peopleFound", 0)) for row in fetched_sources),
            "studentCount": sum(int(row.get("studentCount", 0)) for row in fetched_sources),
            "facultyFound": sum(int(row.get("facultyFound", 0)) for row in fetched_sources),
            "candidates": len(candidates),
            "profileMatched": sum(1 for row in candidates if row.get("profileMatched")),
            "profilePending": sum(1 for row in candidates if not row.get("profileMatched")),
            "facultyCandidates": sum(1 for row in candidates if row.get("personType") == "faculty"),
            "duplicates": len(duplicates),
            "errors": len(errors),
        },
        "newArtists": candidates,
        "duplicates": duplicates,
        "errors": errors,
    }
    if logger:
        logger.event("school-crawl-finished", **report["summary"])
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Discover Nihonga students from public university pages.")
    parser.add_argument("--source-file", help="JSON file containing a sources array.")
    parser.add_argument("--source", help="School name or source label to select.")
    parser.add_argument("--existing-file", help="Saved /api/artists JSON snapshot for duplicate filtering.")
    parser.add_argument("--artists-api", default="https://nihonga-online-deploy.vercel.app/api/artists")
    parser.add_argument("--profile-map-file", help="Optional JSON map of public names to Instagram/profile metadata.")
    parser.add_argument("--only-faculty", action="store_true", help="Keep only faculty records from each source.")
    parser.add_argument("--include-alumni", action="store_true")
    parser.add_argument("--push", action="store_true", help="Write candidates with a public source page through the admin API.")
    parser.add_argument("--admin-password-file", help="Local file containing ADMIN_PASSWORD; required with --push.")
    parser.add_argument("--state-file", default="imports/school-push-state.json")
    parser.add_argument("--out", default="imports/school-candidates.json")
    parser.add_argument("--log-file", default="imports/school-crawler.jsonl")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--retry-attempts", type=int, default=DEFAULT_RETRY_ATTEMPTS)
    parser.add_argument("--retry-backoff", type=float, default=DEFAULT_RETRY_BACKOFF)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout < 1 or args.retry_attempts < 1 or args.retry_backoff < 0:
        raise SystemExit("timeout/retry 参数必须为正数，backoff 不能小于 0")
    logger = CrawlerLogger(args.log_file)
    sources = load_sources(args.source_file, args.source)
    existing = load_existing_artists(args.artists_api, args.existing_file, timeout=args.timeout, retry_attempts=args.retry_attempts, retry_backoff_seconds=args.retry_backoff, logger=logger)
    profile_map: Mapping[str, Any] | None = None
    if args.profile_map_file:
        payload = json.loads(Path(args.profile_map_file).read_text(encoding="utf-8-sig"))
        profile_map = payload if isinstance(payload, Mapping) else {}
    report = build_report(
        sources,
        existing,
        profile_map=profile_map,
        include_alumni=args.include_alumni,
        timeout=args.timeout,
        retry_attempts=args.retry_attempts,
        retry_backoff=args.retry_backoff,
        logger=logger,
    )
    if args.only_faculty:
        report["newArtists"] = [artist for artist in report["newArtists"] if artist.get("personType") == "faculty"]
        report["summary"]["candidates"] = len(report["newArtists"])
        report["summary"]["profileMatched"] = sum(1 for artist in report["newArtists"] if artist.get("profileMatched"))
        report["summary"]["profilePending"] = sum(1 for artist in report["newArtists"] if not artist.get("profileMatched"))
        report["summary"]["facultyCandidates"] = len(report["newArtists"])
    if args.push:
        if not args.admin_password_file:
            raise SystemExit("--push 需要 --admin-password-file")
        password = read_admin_password(args.admin_password_file)
        if not password:
            raise SystemExit("管理员密码文件为空")
        parsed_api = urlsplit(args.artists_api)
        admin_endpoint = f"{parsed_api.scheme}://{parsed_api.netloc}/api/admin-artists"
        state = load_push_state(args.state_file)
        records = state.setdefault("records", {})
        pushed: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        duplicates: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        for artist in report["newArtists"]:
            key = artist.get("schoolSourceId") or ""
            if not key:
                continue
            previous = records.get(key)
            if isinstance(previous, Mapping) and previous.get("status") in {"pushed", "duplicate"}:
                skipped.append({"name": artist.get("name", ""), "schoolSourceId": key, "reason": "already-processed"})
                logger.event("school-write-skipped", school=artist.get("school", ""), name=artist.get("name", ""), reason="already-processed")
                continue
            response = push_artist(
                admin_endpoint,
                artist,
                password,
                retry_attempts=args.retry_attempts,
                retry_backoff_seconds=args.retry_backoff,
                logger=logger,
            )
            if response.get("ok"):
                pushed.append({"name": artist.get("name", ""), "schoolSourceId": key, "response": response})
                records[key] = {"status": "pushed", "updatedAt": datetime.now(timezone.utc).isoformat(), "name": artist.get("name", "")}
            elif int(response.get("status", 0) or 0) == 409:
                duplicates.append({"name": artist.get("name", ""), "schoolSourceId": key, "reason": "server-duplicate"})
                records[key] = {"status": "duplicate", "updatedAt": datetime.now(timezone.utc).isoformat(), "name": artist.get("name", "")}
            else:
                errors.append({"name": artist.get("name", ""), "schoolSourceId": key, "reason": response.get("message", "import-failed")})
                records[key] = {"status": "error", "updatedAt": datetime.now(timezone.utc).isoformat(), "name": artist.get("name", ""), "reason": response.get("message", "import-failed")}
            save_push_state(args.state_file, state)
        report["writeMode"] = "admin-api-post"
        report["pushSummary"] = {"pushed": len(pushed), "skipped": len(skipped), "duplicates": len(duplicates), "errors": len(errors)}
        report["pushed"] = pushed
        report["skipped"] = skipped
        report["writeDuplicates"] = duplicates
        report["pushErrors"] = errors
    report["runId"] = logger.run_id
    report["logFile"] = str(args.log_file)
    write_json_atomic(args.out, report)
    print(json.dumps({"out": args.out, "summary": report["summary"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
