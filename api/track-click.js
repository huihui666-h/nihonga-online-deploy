const { assertConfig, rateLimit, readBody, sendJson, setCors, supabaseFetch } = require("./_supabase");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!rateLimit(req, res, { limit: 60, windowMs: 60_000, keyPrefix: "track-click" })) return;

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }

  if (!assertConfig(res)) return;

  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, message: "请求内容不正确。" });
      return;
    }
    const artistId = String(body.artistId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(artistId)) {
      sendJson(res, 400, { ok: false, message: "缺少画家 id。" });
      return;
    }

    await supabaseFetch("artist_clicks", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        artist_id: artistId,
        clicked_on: todayInTokyo()
      })
    });

    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "记录查看量失败。"
    });
  }
};

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
