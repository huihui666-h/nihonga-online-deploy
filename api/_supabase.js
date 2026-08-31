const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
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

function normalizeArtist(input) {
  const styles = Array.isArray(input.styles)
    ? input.styles
    : String(input.styles || "")
      .split(/[,，、\n]/)
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    name: String(input.name || "").trim(),
    roman_name: String(input.roman_name || input.romanName || "").trim(),
    handle: String(input.handle || "").trim(),
    instagram: String(input.instagram || "").trim(),
    source_page: String(input.source_page || input.sourcePage || "").trim(),
    link_type: String(input.link_type || input.linkType || "instagram").trim() || "instagram",
    region: String(input.region || "").trim(),
    school: String(input.school || "").trim(),
    styles,
    note: String(input.note || "").trim()
  };
}

function canonicalInstagramHandle(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  let handle = text;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.hostname.toLowerCase().endsWith("instagram.com")) {
      handle = url.pathname.split("/").filter(Boolean)[0] || "";
    }
  } catch {
    handle = text;
  }

  handle = handle.replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) return "";
  if (["accounts", "about", "direct", "explore", "p", "reels", "stories"].includes(handle)) return "";
  return handle;
}

async function findArtistDuplicate(artist, excludeId = "") {
  const handle = canonicalInstagramHandle(artist.handle) || canonicalInstagramHandle(artist.instagram);
  if (!handle) return null;

  const rows = await supabaseFetch("artists?select=id,name,handle,instagram&limit=10000");
  return rows.find((row) => {
    if (excludeId && row.id === excludeId) return false;
    return canonicalInstagramHandle(row.handle) === handle || canonicalInstagramHandle(row.instagram) === handle;
  }) || null;
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
