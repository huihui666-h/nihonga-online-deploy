const { assertConfig, readBody, sendJson, setCors, supabaseFetch } = require("./_supabase");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }

  if (!assertConfig(res)) return;

  try {
    const body = await readBody(req);
    const key = String(body.key || "").trim().toUpperCase();
    if (!key) {
      sendJson(res, 400, { ok: false, message: "请输入验证密码。" });
      return;
    }

    const rows = await supabaseFetch(`licenses?key=eq.${encodeURIComponent(key)}&select=*&limit=1`);
    const card = Array.isArray(rows) ? rows[0] : null;

    if (!card) {
      sendJson(res, 404, { ok: false, message: "密码不正确。" });
      return;
    }

    if (card.status !== "active") {
      sendJson(res, 403, { ok: false, message: "密码已停用。", expiresAt: card.expires_at });
      return;
    }

    if (card.expires_at) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const expiresAt = new Date(`${card.expires_at}T00:00:00`);
      if (Number.isNaN(expiresAt.getTime())) {
        sendJson(res, 500, { ok: false, message: "密码日期格式错误。" });
        return;
      }
      if (expiresAt < today) {
        sendJson(res, 403, { ok: false, message: "密码已过期。", expiresAt: card.expires_at });
        return;
      }
    }

    sendJson(res, 200, {
      ok: true,
      message: `验证成功，有效期至 ${card.expires_at || "长期"}。`,
      expiresAt: card.expires_at || ""
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "验证失败，请稍后再试。"
    });
  }
};
