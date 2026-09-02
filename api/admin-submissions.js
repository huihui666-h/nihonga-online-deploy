const {
  assertConfig,
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
      const rows = await supabaseFetch("artist_submissions?select=*&order=created_at.desc");
      sendJson(res, 200, { ok: true, submissions: rows });
      return;
    }

    if (req.method === "PATCH") {
      const url = new URL(req.url, "http://localhost");
      const id = url.searchParams.get("id");
      const action = url.searchParams.get("action");
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id || "")) || !action) {
        sendJson(res, 400, { ok: false, message: "缺少投稿 id 或操作。" });
        return;
      }

      if (action === "approve") {
        const submission = await getSubmission(id);
        if (!submission) {
          sendJson(res, 404, { ok: false, message: "投稿不存在。" });
          return;
        }

        const artist = normalizeArtist({
          name: submission.name,
          roman_name: submission.roman_name,
          handle: submission.handle,
          instagram: submission.instagram,
          source_page: submission.source_page || submission.instagram,
          link_type: submission.link_type || "instagram",
          region: submission.region,
          school: submission.school,
          styles: submission.styles,
          note: submission.note ? `用户投稿：${submission.note}` : "用户投稿，经后台审核通过。"
        });

        const created = await supabaseFetch("artists?select=*", {
          method: "POST",
          headers: { prefer: "return=representation" },
          body: JSON.stringify(artist)
        });

        const updated = await updateSubmission(id, {
          status: "approved",
          reviewed_at: new Date().toISOString(),
          approved_artist_id: created[0].id
        });

        sendJson(res, 200, { ok: true, submission: updated, artist: created[0] });
        return;
      }

      if (action === "reject") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || String(body.reviewNote || "").length > 5000) {
          sendJson(res, 400, { ok: false, message: "审核备注内容不正确。" });
          return;
        }
        const updated = await updateSubmission(id, {
          status: "rejected",
          reviewed_at: new Date().toISOString(),
          review_note: String(body.reviewNote || "").trim()
        });
        sendJson(res, 200, { ok: true, submission: updated });
        return;
      }

      sendJson(res, 400, { ok: false, message: "不支持的审核操作。" });
      return;
    }

    if (req.method === "DELETE") {
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id || ""))) {
        sendJson(res, 400, { ok: false, message: "缺少投稿 id。" });
        return;
      }
      await supabaseFetch(`artist_submissions?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { ok: false, message: "方法不支持。" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "后台投稿管理失败。"
    });
  }
};

async function getSubmission(id) {
  const rows = await supabaseFetch(`artist_submissions?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function updateSubmission(id, payload) {
  const rows = await supabaseFetch(`artist_submissions?id=eq.${encodeURIComponent(id)}&select=*`, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify(payload)
  });
  return rows[0];
}
