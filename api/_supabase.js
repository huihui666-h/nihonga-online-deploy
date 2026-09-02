const { timingSafeEqual } = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_BODY_BYTES = 64 * 1024;
const rateBuckets = new Map();

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function setCors(res) {
  // The browser app uses same-origin requests. Do not advertise a wildcard
  // origin or broad credentialed CORS policy for the service-role-backed API.
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}

function sendJson(res, status, payload) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(payload));
}

function clientAddress(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const direct = String(req?.headers?.["x-real-ip"] || req?.socket?.remoteAddress || "").trim();
  return (forwarded || direct || "unknown").slice(0, 64);
}

function rateLimit(req, res, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 60;
  const windowMs = Number.isInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : 60_000;
  const prefix = String(options.keyPrefix || "api").slice(0, 40);
  const key = `${prefix}:${clientAddress(req)}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  // Opportunistically discard expired buckets so a long-lived warm instance
  // cannot grow without bound.
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }

  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    sendJson(res, 429, { ok: false, message: "请求过于频繁，请稍后再试。" });
    return false;
  }
  return true;
}

function assertConfig(res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(res, 500, {
      ok: false,
      message: "服务器尚未配置数据服务。"
    });
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  // Allow authenticated crawler batches while keeping the endpoint bounded;
  // failed credentials get a much tighter secondary bucket below.
  if (!rateLimit(req, res, { limit: 120, windowMs: 60_000, keyPrefix: "admin" })) return false;
  if (!ADMIN_PASSWORD) {
    sendJson(res, 500, { ok: false, message: "服务器尚未配置管理员认证。" });
    return false;
  }

  const password = String(req.headers["x-admin-password"] || "");
  const supplied = Buffer.from(password);
  const expected = Buffer.from(String(ADMIN_PASSWORD));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    if (!rateLimit(req, res, { limit: 10, windowMs: 60_000, keyPrefix: "admin-failed" })) return false;
    sendJson(res, 401, { ok: false, message: "管理员密码不正确。" });
    return false;
  }

  return true;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data, "utf8") > MAX_BODY_BYTES) {
        const error = new Error("请求内容太大。");
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        const parseError = new Error("JSON 格式不正确。");
        parseError.status = 400;
        reject(parseError);
      }
    });
    req.on("error", reject);
  });
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = data && data.message ? data.message : "Supabase 请求失败。";
    const error = new Error("上游数据服务请求失败。");
    error.status = response.status;
    error.data = data;
    error.upstreamMessage = String(message).slice(0, 500);
    throw error;
  }

  return data;
}

function canonicalInstagramHandle(value) {
  const text = normalizeText(value);
  if (!text) return "";

  let handle = text;
  try {
    const candidate = /^(?:https?:)?\/\//i.test(text)
      ? (text.startsWith("//") ? `https:${text}` : text)
      : `https://${text}`;
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "instagram.com" || hostname === "www.instagram.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0]?.toLowerCase() === "_u") segments.shift();
      if (segments.length !== 1) return "";
      handle = segments[0];
    } else if (/instagram\.com(?:\/|$)/i.test(text)) {
      return "";
    }
  } catch {
    if (/instagram\.com(?:\/|$)/i.test(text)) return "";
    handle = text;
  }

  handle = normalizeText(handle).replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) return "";
  if (["http", "https", "www", "instagram", "instagram.com", "accounts", "about", "challenge", "direct", "developer", "directory", "emails", "explore", "p", "reel", "reels", "stories", "tags", "locations", "hashtag", "tv", "privacy", "legal"].includes(handle)) return "";
  return handle;
}

function canonicalInstagramUrl(value) {
  const handle = canonicalInstagramHandle(value);
  return handle ? `https://www.instagram.com/${handle}/` : "";
}

function publicUrl(value, maximum = 2048) {
  const text = normalizeText(value);
  if (!text || text.length > maximum) return "";
  try {
    const url = new URL(text);
    if (!/^https?:$/i.test(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function bounded(value, maximum) {
  return normalizeText(value).slice(0, maximum);
}

function normalizeArtist(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const styles = Array.isArray(source.styles)
    ? source.styles.map((value) => bounded(value, 80)).filter(Boolean).slice(0, 30)
    : normalizeText(source.styles)
      .split(/[,，、\n]/)
      .map((value) => bounded(value, 80))
      .filter(Boolean);
  const handle = canonicalInstagramHandle(source.handle) || canonicalInstagramHandle(source.instagram);
  const instagram = canonicalInstagramUrl(handle);

  return {
    name: bounded(source.name, 160),
    roman_name: bounded(source.roman_name || source.romanName, 160),
    handle: handle ? `@${handle}` : "",
    instagram,
    source_page: publicUrl(source.source_page || source.sourcePage) || instagram,
    link_type: handle ? "instagram" : (/^[a-z0-9_-]{1,40}$/i.test(normalizeText(source.link_type || source.linkType || "")) ? normalizeText(source.link_type || source.linkType) : "instagram"),
    region: bounded(source.region, 120),
    school: bounded(source.school, 120),
    styles,
    note: bounded(source.note, 5000)
  };
}

async function findArtistDuplicate(artist, excludeId = "") {
  const handle = canonicalInstagramHandle(artist.handle) || canonicalInstagramHandle(artist.instagram);

  // PostgREST deployments commonly cap a response at 1,000 rows even when a
  // larger `limit` is requested. Walk pages so duplicate checks remain valid
  // as the directory grows beyond that cap.
  const pageSize = 1000;
  if (handle) {
    for (let offset = 0; offset < 100000; offset += pageSize) {
      const rows = await supabaseFetch(
        `artists?select=id,name,handle,instagram&limit=${pageSize}&offset=${offset}`
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const duplicate = rows.find((row) => {
        if (excludeId && row.id === excludeId) return false;
        return canonicalInstagramHandle(row.handle) === handle || canonicalInstagramHandle(row.instagram) === handle;
      });
      if (duplicate) return duplicate;
      if (rows.length < pageSize) return null;
    }
    return null;
  }

  // School and other public-source records may not have an Instagram handle.
  // Their stable identity is the normalized public name plus school; when a
  // school value is unavailable, use the exact source page with the name.
  const name = normalizeText(artist.name);
  const school = normalizeText(artist.school);
  const sourcePage = normalizeText(artist.source_page);
  if (!name || (!school && !sourcePage)) return null;
  const filters = [`name=eq.${encodeURIComponent(name)}`];
  if (school) filters.push(`school=eq.${encodeURIComponent(school)}`);
  else filters.push(`source_page=eq.${encodeURIComponent(sourcePage)}`);
  const rows = await supabaseFetch(
    `artists?select=id,name,handle,instagram,source_page,school&${filters.join("&")}&limit=${pageSize}`
  );
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => !excludeId || row.id !== excludeId) || null;
}

module.exports = {
  assertConfig,
  canonicalInstagramHandle,
  canonicalInstagramUrl,
  publicUrl,
  findArtistDuplicate,
  normalizeArtist,
  readBody,
  requireAdmin,
  sendJson,
  setCors,
  supabaseFetch,
  rateLimit,
  clientAddress
};
