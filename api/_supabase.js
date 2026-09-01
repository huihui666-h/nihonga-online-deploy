const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password, Idempotency-Key, X-Idempotency-Key");
  // The browser app calls same-origin API routes. Omitting a wildcard origin
  // prevents credentialed cross-origin requests from gaining access later.
}

function sendJson(res, status, payload) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function assertConfig(res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    sendJson(res, 500, {
      ok: false,
      message: "服务器还没有配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。"
    });
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  if (!ADMIN_PASSWORD) {
    sendJson(res, 500, { ok: false, message: "服务器还没有配置 ADMIN_PASSWORD。" });
    return false;
  }

  const password = req.headers["x-admin-password"];
  if (password !== ADMIN_PASSWORD) {
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
      if (data.length > 1_000_000) {
        reject(new Error("请求内容太大。"));
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
        reject(new Error("JSON 格式不正确。"));
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
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
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
  if (["accounts", "about", "challenge", "direct", "developer", "directory", "emails", "explore", "p", "reel", "reels", "stories", "tags", "locations", "hashtag", "tv", "privacy", "legal"].includes(handle)) return "";
  return handle;
}

function canonicalInstagramUrl(value) {
  const handle = canonicalInstagramHandle(value);
  return handle ? `https://www.instagram.com/${handle}/` : "";
}

function normalizeArtist(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const styles = Array.isArray(source.styles)
    ? source.styles.map(normalizeText).filter(Boolean)
    : normalizeText(source.styles)
      .split(/[,，、\n]/)
      .map(normalizeText)
      .filter(Boolean);
  const handle = canonicalInstagramHandle(source.handle) || canonicalInstagramHandle(source.instagram);
  const instagram = canonicalInstagramUrl(handle) || normalizeText(source.instagram);

  return {
    name: normalizeText(source.name),
    roman_name: normalizeText(source.roman_name || source.romanName),
    handle: handle ? `@${handle}` : normalizeText(source.handle),
    instagram,
    source_page: normalizeText(source.source_page || source.sourcePage) || instagram,
    link_type: handle ? "instagram" : (normalizeText(source.link_type || source.linkType || "instagram") || "instagram"),
    region: normalizeText(source.region),
    school: normalizeText(source.school),
    styles,
    note: normalizeText(source.note)
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
  findArtistDuplicate,
  normalizeArtist,
  readBody,
  requireAdmin,
  sendJson,
  setCors,
  supabaseFetch
};
