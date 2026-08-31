const { assertConfig, sendJson, setCors, supabaseFetch } = require("./_supabase");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
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
      updatedAt: row.updated_at || row.created_at || ""
    }));

    sendJson(res, 200, { ok: true, artists });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "读取画家名单失败。"
    });
  }
};
