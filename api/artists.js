const { assertConfig, sendJson, setCors, supabaseFetch } = require("./_supabase");
const { handleNews } = require("./_news");
const { handleNewsAi } = require("./_news-ai");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || "/api/artists", "https://local.invalid");
  if (url.searchParams.get("resource") === "news") {
    await handleNews(req, res, url);
    return;
  }
  if (url.searchParams.get("resource") === "news-ai") {
    await handleNewsAi(req, res, url);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }

  if (!assertConfig(res)) return;

  try {
    const rows = await supabaseFetch("artists?select=*&order=name.asc");
    const artists = rows.map((row) => ({
      id: row.id,
      name: row.name || "",
      romanName: row.roman_name || "",
      handle: row.handle || "",
      instagram: row.instagram || "",
      sourcePage: row.source_page || "",
      linkType: row.link_type || "instagram",
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
