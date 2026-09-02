const { assertConfig, rateLimit, readBody, sendJson, setCors, supabaseFetch, publicUrl } = require("./_supabase");
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
  if (!rateLimit(req, res, { limit: 10, windowMs: 60_000, keyPrefix: "report-correction" })) return;

  if (!requireSameOrigin(req, res)) return;
  if (!assertConfig(res)) return;

  try {
    const current = await getSessionUser(req);
    if (!current) {
      sendAuthJson(res, 401, { ok: false, message: "请登录后使用此功能。" });
      return;
    }

    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, message: "请求内容不正确。" });
      return;
    }
    const artistId = boundedText(body.artistId, 100);
    const artistName = boundedText(body.artistName, 160);
    const note = boundedText(body.note, 5000);
    const field = boundedText(body.field, 80);
    const correctedValue = boundedText(body.correctedValue, 1000);
    const referenceUrl = boundedUrl(body.referenceUrl || body.reference_url);
    const contact = boundedText(body.contact, 240);

    if (artistId === null || artistName === null || note === null || field === null || correctedValue === null || referenceUrl === null || contact === null) {
      sendJson(res, 400, { ok: false, message: "提交内容超出长度限制。" });
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(artistId) || !note) {
      sendJson(res, 400, { ok: false, message: "请选择画家并填写修改说明。" });
      return;
    }

    const details = [
      field && `修改项目：${field}`,
      correctedValue && `修改后的内容：${correctedValue}`,
      referenceUrl && `参考来源：${referenceUrl}`,
      contact && `联系方式：${contact}`,
      `说明：${note}`
    ].filter(Boolean).join("\n").slice(0, 5000);
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
        note: details,
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

function boundedText(value, maximum) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length > maximum ? null : text;
}

function boundedUrl(value) {
  const text = boundedText(value, 2048);
  if (text === null || !text) return text;
  return publicUrl(text) || null;
}
