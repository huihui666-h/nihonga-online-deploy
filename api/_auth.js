const {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual
} = require("crypto");
const { promisify } = require("util");
const {
  sendJson,
  supabaseFetch
} = require("./_supabase");

const scryptAsync = promisify(scrypt);
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SCRYPT_N = 16_384;
const PASSWORD_SCRYPT_R = 8;
const PASSWORD_SCRYPT_P = 1;
const PASSWORD_SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const DEFAULT_SESSION_DAYS = 30;
const SHORT_SESSION_DAYS = 1;
const configuredCookie = String(process.env.AUTH_COOKIE_NAME || "").trim();
const SESSION_COOKIE = /^[A-Za-z0-9_-]{1,50}$/.test(configuredCookie)
  ? configuredCookie
  : "nihonga_session";

/**
 * Keep all user-facing auth values in one shape. Password hashes and other
 * internal columns never leave the API.
 */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || "",
    displayName: row.display_name || "",
    status: row.status || "active",
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.created_at || "",
    lastLoginAt: row.last_login_at || ""
  };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || /[\r\n\s]/.test(email)) return "";

  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1 || at > 64) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain.length > 253 || !domain.includes(".")) return "";
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain)) return "";
  return email;
}

function normalizeDisplayName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function requestOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return "";
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req.headers.host || "").trim();
  if (!host) return origin;
  let proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (!proto) {
    try {
      proto = new URL(origin).protocol.replace(":", "").toLowerCase();
    } catch {
      proto = "https";
    }
  }
  const expected = `${proto === "http" ? "http" : "https"}://${host}`;
  return origin.replace(/\/$/, "") === expected.replace(/\/$/, "") ? origin : "invalid";
}

function requireSameOrigin(req, res) {
  const origin = requestOrigin(req);
  if (origin === "invalid") {
    sendAuthJson(res, 403, { ok: false, message: "请求来源不正确。" });
    return false;
  }
  return true;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8) return "密码至少需要 8 个字符。";
  if (password.length > 128) return "密码不能超过 128 个字符。";
  return "";
}

async function derivePasswordKey(password, salt, n = PASSWORD_SCRYPT_N, r = PASSWORD_SCRYPT_R, p = PASSWORD_SCRYPT_P) {
  const maxmem = Math.max(32 * 1024 * 1024, 128 * n * r + 1024);
  return scryptAsync(String(password), salt, PASSWORD_KEY_LENGTH, {
    N: n,
    r,
    p,
    maxmem
  });
}

async function hashPassword(password) {
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString("base64url");
  const derived = await derivePasswordKey(password, salt);
  return [
    "scrypt",
    PASSWORD_SCRYPT_N,
    PASSWORD_SCRYPT_R,
    PASSWORD_SCRYPT_P,
    salt,
    Buffer.from(derived).toString("base64url")
  ].join("$");
}

async function verifyPassword(password, encoded) {
  try {
    const parts = String(encoded || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = parts[4];
    const expected = Buffer.from(parts[5], "base64url");

    // Only accept sane parameters from the database. This prevents a damaged
    // row from turning a login request into an unbounded CPU/memory request.
    if (!Number.isInteger(n) || n < 1_024 || n > 262_144 || (n & (n - 1)) !== 0) return false;
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 8) return false;
    if (!salt || expected.length !== PASSWORD_KEY_LENGTH) return false;

    const actual = Buffer.from(await derivePasswordKey(password, salt, n, r, p));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function readCookies(req) {
  const header = String(req.headers.cookie || "");
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function getSessionToken(req) {
  const cookies = readCookies(req);
  const cookieToken = cookies[SESSION_COOKIE];
  if (cookieToken && /^[A-Za-z0-9_-]{40,200}$/.test(cookieToken)) return cookieToken;

  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{40,200})$/i);
  return match ? match[1] : "";
}

function cookieSecure(req) {
  return process.env.NODE_ENV === "production" || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
}

function setSessionCookie(req, res, token, maxAge) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (Number.isFinite(maxAge)) attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (cookieSecure(req)) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(req, res) {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];
  if (cookieSecure(req)) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function sessionDays(remember) {
  const configured = Number.parseInt(process.env.AUTH_SESSION_DAYS || "", 10);
  const longDays = Number.isInteger(configured) && configured >= 1 && configured <= 365
    ? configured
    : DEFAULT_SESSION_DAYS;
  return remember === false ? SHORT_SESSION_DAYS : longDays;
}

function clientMetadata(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = (forwarded || String(req.headers["x-real-ip"] || "").trim()).slice(0, 64);
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 500);
  return { ip, userAgent };
}

function authTableError(error) {
  const text = String(error && (error.message || error.details || ""));
  if (error && (error.status === 404 || /site_users|site_sessions|relation .* does not exist/i.test(text))) {
    const wrapped = new Error("认证数据库尚未初始化，请先在 Supabase SQL Editor 执行 auth migration。");
    wrapped.status = 503;
    return wrapped;
  }
  return error;
}

function sendAuthJson(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, status, payload);
}

async function findUserByEmail(email) {
  try {
    const rows = await supabaseFetch(`site_users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    throw authTableError(error);
  }
}

async function findUserById(id) {
  try {
    const rows = await supabaseFetch(`site_users?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    throw authTableError(error);
  }
}

async function createSession(req, userId, remember = true) {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const days = sessionDays(remember);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const metadata = clientMetadata(req);
  try {
    const rows = await supabaseFetch("site_sessions?select=id,expires_at", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        user_agent: metadata.userAgent || null,
        ip_address: metadata.ip || null
      })
    });
    return {
      token,
      expiresAt: rows && rows[0] && rows[0].expires_at ? rows[0].expires_at : expiresAt,
      maxAge: remember === false ? null : days * 24 * 60 * 60
    };
  } catch (error) {
    throw authTableError(error);
  }
}

async function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  let session;
  try {
    const rows = await supabaseFetch(`site_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}&select=id,user_id,expires_at&limit=1`);
    session = Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    throw authTableError(error);
  }
  if (!session) return null;

  const expiry = new Date(session.expires_at || 0);
  if (!session.expires_at || Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
    await deleteSessionByHash(tokenHash);
    return null;
  }

  const user = await findUserById(session.user_id);
  if (!user || user.status !== "active") return null;

  try {
    await supabaseFetch(`site_sessions?id=eq.${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ last_seen_at: new Date().toISOString() })
    });
  } catch {
    // A last-seen timestamp is observability only; it must not log a valid
    // user out if a transient write fails.
  }

  return { user, session, token };
}

async function deleteSessionByHash(tokenHash) {
  if (!tokenHash) return;
  try {
    await supabaseFetch(`site_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}`, { method: "DELETE" });
  } catch (error) {
    throw authTableError(error);
  }
}

async function updateLastLogin(userId) {
  try {
    await supabaseFetch(`site_users?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    });
  } catch (error) {
    throw authTableError(error);
  }
}

module.exports = {
  SESSION_COOKIE,
  authTableError,
  clearSessionCookie,
  createSession,
  deleteSessionByHash,
  findUserByEmail,
  getSessionToken,
  getSessionUser,
  hashPassword,
  hashSessionToken,
  normalizeDisplayName,
  normalizeEmail,
  publicUser,
  requireSameOrigin,
  setSessionCookie,
  sessionDays,
  sendAuthJson,
  updateLastLogin,
  validatePassword,
  verifyPassword
};
