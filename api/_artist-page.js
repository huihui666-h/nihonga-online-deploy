const { rateLimit, sendJson, setCors } = require("./_supabase");
const { artistSources, escapeHtml, loadPublicArtists, safeHttpUrl, slugForArtist, text } = require("./_artist-utils");

const SITE_ORIGIN = String(process.env.PUBLIC_SITE_URL || "https://nihonga-online-deploy.vercel.app").replace(/\/$/, "");

async function handleArtistPage(req, res, requestUrl) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (!rateLimit(req, res, { limit: 120, windowMs: 60_000, keyPrefix: "artist-page" })) return;
  if (req.method !== "GET") {
    sendHtml(res, 405, pageError("方法不支持。"));
    return;
  }

  const url = requestUrl || new URL(req.url || "/api/artist-page", "https://local.invalid");
  const requestedSlug = text(url.searchParams.get("slug"));
  if (!requestedSlug || requestedSlug.length > 120) {
    sendHtml(res, 404, pageError("作家ページが見つかりません。"));
    return;
  }

  try {
    const { rows, slugMap } = await loadPublicArtists();
    const artist = rows.find((row) => slugForArtist(row, slugMap) === requestedSlug);
    if (!artist) {
      sendHtml(res, 404, pageError("作家ページが見つかりません。"));
      return;
    }
    sendHtml(res, 200, renderArtistPage(artist, slugForArtist(artist, slugMap), slugMap));
  } catch {
    sendHtml(res, 503, pageError("作家情報を読み込めませんでした。"));
  }
}

function renderArtistPage(row, slug, slugMap) {
  const name = text(row.name) || text(row.handle) || "日本画作家";
  const roman = text(row.roman_name || row.romanName);
  const region = text(row.region) || "未登録";
  const school = text(row.school) || "未登録";
  const note = text(row.note) || "公開情報源をもとに整理した作家情報です。";
  const tags = (Array.isArray(row.styles) ? row.styles : []).map(text).filter(Boolean).slice(0, 24);
  const sources = artistSources(row);
  const canonical = `${SITE_ORIGIN}/artists/${encodeURIComponent(slug)}`;
  const description = `${name}の経歴、所属、公開情報源などを掲載。日本画作家を探すための独立インデックス NIHONGA INDEX。`;
  const image = safeHttpUrl(row.image_url || row.imageUrl);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name,
    alternateName: roman || undefined,
    description,
    url: canonical,
    affiliation: school !== "未登録" ? { "@type": "Organization", name: school } : undefined,
    sameAs: sources.map((source) => source.url)
  };
  const jsonLdText = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(name)}｜日本画家｜NIHONGA INDEX</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta property="og:type" content="profile">
    <meta property="og:site_name" content="NIHONGA INDEX">
    <meta property="og:title" content="${escapeHtml(name)}｜日本画家｜NIHONGA INDEX">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ""}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(name)}｜日本画家｜NIHONGA INDEX">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <link rel="stylesheet" href="/styles.css?v=6">
    <link rel="stylesheet" href="/editorial.css?v=6">
    <link rel="stylesheet" href="/artist-page.css?v=1">
    <script type="application/ld+json">${jsonLdText}</script>
  </head>
  <body class="artist-page">
    <header class="artist-page-header">
      <a class="artist-page-brand" href="/">NIHONGA INDEX<small>日本画作家インデックス</small></a>
      <nav aria-label="メインナビゲーション"><a href="/">作家を探す</a><a href="/news">NIHONGA NOW</a><a href="/submit-artist">作家掲載申請</a></nav>
    </header>
    <main class="artist-page-main">
      <p class="artist-page-kicker">日本画作家 / NIHONGA INDEX</p>
      <article class="artist-profile" data-artist-slug="${escapeHtml(slug)}">
        <header class="artist-profile-header">
          <div><h1>${escapeHtml(name)}</h1>${roman ? `<p class="artist-profile-roman">${escapeHtml(roman)}</p>` : ""}</div>
          ${image ? `<img class="artist-profile-image" src="${escapeHtml(image)}" alt="${escapeHtml(name)}" loading="eager" decoding="async" referrerpolicy="no-referrer">` : ""}
        </header>
        <div class="artist-profile-actions"><button id="artistShare" type="button">この作家をシェア</button><a class="artist-outline-link" href="/submit-artist?artist=${encodeURIComponent(slug)}&amp;mode=correction">本人ですか？情報を修正</a></div>
        <dl class="artist-facts"><div><dt>地区</dt><dd>${escapeHtml(region)}</dd></div><div><dt>所属 / 学校</dt><dd>${escapeHtml(school)}</dd></div><div><dt>公開情報源</dt><dd>${escapeHtml(sources.length ? `${sources.length}件` : "未登録")}</dd></div></dl>
        <section class="artist-profile-section"><h2>プロフィール</h2><p class="artist-profile-note">${escapeHtml(note)}</p></section>
        <section class="artist-profile-section"><h2>タグ</h2><div class="artist-profile-tags">${tags.length ? tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("") : "<span>日本画</span>"}</div></section>
        <section class="artist-profile-section"><h2>出典</h2>${sources.length ? `<ul class="artist-source-list">${sources.map((source) => `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)}</a>${source.type ? `<small>${escapeHtml(source.type)}</small>` : ""}</li>`).join("")}</ul>` : "<p class=\"artist-muted\">公開情報源は準備中です。</p>"}</section>
      </article>
    </main>
    <footer class="artist-page-footer"><a href="/">NIHONGA INDEX</a><span>A project by HUI STUDIO</span></footer>
    <script src="/artist-page.js?v=1" defer></script>
  </body>
</html>`;
}

function pageError(message) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NIHONGA INDEX</title><link rel="stylesheet" href="/styles.css?v=6"><link rel="stylesheet" href="/artist-page.css?v=1"></head><body class="artist-page"><main class="artist-page-main"><p class="artist-page-kicker">NIHONGA INDEX</p><h1>${escapeHtml(message)}</h1><p><a href="/">作家を探す</a></p></main></body></html>`;
}

function sendHtml(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", status === 200 ? "public, s-maxage=300, stale-while-revalidate=600" : "no-store");
  res.end(body);
}

module.exports = { handleArtistPage, renderArtistPage, pageError };
