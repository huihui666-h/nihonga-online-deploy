const { canonicalInstagramUrl, supabaseFetch } = require("./_supabase");

function text(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function baseSlug(row) {
  const source = text(row?.roman_name || row?.romanName || row?.name || row?.handle || row?.id || "artist").replace(/^@/, "");
  const normalized = source.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const slug = normalized
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || `artist-${text(row?.id).slice(0, 12) || "profile"}`;
}

function buildSlugMap(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const sorted = list.slice().sort((a, b) => text(a?.id).localeCompare(text(b?.id)));
  const used = new Set();
  const map = new Map();
  sorted.forEach((row) => {
    const id = text(row?.id);
    if (!id) return;
    const base = baseSlug(row);
    let slug = base;
    if (used.has(slug)) slug = `${base}-${id.slice(0, 8)}`;
    let suffix = 2;
    while (used.has(slug)) slug = `${base}-${id.slice(0, 8)}-${suffix++}`;
    used.add(slug);
    map.set(id, slug);
  });
  return map;
}

function slugForArtist(row, slugMap) {
  const id = text(row?.id);
  return text(slugMap?.get(id)) || baseSlug(row);
}

async function loadPublicArtists() {
  const rows = await supabaseFetch("artists?select=*&order=name.asc&limit=10000");
  const list = Array.isArray(rows) ? rows : [];
  const slugMap = buildSlugMap(list);
  return { rows: list, slugMap };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeHttpUrl(value) {
  const raw = text(value);
  if (!raw || raw.length > 2048) return "";
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function artistSources(row) {
  const values = [];
  const future = Array.isArray(row?.sources) ? row.sources : Array.isArray(row?.artist_sources) ? row.artist_sources : [];
  future.forEach((source) => {
    const url = safeHttpUrl(source?.source_url || source?.url);
    if (url) values.push({ name: text(source?.source_name || source?.name) || "公式情報", type: text(source?.source_type || source?.type), url });
  });
  const sourceType = text(row?.link_type || row?.linkType).toLowerCase();
  const rawSourcePage = row?.source_url || row?.sourceUrl || row?.source_page || row?.sourcePage;
  const sourcePage = sourceType === "instagram" ? canonicalInstagramUrl(rawSourcePage) : safeHttpUrl(rawSourcePage);
  if (sourcePage && !values.some((source) => source.url === sourcePage)) {
    values.push({
      name: sourceType === "instagram" ? "Instagram" : sourceType === "website" ? "公式サイト" : "公開プロフィール",
      type: sourceType === "instagram" ? "SNS" : sourceType,
      url: sourcePage
    });
  }
  const instagram = canonicalInstagramUrl(row?.instagram || row?.handle);
  if (instagram && !values.some((source) => source.url === instagram)) values.push({ name: "Instagram", type: "SNS", url: instagram });
  return values.slice(0, 12);
}

module.exports = { artistSources, buildSlugMap, escapeHtml, loadPublicArtists, safeHttpUrl, slugForArtist, text };
