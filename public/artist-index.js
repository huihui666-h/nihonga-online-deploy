/* Pure presentation helpers. No requests, credentials, or database writes. */
(function (root) {
  const vocabulary = typeof module !== "undefined" && module.exports ? require("./artist-vocabulary.js") : root.ArtistVocabulary;
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const clean = (value) => {
    const valueText = text(value);
    return /^(unknown|n\/?a|暂无|未确认|未確認|不明|待补|待補|待会补|待會補|IG 待补|IG 待補)$/i.test(valueText) ? "" : valueText;
  };
  const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase();
  const tags = (artist) => [...new Set([...(Array.isArray(artist.styles) ? artist.styles : []), ...(Array.isArray(artist.tags) ? artist.tags : [])].map(clean).filter(Boolean))];
  const safeUrl = (value) => {
    try { const url = new URL(text(value)); return /^https?:$/.test(url.protocol) ? text(value) : ""; } catch { return ""; }
  };
  const invalidHandles = new Set(["http", "https", "www", "instagram", "instagram.com"]);
  const validHandle = (value) => {
    const handle = clean(value).replace(/^@/, "").toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(handle) && !invalidHandles.has(handle);
  };
  const instagram = (artist) => {
    const direct = safeUrl(artist.instagram);
    if (direct) {
      try {
        const firstSegment = new URL(direct).pathname.split("/").filter(Boolean)[0] || "";
        if (validHandle(firstSegment)) return direct;
      } catch { /* Fall through to the validated handle. */ }
    }
    const handle = clean(artist.handle);
    return validHandle(handle) ? `https://www.instagram.com/${handle.replace(/^@/, "")}/` : "";
  };
  const slug = (artist) => {
    const source = clean(artist?.romanName || artist?.roman_name || artist?.name || artist?.handle || artist?.id || "artist").replace(/^@/, "");
    const value = source.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return value.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 72) || `artist-${clean(artist?.id).slice(0, 12) || "profile"}`;
  };
  const addedTime = (artist) => {
    // updatedAt is intentionally excluded: an edit is not a new addition.
    for (const value of [artist.addedAt, artist.createdAt, artist.created_at, artist.added_at]) {
      if (!text(value)) continue;
      const time = Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
    return null;
  };
  const editorial = (artist, entries = {}) => {
    const entry = Object.prototype.hasOwnProperty.call(entries, artist.id) ? entries[artist.id] : {};
    return { ...artist, featured: entry.featured ?? artist.featured, huiNote: entry.huiNote ?? artist.huiNote, imageUrl: entry.imageUrl ?? artist.imageUrl, imageAlt: entry.imageAlt ?? artist.imageAlt };
  };
  const matches = (artist, filters = {}) => {
    const all = "全部";
    const styles = tags(artist);
    const haystack = normalize([artist.name, artist.romanName, artist.handle, artist.region, artist.school, artist.note, artist.huiNote, ...styles, ...(vocabulary?.searchTerms(artist) || [])].join(" "));
    return (!filters.region || filters.region === all || artist.region === filters.region)
      && (!filters.school || filters.school === all || artist.school === filters.school)
      && (!filters.tag || filters.tag === all || styles.includes(filters.tag))
      && (!text(filters.query) || haystack.includes(normalize(filters.query.trim())));
  };
  const hash = (value) => Array.from(String(value)).reduce((n, char) => Math.imul(n ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const rotationHourKey = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
  };
  const featured = (artists, period, count = 4) => {
    const manual = artists.filter((artist) => artist.featured === true);
    const rest = artists.filter((artist) => artist.featured !== true).slice().sort((a, b) => hash(`${period}:${a.id}`) - hash(`${period}:${b.id}`));
    return [...manual, ...rest].slice(0, count);
  };
  const recent = (artists, count = 4) => artists.filter((artist) => addedTime(artist) !== null).slice().sort((a, b) => addedTime(b) - addedTime(a)).slice(0, count);
  const random = (artists, previousId, rng = Math.random) => {
    const pool = artists.length > 1 ? artists.filter((artist) => artist.id !== previousId) : artists;
    return pool.length ? pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))] : null;
  };
  const resolveIds = (ids, artists) => {
    const byId = new Map(artists.filter((artist) => typeof artist.id === "string").map((artist) => [artist.id, artist]));
    return [...new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [])].map((id) => byId.get(id)).filter(Boolean);
  };
  const helpers = { clean, normalize, tags, safeUrl, instagram, validHandle, slug, addedTime, editorial, matches, rotationHourKey, featured, recent, random, resolveIds };
  if (typeof module !== "undefined" && module.exports) module.exports = helpers;
  else root.ArtistIndex = Object.freeze(helpers);
})(typeof window !== "undefined" ? window : this);
