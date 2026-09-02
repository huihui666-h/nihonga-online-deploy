const {
  assertConfig,
  publicUrl,
  readBody,
  requireAdmin,
  sendJson,
  setCors,
  supabaseFetch
} = require("./_supabase");
const { requireSameOrigin } = require("./_auth");

const CATEGORIES = new Set([
  "exhibition", "open_call", "artist_news", "museum", "nihonga_news",
  "award", "selection", "solo", "graduation", "university", "gallery"
]);
const STATUSES = new Set(["candidate", "published", "rejected", "expired"]);
const FIELD_NAMES = new Set([
  "title", "summary", "category", "sourceName", "sourceUrl", "publishedAt",
  "startDate", "endDate", "venue", "tags", "status"
]);

async function handleAdminNews(req, res, requestUrl) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (!assertConfig(res) || !requireAdmin(req, res)) return;

  const url = requestUrl || new URL(req.url || "/api/admin-news", "https://local.invalid");
  try {
    if (req.method === "GET") {
      const rows = await supabaseFetch("news?select=*&order=published_at.desc.nullslast,created_at.desc&limit=1000");
      sendJson(res, 200, { ok: true, news: Array.isArray(rows) ? rows : [] });
      return;
    }

    if (!requireSameOrigin(req, res)) return;
    if (req.method === "POST") {
      const payload = normalizeNews(await readBody(req), { requireTitle: true });
      const rows = await supabaseFetch("news?select=*", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(payload)
      });
      sendJson(res, 201, { ok: true, news: Array.isArray(rows) ? rows[0] : null });
      return;
    }

    const id = String(url.searchParams.get("id") || "").trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      sendJson(res, 400, { ok: false, message: "缺少新闻 id。" });
      return;
    }
    if (req.method === "PATCH") {
      const payload = normalizeNews(await readBody(req), { requireTitle: true });
      const rows = await supabaseFetch(`news?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(payload)
      });
      if (!Array.isArray(rows) || !rows[0]) {
        sendJson(res, 404, { ok: false, message: "新闻不存在。" });
        return;
      }
      sendJson(res, 200, { ok: true, news: rows[0] });
      return;
    }
    if (req.method === "DELETE") {
      await supabaseFetch(`news?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
  } catch (error) {
    sendJson(res, error.status || 500, { ok: false, message: error.message || "后台新闻管理失败。" });
  }
}

function normalizeNews(body, { requireTitle = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("请求内容不正确。");
    error.status = 400;
    throw error;
  }
  if (Object.keys(body).some((key) => !FIELD_NAMES.has(key))) {
    const error = new Error("新闻字段不正确。");
    error.status = 400;
    throw error;
  }
  const title = bounded(body.title, 300);
  const summary = bounded(body.summary, 600);
  const sourceName = bounded(body.sourceName, 160);
  const venue = bounded(body.venue, 240);
  const sourceUrl = normalizeUrl(body.sourceUrl);
  const publishedAt = normalizeDate(body.publishedAt, "publishedAt");
  const startDate = normalizeDate(body.startDate, "startDate");
  const endDate = normalizeDate(body.endDate, "endDate");
  const category = String(body.category || "nihonga_news").trim().toLowerCase();
  const status = String(body.status || "candidate").trim().toLowerCase();
  if (requireTitle && !title) fail("标题不能为空。");
  if (!CATEGORIES.has(category)) fail("新闻分类不受支持。");
  if (!STATUSES.has(status)) fail("新闻状态不受支持。");
  if (sourceUrl === null) fail("来源 URL 格式不正确。");
  const tags = normalizeTags(body.tags);
  return {
    title,
    summary,
    category,
    source_name: sourceName,
    source_url: sourceUrl,
    published_at: publishedAt,
    start_date: startDate,
    end_date: endDate,
    venue,
    tags,
    status
  };
}

function normalizeUrl(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  const text = bounded(value, 2048);
  if (!text || text.length > 2048) return null;
  return publicUrl(text) || null;
}

function normalizeDate(value, field) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${field} 日期格式不正确。`);
  return text;
}

function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,，、\n]/);
  return [...new Set(values.map((item) => bounded(item, 60)).filter(Boolean))].slice(0, 20);
}

function bounded(value, maximum) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

module.exports = { handleAdminNews };
module.exports._test = { CATEGORIES, STATUSES, normalizeNews, normalizeTags };
