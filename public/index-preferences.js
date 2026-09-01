/* Browser-only preferences; never stores passwords, tokens, emails or AI input. */
(function (root) {
  const PAGE_SIZE = 12;
  const BROWSE_KEY = "nihonga:browse:v1";
  const cleanString = (value, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
  const sanitize = (value = {}) => {
    if (!value || typeof value !== "object") value = {};
    const result = { query: cleanString(value.query), view: value.view === "list" ? "list" : "grid" };
    for (const key of ["region", "school", "tag"]) result[key] = cleanString(value[key]) || "全部";
    result.limit = Math.max(PAGE_SIZE, Math.min(12000, Math.ceil((Number(value.limit) || PAGE_SIZE) / PAGE_SIZE) * PAGE_SIZE));
    result.scrollY = Math.max(0, Math.min(1000000, Number(value.scrollY) || 0));
    result.randomId = cleanString(value.randomId, 200);
    return result;
  };
  function read(storage, key, fallback) {
    try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }
  function write(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  const fromUrl = (href) => {
    const params = new URL(href).searchParams;
    const explicit = ["q", "region", "school", "tag", "view", "artist"].some((key) => params.has(key));
    return { explicit, artistId: cleanString(params.get("artist"), 200), lang: ["zh", "ja", "en"].includes(params.get("lang")) ? params.get("lang") : null,
      browse: sanitize({ query: params.get("q"), region: params.get("region"), school: params.get("school"), tag: params.get("tag"), view: params.get("view") }) };
  };
  const shareUrl = (href, browse, lang, artistId) => {
    const url = new URL(href);
    url.search = ""; // Do not propagate unrelated query parameters or any identity.
    const value = sanitize(browse);
    if (artistId) url.searchParams.set("artist", cleanString(artistId, 200));
    else {
      if (value.query.trim()) url.searchParams.set("q", value.query.trim());
      for (const key of ["region", "school", "tag"]) if (value[key] !== "全部") url.searchParams.set(key, value[key]);
      url.searchParams.set("view", value.view);
    }
    if (["zh", "ja", "en"].includes(lang)) url.searchParams.set("lang", lang);
    url.hash = artistId ? "home" : "all-artists";
    return url.href;
  };
  const memberId = (user) => user && user.guest !== true && (!user.status || user.status === "active") && typeof user.id === "string" && user.id.length > 0 && user.id.length <= 200 ? user.id : null;
  const favoriteKey = (user) => memberId(user) ? `nihonga:favorites:v1:${encodeURIComponent(memberId(user))}` : null;
  function favorites(storage, user) {
    const key = favoriteKey(user);
    const value = key ? read(storage, key, []) : [];
    return Array.isArray(value) ? [...new Set(value.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 12000) : [];
  }
  function toggleFavorite(storage, user, id, artists) {
    const key = favoriteKey(user);
    if (!key) return { ok: false, reason: "guest" };
    if (!artists.some((artist) => artist.id === id)) return { ok: false, reason: "unknown" };
    const ids = favorites(storage, user);
    const saved = !ids.includes(id);
    const next = saved ? [...ids, id] : ids.filter((item) => item !== id);
    return write(storage, key, next) ? { ok: true, saved } : { ok: false, reason: "storage" };
  }
  const api = { BROWSE_KEY, sanitize, read, write, fromUrl, shareUrl, memberId, favorites, toggleFavorite };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IndexPreferences = Object.freeze(api);
})(typeof window !== "undefined" ? window : this);
