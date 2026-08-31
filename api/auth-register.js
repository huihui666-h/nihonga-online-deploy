const {
  assertConfig,
  readBody,
  sendJson,
  setCors,
  supabaseFetch
} = require("./_supabase");
const {
  authTableError,
  createSession,
  findUserByEmail,
  hashPassword,
  normalizeDisplayName,
  normalizeEmail,
  publicUser,
  requireSameOrigin,
  sendAuthJson,
  setSessionCookie,
  validatePassword
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
  if (!requireSameOrigin(req, res)) return;
  if (!assertConfig(res)) return;

  try {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const displayName = normalizeDisplayName(body.displayName || body.display_name || body.name);
    const passwordError = validatePassword(password);

    if (!email) {
      sendAuthJson(res, 400, { ok: false, message: "请输入有效的邮箱地址。" });
      return;
    }
    if (passwordError) {
      sendAuthJson(res, 400, { ok: false, message: passwordError });
      return;
    }
    if (body.confirmPassword !== undefined && String(body.confirmPassword) !== password) {
      sendAuthJson(res, 400, { ok: false, message: "两次输入的密码不一致。" });
      return;
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      sendAuthJson(res, 409, { ok: false, message: "该邮箱已注册，请直接登录。" });
      return;
    }

    const passwordHash = await hashPassword(password);
    let rows;
    try {
      rows = await supabaseFetch("site_users?select=*", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          email,
          password_hash: passwordHash,
          display_name: displayName,
          status: "active"
        })
      });
    } catch (error) {
      const normalized = authTableError(error);
      if (isDuplicateError(normalized)) {
        sendAuthJson(res, 409, { ok: false, message: "该邮箱已注册，请直接登录。" });
        return;
      }
      throw normalized;
    }

    const user = Array.isArray(rows) ? rows[0] : null;
    if (!user || !user.id) {
      sendAuthJson(res, 500, { ok: false, message: "注册失败，请稍后再试。" });
      return;
    }

    const session = await createSession(req, user.id, body.remember !== false);
    setSessionCookie(req, res, session.token, session.maxAge);
    sendAuthJson(res, 201, {
      ok: true,
      message: "注册成功，已登录。",
      user: publicUser(user),
      session: { expiresAt: session.expiresAt },
      requiresEmailVerification: false
    });
  } catch (error) {
    const normalized = authTableError(error);
    sendAuthJson(res, normalized.status || 500, {
      ok: false,
      message: normalized.message || "注册失败，请稍后再试。"
    });
  }
};

function isDuplicateError(error) {
  return Boolean(
    error && (
      error.status === 409 ||
      (error.data && error.data.code === "23505") ||
      /duplicate key|unique constraint/i.test(String(error.message || ""))
    )
  );
}
