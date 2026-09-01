"""AI enrichment interface and deterministic publication rules for news."""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from difflib import SequenceMatcher
from datetime import date, datetime, timezone
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .crawler import RawNewsItem, canonical_url


ALLOWED_CATEGORIES = frozenset({"exhibition", "open_call", "artist_news", "museum", "nihonga_news"})
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_BASE_URL = "https://api.openai.com/v1/chat/completions"
MAX_SUMMARY_LENGTH = 600
MAX_TITLE_LENGTH = 300
MAX_NAMES = 30
MAX_TAGS = 30


class AIProcessorError(RuntimeError):
    """Raised when an enabled AI provider returns an unusable response."""


def _text(value: Any, limit: int | None = None) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] if limit else text


def _iso_date(value: Any) -> str | None:
    text = _text(value)
    if not text:
        return None
    # Keep the contract strict: silently truncating an ISO timestamp or
    # accepting trailing text would make malformed dates look publishable.
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return None
    try:
        parsed = date.fromisoformat(text)
        return parsed.isoformat()
    except (TypeError, ValueError, OverflowError):
        return None


def _raw_dict(raw: RawNewsItem | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(raw, RawNewsItem):
        return raw.as_dict()
    if isinstance(raw, Mapping):
        return dict(raw)
    return {}


def _extract_json(content: Any) -> Any:
    if isinstance(content, Mapping) or isinstance(content, list):
        return content
    text = _text(content)
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
    try:
        return json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        # Models occasionally put a short preface before JSON.  Only accept a
        # complete object, never execute or eval model output.
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        raise AIProcessorError("AI response was not valid JSON") from error


def normalize_ai_result(result: Any, raw: RawNewsItem | Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Validate and bound the strict JSON contract returned by the model."""

    if not isinstance(result, Mapping):
        raise AIProcessorError("AI response must be a JSON object")
    raw_value = _raw_dict(raw or {})
    relevant = result.get("relevant")
    if not isinstance(relevant, bool):
        raise AIProcessorError("AI field relevant must be boolean")
    try:
        score = float(result.get("relevance_score"))
    except (TypeError, ValueError):
        raise AIProcessorError("AI field relevance_score must be numeric") from None
    if not 0 <= score <= 1:
        raise AIProcessorError("AI field relevance_score must be between 0 and 1")
    category = _text(result.get("category")).lower()
    if category not in ALLOWED_CATEGORIES:
        raise AIProcessorError(f"AI category is not allowed: {category or '<empty>'}")
    title = _text(result.get("title"), MAX_TITLE_LENGTH) or _text(raw_value.get("title"), MAX_TITLE_LENGTH)
    summary = _text(result.get("summary"), MAX_SUMMARY_LENGTH)
    names = result.get("artist_names", [])
    if isinstance(names, str):
        names = re.split(r"[,，、;；\n]", names)
    if not isinstance(names, list):
        names = []
    artist_names = list(dict.fromkeys(_text(item, 120) for item in names if _text(item, 120)))[:MAX_NAMES]
    tags = result.get("tags", [])
    if isinstance(tags, str):
        tags = re.split(r"[,，、#\n]", tags)
    if not isinstance(tags, list):
        tags = []
    normalized_tags = list(dict.fromkeys(_text(item, 60).lstrip("#") for item in tags if _text(item, 60).lstrip("#")))[:MAX_TAGS]
    source_url = canonical_url(raw_value.get("source_url") or raw_value.get("sourceUrl"))
    start_value = result.get("start_date")
    end_value = result.get("end_date")
    start_date = _iso_date(start_value)
    end_date = _iso_date(end_value)
    if (start_value not in (None, "") and not start_date) or (end_value not in (None, "") and not end_date):
        raise AIProcessorError("AI date fields must be YYYY-MM-DD or null")
    return {
        "relevant": relevant,
        "relevance_score": round(score, 4),
        "category": category,
        "title": title,
        "summary": summary,
        "artist_names": artist_names,
        "venue": _text(result.get("venue"), 160),
        "start_date": start_date,
        "end_date": end_date,
        "tags": normalized_tags,
        "source_url": source_url,
    }


def _date_anomaly(value: Mapping[str, Any], now: date | None = None) -> bool:
    # The crawler records malformed non-empty date fields separately because
    # their normalized value is necessarily ``None``. Treat that parse failure
    # as an anomaly instead of mistaking it for an intentionally missing date.
    if value.get("date_parse_error") is True:
        return True
    start_value = value.get("start_date")
    end_value = value.get("end_date")
    start = _iso_date(start_value)
    end = _iso_date(end_value)
    if start_value and not start:
        return True
    if end_value and not end:
        return True
    if start and end and start > end:
        return True
    # A date far outside the supported range is almost always a parse error.
    today = now or datetime.now(timezone.utc).date()
    for item in (start, end):
        if item:
            parsed = date.fromisoformat(item)
            if parsed.year < 1900 or parsed.year > today.year + 20:
                return True
    return False


def _summary_too_similar(summary: Any, excerpt: Any) -> bool:
    """Reject likely verbatim excerpts while allowing shared factual terms."""

    def compact(value: Any) -> str:
        text = unicodedata.normalize("NFKC", _text(value)).casefold()
        return re.sub(r"[^\w\u3040-\u30ff\u3400-\u9fff]+", "", text, flags=re.UNICODE)

    summary_text = compact(summary)
    excerpt_text = compact(excerpt)
    if len(summary_text) < 24 or len(excerpt_text) < 24:
        return False
    if summary_text in excerpt_text:
        return True
    return len(summary_text) >= 40 and SequenceMatcher(None, summary_text, excerpt_text[:4000]).ratio() >= 0.9


def determine_status(
    ai_result: Mapping[str, Any] | None,
    raw: RawNewsItem | Mapping[str, Any] | None = None,
    *,
    trusted_source: bool = False,
    duplicate: bool = False,
    now: date | None = None,
) -> str:
    """Apply publication policy in code; model output never sets ``status``."""

    value = dict(ai_result or {})
    raw_value = _raw_dict(raw or {})
    if duplicate:
        return "rejected"
    try:
        score = float(value.get("relevance_score", 0))
    except (TypeError, ValueError):
        score = 0
    relevant = value.get("relevant") is True
    category = _text(value.get("category")).lower()
    title = _text(value.get("title") or raw_value.get("title"), MAX_TITLE_LENGTH)
    summary = _text(value.get("summary"), MAX_SUMMARY_LENGTH)
    source_url = canonical_url(value.get("source_url") or raw_value.get("source_url"))
    if not relevant or score < 0.85 or category not in ALLOWED_CATEGORIES:
        return "rejected"
    if not title or not source_url or not summary:
        return "candidate"
    excerpt = raw_value.get("raw_excerpt") or raw_value.get("excerpt")
    if _summary_too_similar(summary, excerpt):
        return "candidate"
    date_values = dict(raw_value)
    for key in ("start_date", "end_date"):
        if value.get(key) not in (None, ""):
            date_values[key] = value[key]
    if not trusted_source or _date_anomaly(date_values, now=now):
        return "candidate"
    # The crawler preserves malformed source dates as a marker instead of
    # silently converting them to null.  Keep those records reviewable even
    # when the model still rates the item highly; an absent date is different
    # from a date that failed parsing.
    if raw_value.get("date_parse_error") is True:
        return "candidate"
    today = now or datetime.now(timezone.utc).date()
    end_date = _iso_date(date_values.get("end_date"))
    if category in {"exhibition", "open_call"} and end_date and date.fromisoformat(end_date) < today:
        return "expired"
    return "published"


def _prompt_for(raw: Mapping[str, Any]) -> str:
    payload = {
        "title": _text(raw.get("title"), MAX_TITLE_LENGTH),
        "source": _text(raw.get("source_name") or raw.get("source"), 160),
        "source_url": canonical_url(raw.get("source_url")) or _text(raw.get("source_url"), 500),
        "excerpt": _text(raw.get("raw_excerpt") or raw.get("excerpt") or raw.get("summary"), 1400),
        "published_at": _text(raw.get("published_at"), 100),
        "start_date": _text(raw.get("start_date"), 30),
        "end_date": _text(raw.get("end_date"), 30),
        "venue": _text(raw.get("venue"), 160),
    }
    return (
        "You are a Nihonga news metadata editor. Process only the supplied candidate; do not search the web. "
        "Return one JSON object and no markdown. Determine whether it directly concerns Japanese painting (日本画). "
        "Write an original, concise Japanese factual summary; do not copy sentences. Dates must be YYYY-MM-DD or null. "
        "Allowed category values: exhibition, open_call, artist_news, museum, nihonga_news. "
        "Required keys: relevant, relevance_score, category, title, summary, artist_names, venue, start_date, end_date, tags.\n"
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


class AIProcessor:
    """OpenAI-compatible processor with a disabled/no-key mode."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 30,
        retry_attempts: int = 3,
        retry_backoff: float = 1.0,
        request_fn: Callable[[str, dict[str, Any], float], Any] | None = None,
    ) -> None:
        self.api_key = (api_key if api_key is not None else os.getenv("OPENAI_API_KEY", "")).strip()
        self.base_url = (base_url or os.getenv("OPENAI_BASE_URL") or DEFAULT_BASE_URL).strip()
        self.model = (model or os.getenv("OPENAI_MODEL") or DEFAULT_MODEL).strip()
        self.timeout = max(1.0, float(timeout))
        self.retry_attempts = max(1, min(5, int(retry_attempts)))
        self.retry_backoff = max(0.0, float(retry_backoff))
        self.request_fn = request_fn

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _request_once(self, prompt: str) -> Any:
        payload = {
            "model": self.model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": "Output strict JSON only."},
                {"role": "user", "content": prompt},
            ],
        }
        if self.request_fn:
            try:
                return self.request_fn(self.base_url, payload, self.timeout)
            except AIProcessorError:
                raise
            except (URLError, TimeoutError, OSError) as error:
                raise AIProcessorError("AI request failed") from error
        request = Request(
            self.base_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json", "User-Agent": "nihonga-news-ai/1.0"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read(1_000_000)
            return json.loads(raw.decode("utf-8", errors="replace"))
        except HTTPError as error:
            # Preserve a bounded provider message (quota/rate-limit details
            # are often only present in the JSON body) without logging the
            # prompt or any source excerpt.
            detail = ""
            try:
                body = error.read(16_384).decode("utf-8", errors="replace")
                parsed = json.loads(body) if body else {}
                if isinstance(parsed, Mapping):
                    detail = _text(parsed.get("error", {}).get("message") if isinstance(parsed.get("error"), Mapping) else parsed.get("message"), 240)
                if not detail:
                    detail = _text(body, 240)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                detail = ""
            suffix = f": {detail}" if detail else ""
            raise AIProcessorError(f"AI HTTP error {error.code}{suffix}") from error
        except (URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as error:
            raise AIProcessorError("AI request failed") from error

    def _request(self, prompt: str) -> Any:
        """Retry transient provider failures without retrying auth failures."""

        last_error: AIProcessorError | None = None
        for attempt in range(self.retry_attempts):
            try:
                return self._request_once(prompt)
            except AIProcessorError as error:
                last_error = error
                message = str(error).casefold()
                retryable = "request failed" in message or "http error 429" in message or any(
                    f"http error {status}" in message for status in range(500, 600)
                )
                if not retryable or attempt + 1 >= self.retry_attempts:
                    raise
                time.sleep(self.retry_backoff * (2 ** attempt))
        raise last_error or AIProcessorError("AI request failed")

    def process(self, raw: RawNewsItem | Mapping[str, Any]) -> dict[str, Any] | None:
        """Return normalized metadata, or ``None`` while AI is unconfigured."""

        raw_value = _raw_dict(raw)
        if not self.enabled:
            return None
        response = self._request(_prompt_for(raw_value))
        if isinstance(response, Mapping) and "choices" in response:
            try:
                content = response["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError) as error:
                raise AIProcessorError("AI response did not contain choices.message.content") from error
        else:
            content = response
        return normalize_ai_result(_extract_json(content), raw)


def process_news_with_ai(
    raw: RawNewsItem | Mapping[str, Any],
    *,
    processor: AIProcessor | None = None,
) -> dict[str, Any] | None:
    """Stable service function used by scripts and API jobs."""

    return (processor or AIProcessor()).process(raw)


__all__ = [
    "AIProcessor",
    "AIProcessorError",
    "ALLOWED_CATEGORIES",
    "determine_status",
    "normalize_ai_result",
    "process_news_with_ai",
]
