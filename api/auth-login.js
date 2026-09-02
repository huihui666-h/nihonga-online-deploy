const {
  assertConfig,
  readBody,
  rateLimit,
  sendJson,
  setCors
} = require("./_supabase");
const {
  authTableError,
  createSession,
  findUserByEmail,
  normalizeEmail,
  publicUser,
  requireSameOrigin,
  sendAuthJson,
  setSessionCookie,
  updateLastLogin,
  validatePassword,
  verifyPassword
} = require("./_auth");

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
  if (!rateLimit(req, res, { limit: 10, windowMs: 60_000, keyPrefix: "auth-login" })) return;
  if (!requireSameOrigin(req, res)) return;
  if (!assertConfig(res)) return;

  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendAuthJson(res, 400, { ok: false, message: "请求内容不正确。" });
      return;
    }
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    if (!email || validatePassword(password)) {
      sendAuthJson(res, 401, { ok: false, message: "邮箱或密码不正确。" });
      return;
    }

    const user = await findUserByEmail(email);
    // Keep unknown-email and wrong-password responses identical.
    if (!user || user.status !== "active" || !(await verifyPassword(password, user.password_hash))) {
      sendAuthJson(res, 401, { ok: false, message: "邮箱或密码不正确。" });
      return;
    }

    const session = await createSession(req, user.id, body.remember !== false);
    await updateLastLogin(user.id);
    setSessionCookie(req, res, session.token, session.maxAge);
    sendAuthJson(res, 200, {
      ok: true,
      message: "登录成功。",
      user: publicUser(user),
      session: { expiresAt: session.expiresAt }
    });
  } catch (error) {
    const normalized = authTableError(error);
    sendAuthJson(res, normalized.status || 500, {
      ok: false,
      message: normalized.message || "登录失败，请稍后再试。"
    });
  }
};
