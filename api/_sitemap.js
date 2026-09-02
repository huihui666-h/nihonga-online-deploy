const { setCors, supabaseFetch } = require("./_supabase");
const { loadPublicArtists, slugForArtist, escapeHtml } = require("./_artist-utils");
const { newsSlug } = require("./_news-utils");

const SITE_ORIGIN = String(process.env.PUBLIC_SITE_URL || "https://nihonga-online-deploy.vercel.app").replace(/\/$/, "");

async function handleSitemap(req, res) {
  setCors(res);
  if (req.method !== "GET") { res.statusCode = 405; res.end("Method Not Allowed"); return; }
  try {
    const { rows, slugMap } = await loadPublicArtists();
    let news = [];
    try { const rows = await supabaseFetch("news?status=eq.published&category=neq.new_artist&select=id,title,published_at,created_at&limit=1000&order=published_at.desc,created_at.desc"); news = Array.isArray(rows) ? rows : []; } catch { news = []; }
    const urls = [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/news`, ...rows.map((row) => `${SITE_ORIGIN}/artists/${encodeURIComponent(slugForArtist(row, slugMap))}`), ...news.map((row) => `${SITE_ORIGIN}/news/${encodeURIComponent(newsSlug(row))}`)];
    const unique = [...new Set(urls)];
    const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${unique.map((url) => `<url><loc>${escapeHtml(url)}</loc></url>`).join("")}</urlset>`;
    res.statusCode = 200; res.setHeader("Content-Type", "application/xml; charset=utf-8"); res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600"); res.end(body);
  } catch {
    res.statusCode = 503; res.setHeader("Content-Type", "application/xml; charset=utf-8"); res.end("<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"></urlset>");
  }
}

module.exports = { handleSitemap };
