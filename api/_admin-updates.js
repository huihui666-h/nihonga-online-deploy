const {
  assertConfig,
  readBody,
  requireAdmin,
  sendJson,
  setCors,
  supabaseFetch
} = require("./_supabase");
const { requireSameOrigin } = require("./_auth");

const STATUSES = new Set(["draft", "published"]);
const FIELD_NAMES = new Set(["title", "body", "publishedOn", "status"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function handleAdminUpdates(req, res, requestUrl) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (!assertConfig(res) || !requireAdmin(req, res)) return;

  const url = requestUrl || new URL(req.url || "/api/admin-updates", "https://local.invalid");
  try {
    if (req.method === "GET") {
      const rows = await supabaseFetch("site_updates?select=*&order=published_on.desc,created_at.desc&limit=500");
      sendJson(res, 200, { ok: true, updates: Array.isArray(rows) ? rows : [] });
      return;
    }

    if (!requireSameOrigin(req, res)) return;
    if (req.method === "POST") {
      const payload = normalizeSiteUpdate(await readBody(req), { requireTitle: true });
      const rows = await supabaseFetch("site_updates?select=*", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(payload)
      });
      sendJson(res, 201, { ok: true, update: Array.isArray(rows) ? rows[0] : null });
      return;
    }

    const id = String(url.searchParams.get("id") || "").trim();
    if (!UUID_PATTERN.test(id)) {
      sendJson(res, 400, { ok: false, message: "缺少有效的更新记录 id。" });
      return;
    }
    if (req.method === "PATCH") {
      const payload = normalizeSiteUpdate(await readBody(req), { requireTitle: true });
      const rows = await supabaseFetch(`site_updates?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(payload)
      });
      if (!Array.isArray(rows) || !rows[0]) {
        sendJson(res, 404, { ok: false, message: "更新记录不存在。" });
        return;
      }
      sendJson(res, 200, { ok: true, update: rows[0] });
      return;
    }
    if (req.method === "DELETE") {
      await supabaseFetch(`site_updates?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
  } catch (error) {
    if (req.method === "GET" && missingUpdatesTable(error)) {
      sendJson(res, 200, { ok: true, updates: [], unavailable: true });
      return;
    }
    sendJson(res, missingUpdatesTable(error) ? 503 : (error.status || 500), {
      ok: false,
      message: missingUpdatesTable(error)
        ? "更新记录数据表尚未初始化，请先执行 seed/site-updates.sql。"
        : (error.message || "后台更新记录管理失败。")
    });
  }
}

function normalizeSiteUpdate(body, { requireTitle = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("请求内容不正确。");
  if (Object.keys(body).some((key) => !FIELD_NAMES.has(key))) fail("更新记录字段不正确。");

  const title = bounded(body.title, 160);
  const updateBody = bounded(body.body, 500);
  const status = String(body.status || "draft").trim().toLowerCase();
  const publishedOn = normalizeDate(body.publishedOn || todayInTokyo());
  if (requireTitle && !title) fail("标题不能为空。");
  if (!STATUSES.has(status)) fail("发布状态不受支持。");

  return {
    title,
    body: updateBody,
    published_on: publishedOn,
    status
  };
}

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

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail("发布日期格式不正确。");
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail("发布日期不正确。");
  return text;
}

function bounded(value, maximum) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function missingUpdatesTable(error) {
  const detail = String(error && (error.upstreamMessage || error.message || ""));
  return error?.status === 404 || /site_updates|relation .* does not exist|schema cache/i.test(detail);
}

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

module.exports = { handleAdminUpdates };
module.exports._test = { FIELD_NAMES, STATUSES, UUID_PATTERN, missingUpdatesTable, normalizeDate, normalizeSiteUpdate };
