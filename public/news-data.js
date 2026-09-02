/* Pure Nihonga Now presentation helpers; shared by the browser and tests. */
(function (root) {
  const text = (value) => String(value ?? "").trim();
  const cleanTitle = (value) => text(value)
    // Crawlers sometimes include the publication date in the headline. The
    // date already has its own metadata row, so remove only a leading date.
    .replace(/^\s*\d{4}\s*(?:[./-]|年)\s*\d{1,2}\s*(?:[./-]|月)\s*\d{1,2}\s*(?:日)?(?:[\s　:：｜|・-]+|$)/u, "")
    .trim();
  const displayDate = (value) => {
    const raw = text(value);
    const match = raw.match(/(\d{4})\s*(?:[./-]|年)\s*(\d{1,2})\s*(?:[./-]|月)\s*(\d{1,2})/u);
    if (match) return `${match[1]}.${String(match[2]).padStart(2, "0")}.${String(match[3]).padStart(2, "0")}`;
    const parsed = dateValue(raw);
    if (parsed === null) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(parsed));
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${fields.year}.${fields.month}.${fields.day}`;
  };
  const dateValue = (value) => {
    const parsed = Date.parse(text(value));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const dateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : "";
  const tokyoDate = (value) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(value));
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  };
  const category = (value) => ["exhibition", "open_call", "artist_news"].includes(text(value)) ? text(value) : "all";
  const active = (item, now = Date.now()) => {
    if (!item || typeof item !== "object") return false;
    if (item.status && item.status !== "published") return false;
    const itemCategory = text(item.category);
    // Newly indexed artists belong in the dedicated "recently added" area.
    // NIHONGA NOW only publishes editorial news, not every directory insert.
    if (itemCategory === "new_artist") return false;
    // API rows always carry a category; legacy/local fixtures without one
    // retain the historical end-date behavior.
    if (itemCategory && !["exhibition", "open_call"].includes(itemCategory)) return true;
    const endText = item.endDate ?? item.end_date;
    const endDate = dateOnly(endText);
    if (endDate) return endDate >= tokyoDate(now);
    const end = dateValue(endText);
    return end === null || end >= now;
  };
  const order = (item) => dateValue(item.publishedAt ?? item.published_at)
    ?? dateValue(item.startDate ?? item.start_date)
    ?? dateValue(item.createdAt ?? item.created_at)
    ?? 0;
  const select = (items, options = {}) => {
    const wanted = category(options.category);
    const limit = Math.max(0, Math.min(100, Number(options.limit) || 100));
    const now = options.now ?? Date.now();
    return (Array.isArray(items) ? items : [])
      .filter((item) => active(item, now) && (wanted === "all" || item.category === wanted))
      .slice()
      .sort((a, b) => order(b) - order(a))
      .slice(0, limit);
  };
  const api = { active, category, select, cleanTitle, displayDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NewsData = Object.freeze(api);
})(typeof window !== "undefined" ? window : this);
