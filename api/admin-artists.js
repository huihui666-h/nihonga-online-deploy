const {
  assertConfig,
  findArtistDuplicate,
  normalizeArtist,
  readBody,
  requireAdmin,
  sendJson,
  setCors,
  supabaseFetch
} = require("./_supabase");
const { publicUser, requireSameOrigin } = require("./_auth");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!assertConfig(res) || !requireAdmin(req, res)) return;

  try {
    const url = new URL(req.url, "http://localhost");
    const resource = url.searchParams.get("resource");
    if (resource === "users") {
      await handleUsers(req, res, url);
      return;
    }
    if (resource && resource !== "artists") {
      sendJson(res, 400, { ok: false, message: "不支持的后台资源。" });
      return;
    }

    if (req.method === "GET") {
      const rows = await supabaseFetch("artists?select=*&order=updated_at.desc");
      sendJson(res, 200, { ok: true, artists: rows });
      return;
    }

    if (req.method === "POST") {
      const artist = normalizeArtist(await readBody(req));
      if (!artist.name || !artist.handle) {
        sendJson(res, 400, { ok: false, message: "画家名称和 IG handle 必填。" });
        return;
      }
      const duplicate = await findArtistDuplicate(artist);
      if (duplicate) {
        sendJson(res, 409, {
          ok: false,
          message: `Instagram 账号已存在：${duplicate.handle || duplicate.instagram || "该账号"}。`,
          duplicate
        });
        return;
      }
      const rows = await supabaseFetch("artists?select=*", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(artist)
      });
      sendJson(res, 200, { ok: true, artist: rows[0] });
      return;
    }

    if (req.method === "PATCH") {
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { ok: false, message: "缺少画家 id。" });
        return;
      }
      const artist = normalizeArtist(await readBody(req));
      if (!artist.name || !artist.handle) {
        sendJson(res, 400, { ok: false, message: "画家名称和 IG handle 必填。" });
        return;
      }
      const duplicate = await findArtistDuplicate(artist, id);
      if (duplicate) {
        sendJson(res, 409, {
          ok: false,
          message: `Instagram 账号已存在：${duplicate.handle || duplicate.instagram || "该账号"}。`,
          duplicate
        });
        return;
      }
      const rows = await supabaseFetch(`artists?id=eq.${encodeURIComponent(id)}&select=*`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(artist)
      });
      sendJson(res, 200, { ok: true, artist: rows[0] });
      return;
    }

    if (req.method === "DELETE") {
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      if (!id) {
        sendJson(res, 400, { ok: false, message: "缺少画家 id。" });
        return;
      }
      await supabaseFetch(`artists?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { ok: false, message: "方法不支持。" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "后台画家管理失败。"
    });
  }
};

async function handleUsers(req, res, url) {
  const select = "id,email,display_name,status,email_verified_at,created_at,last_login_at";
  const listLimit = 1000;
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const rows = await supabaseFetch(`site_users?select=${select}&order=created_at.desc&limit=${listLimit}`);
    sendJson(res, 200, {
      ok: true,
      users: rows.map(publicUser),
      listLimit,
      atLimit: rows.length >= listLimit
    });
    return;
  }

  if (req.method === "PATCH") {
    if (!requireSameOrigin(req, res)) return;
    const id = String(url.searchParams.get("id") || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      sendJson(res, 400, { ok: false, message: "用户 id 不正确。" });
      return;
    }

    const body = await readBody(req);
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some((key) => key !== "status")) {
      sendJson(res, 400, { ok: false, message: "注册用户只允许修改账户状态。" });
      return;
    }
    const status = String(body.status || "").trim();
    if (!new Set(["active", "disabled"]).has(status)) {
      sendJson(res, 400, { ok: false, message: "用户状态只支持 active 或 disabled。" });
      return;
    }

    if (status === "active") {
      await supabaseFetch(`site_sessions?user_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    const rows = await supabaseFetch(`site_users?id=eq.${encodeURIComponent(id)}&select=${select}`, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ status })
    });
    if (!Array.isArray(rows) || !rows[0]) {
      sendJson(res, 404, { ok: false, message: "注册用户不存在。" });
      return;
    }

    if (status === "disabled") {
      await supabaseFetch(`site_sessions?user_id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    }

    sendJson(res, 200, { ok: true, user: publicUser(rows[0]) });
    return;
  }

  sendJson(res, 405, { ok: false, message: "注册用户管理不支持此操作。" });
}
