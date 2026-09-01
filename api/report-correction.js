const { assertConfig, readBody, sendJson, setCors, supabaseFetch } = require("./_supabase");
const { getSessionUser, requireSameOrigin, sendAuthJson } = require("./_auth");

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
    const current = await getSessionUser(req);
    if (!current) {
      sendAuthJson(res, 401, { ok: false, message: "请登录后使用此功能。" });
      return;
    }

    const body = await readBody(req);
    const artistId = String(body.artistId || "").trim();
    const artistName = String(body.artistName || "").trim();
    const note = String(body.note || "").trim();

    if (!artistId || !note) {
      sendJson(res, 400, { ok: false, message: "请选择画家并填写修改说明。" });
      return;
    }

    const rows = await supabaseFetch("artist_submissions?select=*", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        name: artistName,
        roman_name: "",
        handle: "",
        instagram: artistId,
        source_page: "",
        link_type: "correction",
        region: "",
        school: "",
        styles: [],
        note,
        status: "correction"
      })
    });

    sendJson(res, 200, { ok: true, submission: rows[0] });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "提交修改报告失败，请稍后再试。"
    });
  }
};
