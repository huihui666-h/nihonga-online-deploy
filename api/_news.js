const { sendJson, supabaseFetch } = require("./_supabase");
const { newsSlug } = require("./_news-utils");

const CATEGORIES = new Set(["exhibition", "open_call", "artist_news", "museum", "nihonga_news", "award", "selection", "solo", "graduation", "university", "gallery"]);

function todayInTokyo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function integer(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

function rowToNews(row, artists) {
  const relatedArtists = Array.isArray(artists) ? artists : [];
  return {
    id: row.id,
    slug: newsSlug(row),
    title: row.title || "",
    summary: row.summary || "",
    category: row.category || "nihonga_news",
    sourceName: row.source_name || "",
    sourceUrl: row.source_url || "",
    publishedAt: row.published_at || "",
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    venue: row.venue || "",
    imageUrl: row.image_url || "",
    artistNames: Array.isArray(row.raw_artist_names)
      ? row.raw_artist_names.filter((name) => typeof name === "string" && name.trim())
      : [],
    tags: Array.isArray(row.tags)
      ? row.tags.filter((tag) => typeof tag === "string" && tag.trim())
      : [],
    relevanceScore: Number.isFinite(Number(row.relevance_score)) ? Number(row.relevance_score) : null,
    relatedArtists
  };
}

async function handleNews(req, res, requestUrl) {
  const url = requestUrl || new URL(req.url || "/api/artists?resource=news", "https://local.invalid");
  const requestedCategory = (url.searchParams.get("category") || "all").trim().toLowerCase();
  const category = CATEGORIES.has(requestedCategory) ? requestedCategory : "all";
  const limit = integer(url.searchParams.get("limit"), 24, 100);
  const offset = Math.min(10_000, Math.max(0, Number.parseInt(url.searchParams.get("offset"), 10) || 0));

  // The news migration is optional during local development and rollout.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(res, 200, { ok: true, news: [], category, limit, offset });
    return;
  }

  try {
    const today = todayInTokyo();
    const filters = [
      "status=eq.published",
      "category=neq.new_artist",
      // Inside PostgREST's `or` expression, filters use the
      // `column.operator.value` form (without `=`).
      `or=(category.not.in.(exhibition,open_call),end_date.is.null,end_date.gte.${today})`,
      `limit=${limit}`,
      `offset=${offset}`,
      "order=published_at.desc.nullslast,start_date.desc.nullslast,created_at.desc"
    ];
    if (CATEGORIES.has(category)) filters.unshift(`category=eq.${encodeURIComponent(category)}`);
    const rows = await supabaseFetch(`news?select=*&${filters.join("&")}`);
    const ids = rows.map((row) => row.id).filter(Boolean);
    let links = [];
    if (ids.length) {
      try {
        links = await supabaseFetch(
          `news_artists?news_id=in.(${ids.map(encodeURIComponent).join(",")})&select=news_id,artists(id,name,roman_name)&limit=1000`
        );
      } catch {
        // Raw AI names remain readable while the optional relation is migrated.
        links = [];
      }
    }
    const artistMap = new Map();
    links.forEach((link) => {
      const artist = Array.isArray(link.artists) ? link.artists[0] : link.artists;
      if (!artist || !link.news_id) return;
      const values = artistMap.get(link.news_id) || [];
      values.push({ id: artist.id, name: artist.name || "", romanName: artist.roman_name || "" });
      artistMap.set(link.news_id, values);
    });
    sendJson(res, 200, {
      ok: true,
      news: rows.map((row) => rowToNews(row, artistMap.get(row.id) || [])),
      category,
      limit,
      offset
    });
  } catch (error) {
    // Keep the additive endpoint isolated without returning upstream schema or
    // connection details to the browser.
    sendJson(res, 503, {
      ok: false,
      news: [],
      category,
      limit,
      offset,
      message: "ニュースを読み込めませんでした。"
    });
  }
}

module.exports = { handleNews };
module.exports._test = { CATEGORIES, integer, rowToNews, todayInTokyo };
