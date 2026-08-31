const {
  assertConfig,
  normalizeLicense,
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
      const rows = await supabaseFetch("licenses?select=*&order=created_at.desc");
      sendJson(res, 200, { ok: true, licenses: rows });
      return;
    }

    if (req.method === "POST") {
      const card = normalizeLicense(await readBody(req));
      if (!card.key) {
        card.key = makeKey();
      }
      const rows = await supabaseFetch("licenses?select=*", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(card)
      });
      sendJson(res, 200, { ok: true, license: rows[0] });
      return;
    }

    if (req.method === "PATCH") {
      const key = new URL(req.url, "http://localhost").searchParams.get("key");
      if (!key) {
        sendJson(res, 400, { ok: false, message: "缺少卡密。" });
        return;
      }
      const card = normalizeLicense(await readBody(req));
      delete card.key;
      const rows = await supabaseFetch(`licenses?key=eq.${encodeURIComponent(key)}&select=*`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(card)
      });
      sendJson(res, 200, { ok: true, license: rows[0] });
      return;
    }

    if (req.method === "DELETE") {
      const key = new URL(req.url, "http://localhost").searchParams.get("key");
      if (!key) {
        sendJson(res, 400, { ok: false, message: "缺少卡密。" });
        return;
      }
      await supabaseFetch(`licenses?key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { ok: false, message: "方法不支持。" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "后台卡密管理失败。"
    });
  }
};

function makeKey() {
  const { randomBytes } = require("crypto");
  const hex = randomBytes(6).toString("hex").toUpperCase();
  return `NIHONGA-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
