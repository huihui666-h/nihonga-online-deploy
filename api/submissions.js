const { assertConfig, readBody, sendJson, setCors, supabaseFetch } = require("./_supabase");

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

  if (!assertConfig(res)) return;

  try {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const instagram = normalizeInstagram(body.instagram || body.handle || "");
    const handle = instagram ? `@${instagram.split("/").filter(Boolean).pop()}` : "";
    const school = String(body.school || "").trim();
    const region = String(body.region || "").trim();
    const note = String(body.note || "").trim();

    if (!name || !instagram) {
      sendJson(res, 400, { ok: false, message: "请填写画家名称和 Instagram。" });
      return;
    }

    if (!/^https:\/\/www\.instagram\.com\/[A-Za-z0-9_.]+\/?$/.test(instagram)) {
      sendJson(res, 400, { ok: false, message: "Instagram 链接格式不正确。" });
      return;
    }

    const styles = ["日本画"];
    if (school) styles.push(school);

    const rows = await supabaseFetch("artist_submissions?select=*", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        name,
        roman_name: "",
        handle,
        instagram,
        source_page: instagram,
        link_type: "instagram",
        region,
        school,
        styles,
        note,
        status: "pending"
      })
    });

    sendJson(res, 200, { ok: true, submission: rows[0] });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "提交失败，请稍后再试。"
    });
  }
};

function normalizeInstagram(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  const handle = match ? match[1] : text.replace(/^@/, "");
  return `https://www.instagram.com/${handle.replace(/\/+$/, "")}/`;
}
