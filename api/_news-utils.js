const { text, escapeHtml, safeHttpUrl } = require("./_artist-utils");

function newsSlug(row) {
  const source = text(row?.title || row?.id || "news");
  const base = source.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  const id = text(row?.id);
  return `${base || "news"}-${id.slice(0, 8) || "item"}`;
}

function formatNewsDate(row) {
  return text(row?.published_at || row?.publishedAt || row?.start_date || row?.startDate).slice(0, 10);
}

function cleanNewsTitle(value) {
  return text(value)
    .replace(/^\s*\d{4}\s*(?:[./-]|年)\s*\d{1,2}\s*(?:[./-]|月)\s*\d{1,2}\s*(?:日)?(?:[\s　:：｜|・-]+|$)/u, "")
    .replace(/^\s*(?:お知らせ|ニュース|最新情報)\s*[：:｜|・-]?\s*/u, "")
    .trim();
}

function displayNewsDate(value) {
  const raw = text(value);
  const match = raw.match(/(\d{4})\s*(?:[./-]|年)\s*(\d{1,2})\s*(?:[./-]|月)\s*(\d{1,2})/u);
  if (match) return `${match[1]}.${String(match[2]).padStart(2, "0")}.${String(match[3]).padStart(2, "0")}`;
  return formatNewsDate({ published_at: raw }).replace(/-/g, ".");
}

function newsCategoryLabel(row) {
  const title = text(row?.title);
  if (/受賞|入選|award|prize/i.test(title)) return "受賞・入選";
  if (/公募|募集|応募|出品/u.test(title)) return "公募";
  if (/美術館/u.test(title)) return "美術館";
  if (/画廊|gallery/i.test(title)) return "画廊";
  if (/卒業制作|卒展/u.test(title)) return "卒展";
  if (/大学/u.test(title)) return "大学";
  if (/展覧会|展示|開催|個展|展覧|展(?=\s|[―—|｜・:：-]|$)/u.test(title)) return /個展/u.test(title) ? "個展" : "展覧会";
  if (/掲載|訃報|逝去|インタビュー|活動|会員/u.test(title)) return "作家動向";
  return ({ exhibition: "展覧会", open_call: "公募", artist_news: "作家動向", museum: "美術館", nihonga_news: "日本画ニュース", award: "受賞", selection: "入選", solo: "個展", graduation: "卒展", university: "大学", gallery: "画廊" })[text(row?.category)] || "日本画ニュース";
}

function renderNewsPage(row, canonical) {
  const title = cleanNewsTitle(row?.title) || "日本画ニュース";
  const summary = text(row?.summary) || "日本画に関する展覧会、公募、作家の動きを記録します。";
  const sourceName = text(row?.source_name || row?.sourceName) || "公式情報源";
  const sourceUrl = safeHttpUrl(row?.source_url || row?.sourceUrl);
  const category = newsCategoryLabel(row);
  const publishedDate = formatNewsDate(row);
  const date = displayNewsDate(publishedDate);
  const venue = text(row?.venue);
  const tags = Array.isArray(row?.tags) ? row.tags.map(text).filter(Boolean).slice(0, 20) : [];
  const description = `${title}。${summary}`.slice(0, 280);
  const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@type": "NewsArticle", headline: title, description, datePublished: publishedDate || undefined, mainEntityOfPage: canonical, publisher: { "@type": "Organization", name: "NIHONGA INDEX" }, isBasedOn: sourceUrl || undefined }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}｜NIHONGA NOW｜NIHONGA INDEX</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="article"><meta property="og:site_name" content="NIHONGA INDEX"><meta property="og:title" content="${escapeHtml(title)}｜NIHONGA NOW"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtml(title)}｜NIHONGA NOW"><meta name="twitter:description" content="${escapeHtml(description)}"><link rel="stylesheet" href="/styles.css?v=6"><link rel="stylesheet" href="/news.css?v=4"><link rel="stylesheet" href="/artist-page.css?v=1"><script type="application/ld+json">${jsonLd}</script></head><body class="artist-page"><header class="artist-page-header"><a class="artist-page-brand" href="/">NIHONGA INDEX<small>日本画作家インデックス</small></a><nav aria-label="メインナビゲーション"><a href="/">作家を探す</a><a href="/news">NIHONGA NOW</a></nav></header><main class="artist-page-main"><p class="artist-page-kicker">NIHONGA NOW / ${escapeHtml(category)}</p><article class="news-detail"><h1>${escapeHtml(title)}</h1>${date ? `<time datetime="${escapeHtml(publishedDate)}">${escapeHtml(date)}</time>` : ""}<p class="news-detail-summary">${escapeHtml(summary)}</p>${venue ? `<p class="news-detail-venue"><strong>会場</strong> ${escapeHtml(venue)}</p>` : ""}${tags.length ? `<div class="artist-profile-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}<div class="news-detail-source"><span>出典</span>${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceName)} ↗</a>` : `<span>${escapeHtml(sourceName)}</span>`}</div></article></main><footer class="artist-page-footer"><a href="/">NIHONGA INDEX</a><span>A project by HUI STUDIO</span></footer></body></html>`;
}

module.exports = { cleanNewsTitle, displayNewsDate, formatNewsDate, newsCategoryLabel, newsSlug, renderNewsPage };
