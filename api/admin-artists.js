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

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!assertConfig(res) || !requireAdmin(req, res)) return;

  try {
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
