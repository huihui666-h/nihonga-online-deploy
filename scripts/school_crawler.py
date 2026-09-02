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
import getpass
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
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
    parser: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "school": self.school,
            "region": self.region,
            "url": self.url,
            "label": self.label,
            "provider": self.provider,
            "includeAlumni": self.include_alumni,
            "includeFaculty": self.include_faculty,
            "parser": self.parser,
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
FACULTY_ROLE_RE = re.compile(r"(?P<role>客員教授|名誉教授|非常勤講師|准教授|教授|助教|講師|助手|副手)\s*")
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


class _HtmlNode:
    """Small read-only DOM node used by the configured school parsers."""

    def __init__(
        self,
        tag: str,
        attrs: Mapping[str, str] | None = None,
        parent: "_HtmlNode | None" = None,
    ) -> None:
        self.tag = tag.casefold()
        self.attrs = dict(attrs or {})
        self.parent = parent
        self.children: list[_HtmlNode | str] = []

    def text(self) -> str:
        parts: list[str] = []

        def collect(node: _HtmlNode) -> None:
            for child in node.children:
                if isinstance(child, str):
                    parts.append(child)
                else:
                    collect(child)

        collect(self)
        return re.sub(r"\s+", " ", " ".join(parts)).strip()


class _DomParser(HTMLParser):
    """Build only the DOM details needed for deterministic official-page parsing."""

    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    SKIP_TAGS = {"script", "style", "noscript", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _HtmlNode("document")
        self.stack = [self.root]
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_name = tag.casefold()
        if tag_name in self.SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        node = _HtmlNode(tag_name, {key.casefold(): value or "" for key, value in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag_name not in self.VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._skip_depth or tag.casefold() in self.SKIP_TAGS:
            return
        node = _HtmlNode(tag, {key.casefold(): value or "" for key, value in attrs}, self.stack[-1])
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.casefold()
        if tag_name in self.SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag_name:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if not self._skip_depth and data:
            self.stack[-1].children.append(data)


def _parse_dom(raw_html: str) -> _HtmlNode:
    parser = _DomParser()
    parser.feed(raw_html)
    return parser.root


def _walk(node: _HtmlNode) -> Iterable[_HtmlNode]:
    for child in node.children:
        if isinstance(child, _HtmlNode):
            yield child
            yield from _walk(child)


def _classes(node: _HtmlNode) -> set[str]:
    return {value for value in node.attrs.get("class", "").casefold().split() if value}


def _find_all(node: _HtmlNode, tag: str = "", class_name: str = "") -> list[_HtmlNode]:
    tag_name = tag.casefold()
    class_value = class_name.casefold()
    return [
        candidate
        for candidate in _walk(node)
        if (not tag_name or candidate.tag == tag_name)
        and (not class_value or class_value in _classes(candidate))
    ]


def _find_first(node: _HtmlNode, tag: str = "", class_name: str = "") -> _HtmlNode | None:
    return next(iter(_find_all(node, tag, class_name)), None)


def _ancestor(node: _HtmlNode | None, tag: str) -> _HtmlNode | None:
    current = node
    wanted = tag.casefold()
    while current:
        if current.tag == wanted:
            return current
        current = current.parent
    return None


def _direct_children(node: _HtmlNode, tag: str = "") -> list[_HtmlNode]:
    wanted = tag.casefold()
    return [
        child for child in node.children
        if isinstance(child, _HtmlNode) and (not wanted or child.tag == wanted)
    ]


def _absolute_link(source: SchoolSource, node: _HtmlNode | None) -> str:
    if not node:
        return ""
    href = node.attrs.get("href", "")
    return canonical_external_url(urljoin(source.url, href)) if href else ""


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
        parser=str(value.get("parser") or "").strip(),
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
        parsed = urlsplit(source.url)
        request_url = urlunsplit((
            parsed.scheme,
            parsed.netloc,
            quote(parsed.path, safe="/%:@"),
            parsed.query,
            "",
        ))
        request = Request(
            request_url,
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


JAPANESE_NAME_CHARACTERS = r"\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff々〆ヶ"


def _normalize_person_name(value: str) -> str:
    name = _normalize_student_name(value)
    return re.sub(
        rf"(?<=[{JAPANESE_NAME_CHARACTERS}])\s+(?=[{JAPANESE_NAME_CHARACTERS}])",
        "",
        name,
    )


def _table_rows(table: _HtmlNode) -> list[list[_HtmlNode]]:
    rows: list[list[_HtmlNode]] = []
    for row in _find_all(table, "tr"):
        cells = [cell for cell in _direct_children(row) if cell.tag in {"td", "th"}]
        if cells:
            rows.append(cells)
    return rows


def _geidai_nihonga_faculty(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    table = next(
        (
            candidate for candidate in _find_all(root, "table")
            if "日本画" in candidate.text() and "第1研究室" in candidate.text() and "第2研究室" in candidate.text()
        ),
        None,
    )
    if not table:
        return []
    people: list[dict[str, str]] = []
    for cells in _table_rows(table):
        if len(cells) < 2:
            continue
        name_cell, role_cell = cells[-2], cells[-1]
        role = role_cell.text()
        if not re.search(r"(?:教授|准教授|講師|助教|助手|副手)", role):
            continue
        name = _normalize_person_name(name_cell.text())
        if not name or name in {"氏名", "研究分野・研究室"}:
            continue
        link = _find_first(name_cell, "a")
        people.append({
            "name": name,
            "studyLevel": role,
            "studyYear": "",
            "status": "faculty",
            "facultyRole": role,
            "sourcePage": _absolute_link(source, link) or source.url,
        })
    return people


def _geidai_nihonga_latest_awards(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    nodes = list(_walk(root))
    heading_index = next(
        (
            index for index, node in enumerate(nodes)
            if node.tag == "h2" and re.fullmatch(r"令和\s*[0-9０-９]+\s*年度", node.text())
        ),
        None,
    )
    if heading_index is None:
        return []
    year = nodes[heading_index].text()
    table: _HtmlNode | None = None
    for node in nodes[heading_index + 1:]:
        if node.tag == "h2":
            break
        if node.tag == "table":
            table = node
            break
    if not table:
        return []
    people: list[dict[str, str]] = []
    for cells in _table_rows(table):
        if len(cells) < 3:
            continue
        affiliation = cells[0].text()
        compact_affiliation = re.sub(r"\s+", "", affiliation)
        if "日本画研究分野" not in compact_affiliation or "保存修復" in compact_affiliation:
            continue
        name = _normalize_person_name(cells[1].text())
        if not name or name == "氏名":
            continue
        people.append({
            "name": name,
            "studyLevel": affiliation,
            "studyYear": year,
            "status": "alumni",
            "workTitle": cells[2].text(),
            "sourcePage": source.url,
        })
    return people


def _direct_text(node: _HtmlNode | None) -> str:
    if not node:
        return ""
    return re.sub(
        r"\s+",
        " ",
        " ".join(child for child in node.children if isinstance(child, str)),
    ).strip()


def _find_by_id(node: _HtmlNode, node_id: str) -> _HtmlNode | None:
    return next((candidate for candidate in _walk(node) if candidate.attrs.get("id") == node_id), None)


def _source_year(source: SchoolSource) -> str:
    match = re.search(r"/(20[0-9]{2})(?:/|$)", urlsplit(source.url).path)
    return f"{match.group(1)}年度" if match else ""


def _dedupe_people(people: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for person in people:
        name_key = normalize_name(person.get("name"))
        if not name_key or name_key in seen:
            continue
        seen.add(name_key)
        result.append(person)
    return result


def _geidai_nihonga_awards_history(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    """Read every annual Nihonga row while excluding conservation courses."""
    nodes = list(_walk(root))
    people: list[dict[str, str]] = []
    year_pattern = re.compile(r"(?:令和|平成)\s*(?:元|[0-9０-９]+)\s*年度")
    for heading_index, heading in enumerate(nodes):
        if heading.tag != "h2" or not year_pattern.fullmatch(heading.text()):
            continue
        table: _HtmlNode | None = None
        for node in nodes[heading_index + 1:]:
            if node.tag == "h2":
                break
            if node.tag == "table":
                table = node
                break
        if not table:
            continue
        for cells in _table_rows(table):
            if len(cells) < 3:
                continue
            affiliation = cells[0].text()
            compact_affiliation = re.sub(r"\s+", "", affiliation)
            if (
                "絵画専攻" not in compact_affiliation
                or "日本画研究分野" not in compact_affiliation
                or "文化財保存学" in compact_affiliation
                or "保存修復" in compact_affiliation
            ):
                continue
            name = _normalize_person_name(cells[1].text())
            if not name or name == "氏名" or re.fullmatch(r"[0-9０-９]+名(?:※.*)?", name):
                continue
            people.append({
                "name": name,
                "studyLevel": affiliation,
                "studyYear": heading.text(),
                "status": "alumni",
                "workTitle": cells[2].text(),
                "sourcePage": source.url,
            })
    return _dedupe_people(people)


def _doctoral_person(
    source: SchoolSource,
    name: str,
    *,
    roman_name: str = "",
    source_page: str = "",
    work_title: str = "",
) -> dict[str, str]:
    person = {
        "name": _normalize_person_name(name),
        "studyLevel": "博士後期課程 日本画研究分野",
        "studyYear": _source_year(source),
        "status": "alumni",
        "sourcePage": source_page or source.url,
    }
    if roman_name:
        person["romanName"] = re.sub(r"\s+", " ", roman_name).strip()
    if work_title:
        person["workTitle"] = work_title.strip()
    return person


def _thumbnail_person_name(item: _HtmlNode) -> str:
    for image in _find_all(item, "img"):
        filename = unquote(urlsplit(image.attrs.get("src", "")).path.rsplit("/", 1)[-1])
        filename = re.sub(r"-\d+x\d+(?=\.[^.]+$)", "", filename)
        stem = filename.rsplit(".", 1)[0]
        if "_" not in stem:
            continue
        tail = stem.split("_", 1)[1]
        match = re.match(
            rf"(?P<name>[{JAPANESE_NAME_CHARACTERS}]{{2,16}}?)(?=_|「|『|作品|[-0-9０-９])",
            tail,
        )
        if match:
            return _normalize_person_name(match.group("name"))
    return ""


def _geidai_doctoral_nihonga(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    """Parse official doctoral Nihonga pages across the 2014-2025 layouts."""
    people: list[dict[str, str]] = []

    # 2021 onward: dedicated department pages with bilingual descriptions.
    page_heading = next((node for node in _find_all(root, "h1") if "日本画" in node.text()), None)
    if page_heading and re.search(r"/departments/01\.html$", urlsplit(source.url).path):
        for item in _find_all(root, "li"):
            icon = _find_first(item, "div", "item_icon")
            description = _find_first(item, "div", "description")
            if not icon or not description or "日本画" not in icon.text():
                continue
            name = _direct_text(description)
            if not name:
                continue
            roman_node = _find_first(description, "i")
            title_node = _find_first(item, "div", "title")
            link = _find_first(item, "a")
            people.append(_doctoral_person(
                source,
                name,
                roman_name=roman_node.text() if roman_node else "",
                source_page=_absolute_link(source, link),
                work_title=title_node.text() if title_node else "",
            ))
        return _dedupe_people(people)

    # 2014 and 2015 used dedicated Japanese Painting category pages.
    headline = _find_first(root, "section", "headline")
    if headline and "日本画" in headline.text():
        for name_node in _find_all(root, "div", "producer"):
            item = _ancestor(name_node, "li")
            roman_node = _find_first(item, "div", "producer-en") if item else None
            link = _find_first(item, "a") if item else None
            people.append(_doctoral_person(
                source,
                name_node.text(),
                roman_name=roman_node.text() if roman_node else "",
                source_page=_absolute_link(source, link),
            ))
        return _dedupe_people(people)

    title = _find_by_id(root, "title")
    if title and "日本画" in title.text():
        for name_node in _find_all(root, "h4", "list-name"):
            item = _ancestor(name_node, "li")
            title_node = _find_first(item, "h3", "list-title") if item else None
            link = _find_first(item, "a") if item else None
            people.append(_doctoral_person(
                source,
                name_node.text(),
                source_page=_absolute_link(source, link),
                work_title=title_node.text() if title_node else "",
            ))
        return _dedupe_people(people)

    # 2016-2018 detail pages expose an explicit Japanese Painting marker.
    department = _find_by_id(root, "department")
    part = next((node for node in _find_all(root, class_name="part") if "日本画" in node.text() or "Japanese Painting" in node.text()), None)
    if (department and "Japanese Painting" in department.text()) or part:
        name_node = _find_by_id(root, "name") or _find_first(root, "h2", "author")
        if name_node:
            work_node = _find_by_id(root, "work") or _find_first(root, "h1")
            return [_doctoral_person(
                source,
                name_node.text(),
                source_page=source.url,
                work_title=work_node.text() if work_node else "",
            )]

    # 2019 kept author nodes inside a named Japanese Painting section.
    japanese_painting = _find_by_id(root, "japanese-painting")
    if japanese_painting and japanese_painting.tag == "div":
        for name_node in _find_all(japanese_painting, class_name="author"):
            item = _ancestor(name_node, "li")
            title_node = _find_first(item, "div", "work_title") if item else None
            link = _find_first(item, "a") if item else None
            people.append(_doctoral_person(
                source,
                name_node.text(),
                source_page=_absolute_link(source, link),
                work_title=title_node.text() if title_node else "",
            ))
        return _dedupe_people(people)

    # 2020's category page contains names only in its official thumbnails.
    if japanese_painting and japanese_painting.tag == "h3" and japanese_painting.parent:
        siblings = _direct_children(japanese_painting.parent)
        try:
            start = siblings.index(japanese_painting)
        except ValueError:
            start = -1
        section = next((node for node in siblings[start + 1:] if node.tag == "section"), None)
        if section:
            for item in _find_all(section, "li"):
                name = _thumbnail_person_name(item)
                link = _find_first(item, "a")
                if name:
                    people.append(_doctoral_person(source, name, source_page=_absolute_link(source, link)))
    return _dedupe_people(people)


def _geidai_geisai_nihonga_students(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    descriptions = [
        node.attrs.get("content", "")
        for node in _find_all(root, "meta")
        if node.attrs.get("name", "").casefold() == "description"
    ]
    if not any("日本画専攻" in description and "4 年生" in description for description in descriptions):
        return []
    people: list[dict[str, str]] = []
    author_pattern = re.compile(
        rf"(?P<name>[{JAPANESE_NAME_CHARACTERS}]{{2,16}})\s*(?P<roman>[A-Za-z][A-Za-z .'-]{{1,80}})?$"
    )
    for title_box in _find_all(root, "div", "module_title"):
        heading = _find_first(title_box, "h3")
        match = author_pattern.search(heading.text()) if heading else None
        if not match:
            continue
        people.append({
            "name": _normalize_person_name(match.group("name")),
            "romanName": re.sub(r"\s+", " ", match.group("roman") or "").strip(),
            "studyLevel": "日本画専攻",
            "studyYear": "学部4年（2020）",
            "status": "student",
            "sourcePage": source.url,
        })
    return _dedupe_people(people)


def _tamabi_nihonga_faculty(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    people: list[dict[str, str]] = []
    for figure in _find_all(root, "figure", "faculty_rep"):
        names = [heading.text() for heading in _find_all(figure, "h4") if heading.text()]
        role_node = _find_first(figure, "p")
        if not names or not role_node:
            continue
        role = role_node.text()
        if not re.search(r"(?:教授|准教授|講師|助教|助手|副手)", role):
            continue
        link = _find_first(figure, "a")
        person = {
            "name": _normalize_person_name(names[0]),
            "studyLevel": role,
            "studyYear": "",
            "status": "faculty",
            "facultyRole": role,
            "sourcePage": _absolute_link(source, link) or source.url,
        }
        if len(names) > 1:
            person["romanName"] = names[1]
        if person["name"]:
            people.append(person)
    return people


def _tamabi_nihonga_student_works(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    year_labels = {
        "first_year": ("学部", "1年次"),
        "second_year": ("学部", "2年次"),
        "third_year": ("学部", "3年次"),
        "fourth_year": ("学部", "4年次"),
        "graduate_year": ("大学院", "大学院"),
    }
    current_level = ""
    current_year = ""
    people: list[dict[str, str]] = []
    for node in _walk(root):
        node_id = node.attrs.get("id", "")
        if node.tag == "div" and node_id in year_labels:
            current_level, current_year = year_labels[node_id]
            continue
        if node.tag != "figure" or "works_rep" not in _classes(node) or not current_year:
            continue
        text_box = _find_first(node, "div", "works_rep_text")
        title_node = _find_first(text_box, "h4") if text_box else None
        if not title_node:
            continue
        name = _normalize_person_name(re.split(r"[｜|]", title_node.text(), maxsplit=1)[0])
        if name:
            people.append({
                "name": name,
                "studyLevel": current_level,
                "studyYear": current_year,
                "status": "student",
                "sourcePage": source.url,
            })
    return people


def _musabi_nihonga_faculty(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    people: list[dict[str, str]] = []
    faculty_heading = next((node for node in _find_all(root, "h2") if node.text() == "専任教員"), None)
    faculty_section = _ancestor(faculty_heading, "section")
    faculty_list = _find_first(faculty_section, "ul", "grid") if faculty_section else None
    if faculty_list:
        for item in _direct_children(faculty_list, "li"):
            emphasized = _find_first(item, "em")
            name_node = _find_first(emphasized, "span") if emphasized else None
            detail = _find_first(item, "span", "small")
            name = _normalize_person_name(name_node.text()) if name_node else ""
            detail_text = detail.text() if detail else item.text()
            role_match = re.search(r"(?:教授|准教授|講師|助教|助手|副手)(?:（主任）)?", detail_text)
            if not name or not role_match:
                continue
            link = _find_first(item, "a")
            people.append({
                "name": name,
                "studyLevel": role_match.group(0),
                "studyYear": "",
                "status": "faculty",
                "facultyRole": role_match.group(0),
                "sourcePage": _absolute_link(source, link) or source.url,
            })

    assistant_heading = next((node for node in _find_all(root, "h3") if node.text() == "助手"), None)
    assistant_section = _ancestor(assistant_heading, "section")
    assistant_list = _find_first(assistant_section, "ul", "grid") if assistant_section else None
    if assistant_list:
        for item in _direct_children(assistant_list, "li"):
            name_node = _find_first(item, "span")
            name = _normalize_person_name(name_node.text()) if name_node else ""
            if name:
                people.append({
                    "name": name,
                    "studyLevel": "助手",
                    "studyYear": "",
                    "status": "faculty",
                    "facultyRole": "助手",
                    "sourcePage": source.url,
                })
    return people


def _musabi_selected_nihonga(source: SchoolSource, root: _HtmlNode) -> list[dict[str, str]]:
    nihonga = next((node for node in _find_all(root, "div") if node.attrs.get("id") == "jp"), None)
    works = _find_first(nihonga, "ul", "works-list") if nihonga else None
    if not works:
        return []
    people: list[dict[str, str]] = []
    for item in _direct_children(works, "li"):
        name_node = _find_first(item, "h3", "title")
        name = _normalize_person_name(name_node.text()) if name_node else ""
        if not name:
            continue
        link = _find_first(item, "a")
        people.append({
            "name": name,
            "studyLevel": "日本画学科 優秀卒業制作",
            "studyYear": "2025年度",
            "status": "alumni",
            "sourcePage": _absolute_link(source, link) or source.url,
        })
    return people


SCHOOL_PARSERS = {
    "geidai-nihonga-faculty": _geidai_nihonga_faculty,
    "geidai-nihonga-latest-awards": _geidai_nihonga_latest_awards,
    "geidai-nihonga-awards-history": _geidai_nihonga_awards_history,
    "geidai-doctoral-nihonga": _geidai_doctoral_nihonga,
    "geidai-geisai-nihonga-students": _geidai_geisai_nihonga_students,
    "tamabi-nihonga-faculty": _tamabi_nihonga_faculty,
    "tamabi-nihonga-student-works": _tamabi_nihonga_student_works,
    "musabi-nihonga-faculty": _musabi_nihonga_faculty,
    "musabi-selected-nihonga": _musabi_selected_nihonga,
}


def parse_school_people(source: SchoolSource, html: str, include_alumni: bool = False) -> list[dict[str, str]]:
    if source.parser:
        parser = SCHOOL_PARSERS.get(source.parser)
        if not parser:
            raise ValueError(f"未知学校解析器：{source.parser}")
        people = parser(source, _parse_dom(html))
    else:
        text = _clean_visible_text(html)
        people = extract_students(text, include_alumni=include_alumni or source.include_alumni)
        if source.include_faculty:
            people.extend(extract_faculty(text))
    return [
        person for person in people
        if (include_alumni or source.include_alumni or person.get("status") != "alumni")
        and (source.include_faculty or person.get("status") != "faculty")
    ]


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
        person.get("sourcePage") or person.get("source_page")
        or profile_value.get("sourcePage") or profile_value.get("source_page")
        or source.url
    ) or canonical_external_url(source.url)
    external_id = _stable_external_id(source, name, status)
    note_parts = [f"{source.label}：公开列名"]
    if study_level:
        note_parts.append(study_level)
    if study_year:
        note_parts.append(study_year)
    if status == "alumni":
        note_parts.append("毕业生")
    if person.get("workTitle"):
        note_parts.append(f"作品：{str(person.get('workTitle')).strip()}")
    raw = {
        "name": str(profile_value.get("name") or name).strip(),
        "romanName": str(profile_value.get("romanName") or profile_value.get("roman_name") or person.get("romanName") or person.get("roman_name") or "").strip(),
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
        # University listing URLs are shared by many people. Only provider IDs
        # and Instagram usernames are strong identities; names handle legacy
        # database rows where additive crawler metadata is not persisted.
        existing_keys.update(
            key for key in artist_identity_keys(row)
            if key.startswith("external:") or key.startswith("instagram:")
        )
    candidates: list[dict[str, Any]] = []
    duplicates: list[dict[str, str]] = []
    errors: list[dict[str, str]] = []
    seen: set[str] = set()
    seen_names: set[str] = set()
    fetched_sources: list[dict[str, Any]] = []
    for source in sources:
        html, status = fetch_source(source, timeout, retry_attempts, retry_backoff, logger)
        source_result = {**source.as_dict(), "status": status}
        if not html:
            errors.append({"school": source.school, "url": source.url, "reason": status})
            fetched_sources.append(source_result)
            continue
        try:
            people = parse_school_people(source, html, include_alumni=include_alumni)
        except Exception as error:
            source_result["status"] = "parse-error"
            errors.append({"school": source.school, "url": source.url, "reason": f"parse-error:{error.__class__.__name__}"})
            fetched_sources.append(source_result)
            if logger:
                logger.event("school-source-parse-failed", school=source.school, url=source.url, reason=error.__class__.__name__)
            continue
        students = [person for person in people if person.get("status") != "faculty"]
        faculty = [person for person in people if person.get("status") == "faculty"]
        source_result["studentsFound"] = len(students)
        source_result["peopleFound"] = len(people)
        source_result["studentCount"] = len(students)
        source_result["facultyFound"] = len(faculty)
        fetched_sources.append(source_result)
        for person in people:
            artist = build_artist(source, person, profile_map)
            source_id = artist.get("schoolSourceId", "")
            name_key = normalize_name(artist.get("name"))
            identity = {
                key for key in artist_identity_keys(artist)
                if key.startswith("external:") or key.startswith("instagram:")
            }
            duplicate_reason = ""
            if source_id in seen:
                duplicate_reason = "current-run-source"
            elif name_key and name_key in seen_names:
                duplicate_reason = "current-run-name"
            elif identity.intersection(existing_keys) or (name_key and name_key in existing_names):
                duplicate_reason = "existing"
            if duplicate_reason:
                duplicates.append({"school": source.school, "name": artist.get("name", ""), "reason": duplicate_reason})
                if logger:
                    logger.event("school-candidate-duplicate", school=source.school, name=artist.get("name", ""), reason=duplicate_reason)
                continue
            seen.add(source_id)
            if name_key:
                seen_names.add(name_key)
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
    parser.add_argument("--admin-password-stdin", action="store_true", help="Read ADMIN_PASSWORD from hidden stdin instead of a file.")
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
        if args.admin_password_stdin:
            password = getpass.getpass("Admin password: ").strip()
        elif args.admin_password_file:
            password = read_admin_password(args.admin_password_file)
        else:
            raise SystemExit("--push 需要 --admin-password-file 或 --admin-password-stdin")
        if not password:
            raise SystemExit("管理员密码为空")
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
