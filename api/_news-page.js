const { rateLimit, sendJson, setCors, supabaseFetch } = require("./_supabase");
const { renderNewsPage, newsSlug } = require("./_news-utils");
const { text } = require("./_artist-utils");

const SITE_ORIGIN = String(process.env.PUBLIC_SITE_URL || "https://nihonga-online-deploy.vercel.app").replace(/\/$/, "");

async function handleNewsPage(req, res, requestUrl) {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (!rateLimit(req, res, { limit: 120, windowMs: 60_000, keyPrefix: "news-page" })) return;
  if (req.method !== "GET") { sendJson(res, 405, { ok: false, message: "方法不支持。" }); return; }
  const slug = text((requestUrl || new URL(req.url || "/api/news-page", "https://local.invalid")).searchParams.get("slug"));
  if (!slug || slug.length > 120) { sendHtml(res, 404, "<h1>ニュースが見つかりません。</h1>"); return; }
  try {
    const rows = await supabaseFetch("news?status=eq.published&category=neq.new_artist&select=*&limit=1000&order=published_at.desc,created_at.desc");
    const row = (Array.isArray(rows) ? rows : []).find((item) => newsSlug(item) === slug);
    if (!row) { sendHtml(res, 404, "<h1>ニュースが見つかりません。</h1>"); return; }
    sendHtml(res, 200, renderNewsPage(row, `${SITE_ORIGIN}/news/${encodeURIComponent(slug)}`));
  } catch {
    sendHtml(res, 503, "<h1>ニュースを読み込めませんでした。</h1>");
  }
}

function sendHtml(res, status, body) {
  setCors(res); res.statusCode = status; res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", status === 200 ? "public, s-maxage=300, stale-while-revalidate=600" : "no-store");
  const output = String(body).trim().toLowerCase().startsWith("<!doctype") ? body : `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css?v=6"><link rel="stylesheet" href="/artist-page.css?v=1"><title>NIHONGA NOW｜NIHONGA INDEX</title></head><body class="artist-page">${body}</body></html>`;
  res.end(output);
}

module.exports = { handleNewsPage, sendHtml };
