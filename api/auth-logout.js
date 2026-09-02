const {
  assertConfig,
  rateLimit,
  sendJson,
  setCors
} = require("./_supabase");
const {
  authTableError,
  clearSessionCookie,
  deleteSessionByHash,
  getSessionToken,
  hashSessionToken,
  requireSameOrigin,
  sendAuthJson
} = require("./_auth");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST" && req.method !== "DELETE") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }
  if (!rateLimit(req, res, { limit: 60, windowMs: 60_000, keyPrefix: "auth-logout" })) return;
  if (!requireSameOrigin(req, res)) return;
  if (!assertConfig(res)) return;

  try {
    const token = getSessionToken(req);
    if (token) await deleteSessionByHash(hashSessionToken(token));
    clearSessionCookie(req, res);
    sendAuthJson(res, 200, { ok: true, message: "已退出登录。" });
  } catch (error) {
    const normalized = authTableError(error);
    clearSessionCookie(req, res);
    sendAuthJson(res, normalized.status || 500, {
      ok: false,
      message: normalized.message || "退出登录失败，请稍后再试。"
    });
  }
};
