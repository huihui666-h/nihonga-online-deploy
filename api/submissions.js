const { assertConfig, canonicalInstagramUrl, rateLimit, readBody, sendJson, setCors, supabaseFetch, publicUrl } = require("./_supabase");
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
  if (!rateLimit(req, res, { limit: 10, windowMs: 60_000, keyPrefix: "submissions" })) return;

  if (!requireSameOrigin(req, res)) return;
  if (!assertConfig(res)) return;

  const requestUrl = new URL(req.url || "/api/submissions", "https://local.invalid");
  if (requestUrl.searchParams.get("resource") === "artist") {
    await handlePublicArtistSubmission(req, res);
    return;
  }

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
    const name = boundedText(body.name, 160);
    const instagramInput = boundedText(body.instagram || body.handle, 2048);
    const instagram = instagramInput === null ? "" : normalizeInstagram(instagramInput);
    const handle = instagram ? `@${instagram.split("/").filter(Boolean).pop()}` : "";
    const school = boundedText(body.school, 120);
    const region = boundedText(body.region, 120);
    const note = boundedText(body.note, 5000);

    if (name === null || instagramInput === null || school === null || region === null || note === null) {
      sendJson(res, 400, { ok: false, message: "提交内容超出长度限制。" });
      return;
    }
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
  return canonicalInstagramUrl(value);
}

function boundedText(value, maximum) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length > maximum ? null : text;
}

async function handlePublicArtistSubmission(req, res) {
  if (!rateLimit(req, res, { limit: 5, windowMs: 60_000, keyPrefix: "artist-submission-public" })) return;
  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, message: "请求内容不正确。" });
      return;
    }
    const fields = {
      name: boundedText(body.name, 160),
      romanName: boundedText(body.romanName || body.roman_name, 160),
      officialWebsite: boundedUrl(body.officialWebsite || body.official_website),
      instagram: boundedInstagram(body.instagram),
      affiliation: boundedText(body.affiliation, 120),
      background: boundedText(body.background, 200),
      region: boundedText(body.region, 120),
      bio: boundedText(body.bio, 1800),
      referenceSource: boundedUrl(body.referenceSource || body.reference_source),
      contact: boundedText(body.contact, 240)
    };
    if (Object.values(fields).some((value) => value === null)) {
      sendJson(res, 400, { ok: false, message: "提交内容超出长度或 URL 格式不正确。" });
      return;
    }
    if (!fields.name || (!fields.officialWebsite && !fields.instagram && !fields.referenceSource)) {
      sendJson(res, 400, { ok: false, message: "请填写作家姓名，并至少提供一个公开来源 URL。" });
      return;
    }

    const instagramHandle = fields.instagram ? fields.instagram.split("/").filter(Boolean).pop() : "";
    const note = [
      fields.affiliation && `所属：${fields.affiliation}`,
      fields.background && `学歴・出身大学：${fields.background}`,
      fields.region && `地区：${fields.region}`,
      fields.bio && `简介：${fields.bio}`,
      fields.officialWebsite && `公式サイト：${fields.officialWebsite}`,
      fields.referenceSource && `参考来源：${fields.referenceSource}`,
      fields.contact && `联系方式：${fields.contact}`
    ].filter(Boolean).join("\n").slice(0, 5000);
    const sourcePage = fields.officialWebsite || fields.referenceSource || fields.instagram;
    const rows = await supabaseFetch("artist_submissions?select=id,status,created_at", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        name: fields.name,
        roman_name: fields.romanName,
        handle: instagramHandle ? `@${instagramHandle}` : "",
        instagram: fields.instagram,
        source_page: sourcePage,
        link_type: fields.officialWebsite ? "website" : fields.instagram ? "instagram" : "reference",
        region: fields.region,
        school: fields.affiliation || fields.background,
        styles: ["日本画"],
        note,
        status: "pending"
      })
    });
    sendJson(res, 201, { ok: true, submission: Array.isArray(rows) ? rows[0] : null });
  } catch (error) {
    sendJson(res, error.status || 500, { ok: false, message: error.message || "提交失败，请稍后再试。" });
  }
}

function boundedUrl(value) {
  const text = boundedText(value, 2048);
  if (text === null || !text) return text;
  return publicUrl(text) || null;
}

function boundedInstagram(value) {
  const raw = boundedText(value, 2048);
  if (raw === null || !raw) return raw;
  const normalized = normalizeInstagram(raw);
  return /^https:\/\/www\.instagram\.com\/[A-Za-z0-9_.]+\/$/.test(normalized) ? normalized : null;
}
