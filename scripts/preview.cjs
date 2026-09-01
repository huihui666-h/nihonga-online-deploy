/* Local read-only preview. Never forwards cookies, auth, or mutation requests. */
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "../public");
const origin = "https://nihonga-online-deploy.vercel.app";
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] || process.env.PREVIEW_PORT || 4173);
const offline = process.argv.includes("--offline");
// Optional, explicitly labelled local UI fixture. Never touches the real auth APIs.
const demoMember = process.argv.includes("--demo-member");
const cache = new Map();
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
function json(res, status, value) { res.writeHead(status, { "Content-Type": types[".json"], "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
async function readArtists() {
  return JSON.parse(await fs.readFile(path.resolve(__dirname, "../imports/existing-artists.json"), "utf8"));
}
async function readNews() {
  try {
    const report = JSON.parse(await fs.readFile(path.resolve(__dirname, "../imports/news-candidates.json"), "utf8"));
    const news = (Array.isArray(report.items) ? report.items : [])
      .filter((item) => item && item.status === "published")
      .map((item) => ({
        id: item.id || item.source_item_id || item.source_url,
        title: item.title || "",
        summary: item.summary || "",
        category: item.category || "nihonga_news",
        sourceName: item.source_name || "",
        sourceUrl: item.source_url || "",
        publishedAt: item.published_at || "",
        startDate: item.start_date || "",
        endDate: item.end_date || "",
        venue: item.venue || "",
        artistNames: Array.isArray(item.raw_artist_names) ? item.raw_artist_names : [],
        relatedArtists: []
      }));
    return { ok: true, news };
  } catch {
    return { ok: true, news: [] };
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!["GET", "HEAD"].includes(req.method)) {
      // Consume without logging; no password, form content, or personal data is saved.
      req.resume();
      json(res, 403, { ok: false, message: "本地只读预览：此操作未发送，未更改线上数据。Read-only preview: no data was sent or saved." });
      return;
    }
    if (url.pathname === "/api/auth-session") {
      json(res, 200, demoMember ? { ok: true, authenticated: true, user: { id: "local-demo-member", displayName: "DEMO", status: "active" } } : { ok: true, authenticated: false, user: null }); return;
    }
    if (["/api/artists", "/api/rankings", "/api/news"].includes(url.pathname)) {
      let data = cache.get(url.pathname);
      if (!data || Date.now() - data.time > 60000) {
        let payload;
        try {
          if (offline) throw new Error("Offline snapshot");
          const response = await fetch(`${origin}${url.pathname}`, { signal: AbortSignal.timeout(12000) });
          if (!response.ok) throw new Error("Live data unavailable");
          payload = await response.json();
          if (!payload.ok) throw new Error("Live data unavailable");
          console.log(`Read-only preview: ${url.pathname} loaded from live public API.`);
        } catch {
          payload = url.pathname === "/api/artists" ? await readArtists() : url.pathname === "/api/news" ? await readNews() : { ok: true, rankings: [] };
          console.log(`Read-only preview: ${url.pathname} uses supplied archive snapshot; addition dates are not fabricated.`);
        }
        data = { time: Date.now(), payload };
        cache.set(url.pathname, data);
      }
      json(res, 200, data.payload); return;
    }
    if (url.pathname.startsWith("/api/")) { json(res, 404, { ok: false, message: "Not available in local preview." }); return; }
    const relative = url.pathname === "/" ? "index.html" : url.pathname === "/admin" ? "admin.html" : url.pathname === "/news" ? "news.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    let content = await fs.readFile(file);
    if (relative === "index.html") {
      content = content.toString("utf8").replace('<body class="index-page">', '<body class="index-page"><div role="note" data-i18n="previewNotice" style="padding:7px 16px;text-align:center;background:#e6ebdd;color:#536149;font:11px/1.5 Arial,sans-serif">本地只读预览 · 不写入线上数据 / Read-only local preview · No production writes</div>');
      if (demoMember) content = content.replace('data-i18n="previewNotice"', 'data-i18n="demoMemberNotice"');
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch { res.writeHead(404); res.end("Not found"); }
});
server.listen(port, "127.0.0.1", () => console.log(`NIHONGA read-only preview: http://127.0.0.1:${port}`));
