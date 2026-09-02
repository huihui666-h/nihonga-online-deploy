const { assertConfig, rateLimit, sendJson, setCors, supabaseFetch } = require("./_supabase");
const { buildSlugMap, slugForArtist } = require("./_artist-utils");
const { handleNews } = require("./_news");
const { handleNewsAi } = require("./_news-ai");
const { handleArtistPage } = require("./_artist-page");
const { handleNewsPage } = require("./_news-page");
const { handleSitemap } = require("./_sitemap");
const { handleAdminNews } = require("./_admin-news");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!rateLimit(req, res, { limit: 120, windowMs: 60_000, keyPrefix: "artists" })) return;

  const url = new URL(req.url || "/api/artists", "https://local.invalid");
  if (url.searchParams.get("resource") === "news") {
    await handleNews(req, res, url);
    return;
  }
  if (url.searchParams.get("resource") === "news-ai") {
    await handleNewsAi(req, res, url);
    return;
  }
  if (url.searchParams.get("resource") === "artist-page") {
    await handleArtistPage(req, res, url);
    return;
  }
  if (url.searchParams.get("resource") === "news-page") {
    await handleNewsPage(req, res, url);
    return;
  }
  if (url.searchParams.get("resource") === "sitemap") {
    await handleSitemap(req, res, url);
    return;
  }
  if (url.searchParams.get("resource") === "admin-news") {
    await handleAdminNews(req, res, url);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }

  if (!assertConfig(res)) return;

  try {
    const rows = await supabaseFetch("artists?select=*&order=name.asc");
    const slugMap = buildSlugMap(rows);
    const artists = rows.map((row) => ({
      id: row.id,
      slug: slugForArtist(row, slugMap),
      name: row.name || "",
      romanName: row.roman_name || "",
      handle: row.handle || "",
      instagram: row.instagram || "",
      sourcePage: row.source_page || "",
      linkType: row.link_type || "instagram",
      sources: Array.isArray(row.sources) ? row.sources.slice(0, 12).map((source) => ({
        name: source?.source_name || source?.name || "",
        type: source?.source_type || source?.type || "",
        url: source?.source_url || source?.url || ""
      })) : undefined,
      region: row.region || "",
      school: row.school || "",
      styles: Array.isArray(row.styles) ? row.styles : [],
      note: row.note || "",
      updatedAt: row.updated_at || row.created_at || "",
      // Optional presentation metadata; no migration or changes to old fields.
      createdAt: row.created_at || undefined,
      addedAt: row.added_at || undefined,
      featured: typeof row.featured === "boolean" ? row.featured : undefined,
      huiNote: row.hui_note || row.huiNote || undefined,
      imageUrl: row.image_url || row.imageUrl || undefined,
      imageAlt: row.image_alt || row.imageAlt || undefined
    }));

    sendJson(res, 200, { ok: true, artists });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "读取画家名单失败。"
    });
  }
};
