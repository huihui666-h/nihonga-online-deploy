const {
  assertConfig,
  rateLimit,
  sendJson,
  setCors
} = require("./_supabase");
const {
  authTableError,
  getSessionUser,
  publicUser,
  sendAuthJson
} = require("./_auth");

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
  if (!rateLimit(req, res, { limit: 60, windowMs: 60_000, keyPrefix: "auth-session" })) return;
  if (!assertConfig(res)) return;

  try {
    const current = await getSessionUser(req);
    if (!current) {
      sendAuthJson(res, 200, { ok: true, authenticated: false, user: null });
      return;
    }
    sendAuthJson(res, 200, {
      ok: true,
      authenticated: true,
      user: publicUser(current.user),
      session: { expiresAt: current.session.expires_at }
    });
  } catch (error) {
    const normalized = authTableError(error);
    sendAuthJson(res, normalized.status || 500, {
      ok: false,
      message: normalized.message || "读取登录状态失败，请稍后再试。"
    });
  }
};
