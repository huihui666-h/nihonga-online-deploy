"""Independent Nihonga News crawler and processing pipeline.

The package deliberately has no imports from the existing Instagram crawler.
Use :class:`news.crawler.NewsCrawler` to collect source candidates and
:class:`news.ai_processor.AIProcessor` to process an individual candidate.
"""

from .config import NewsSource, default_sources, load_sources
from .crawler import NewsCrawler, RawNewsItem, crawl_sources
from .ai_processor import (
    ALLOWED_CATEGORIES,
    AIProcessor,
    AIProcessorError,
    determine_status,
    process_news_with_ai,
)
from .matching import match_artists, normalize_artist_name

__all__ = [
    "AIProcessor",
    "AIProcessorError",
    "ALLOWED_CATEGORIES",
    "NewsCrawler",
    "NewsSource",
    "RawNewsItem",
    "crawl_sources",
    "default_sources",
    "determine_status",
    "load_sources",
    "process_news_with_ai",
    "match_artists",
    "normalize_artist_name",
]
