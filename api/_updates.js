const { sendJson, supabaseFetch } = require("./_supabase");

function integer(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

function rowToUpdate(row) {
  return {
    id: row.id,
    title: row.title || "",
    body: row.body || "",
    publishedOn: row.published_on || "",
    updatedAt: row.updated_at || row.created_at || ""
  };
}

async function handleUpdates(req, res, requestUrl) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }

  const url = requestUrl || new URL(req.url || "/api/artists?resource=updates", "https://local.invalid");
  const limit = integer(url.searchParams.get("limit"), 3, 10);

  // Keep the static homepage records visible in local previews and during the
  // short rollout window before the optional migration is installed.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(res, 200, { ok: true, updates: [], limit, fallback: true });
    return;
  }

  try {
    const rows = await supabaseFetch(
      `site_updates?status=eq.published&select=id,title,body,published_on,created_at,updated_at&order=published_on.desc,created_at.desc&limit=${limit}`
    );
    sendJson(res, 200, {
      ok: true,
      updates: (Array.isArray(rows) ? rows : []).map(rowToUpdate),
      limit
    });
  } catch {
    sendJson(res, 503, {
      ok: false,
      updates: [],
      limit,
      fallback: true,
      message: "更新記録を読み込めませんでした。"
    });
  }
}

module.exports = { handleUpdates };
module.exports._test = { integer, rowToUpdate };
