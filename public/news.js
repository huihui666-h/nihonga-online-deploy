(function () {
  const CATEGORY_LABELS = {
    exhibition: "展覧会",
    open_call: "公募",
    artist_news: "作家動向",
    museum: "美術館",
    nihonga_news: "日本画ニュース",
    award: "受賞",
    selection: "入選",
    solo: "個展",
    graduation: "卒展",
    university: "大学",
    gallery: "画廊"
  };
  const tabs = [...document.querySelectorAll("[data-news-category]")];
  const list = document.querySelector("#newsList");
  const status = document.querySelector("#newsStatus");
  if (!list || !status) return;
  let activeCategory = "latest";

  function text(value) { return String(value ?? "").trim(); }
  function nameKey(value) { return text(value).normalize("NFKC").replace(/\s+/gu, " ").toLowerCase(); }
  function safeUrl(value) {
    try {
      const url = new URL(text(value), window.location.origin);
      return /^https?:$/i.test(url.protocol) ? url.href : "";
    } catch { return ""; }
  }
  function formatDate(news) {
    const start = text(news.startDate);
    const end = text(news.endDate);
    if (start && end && start !== end) return `${NewsData.displayDate(start)} – ${NewsData.displayDate(end)}`;
    return NewsData.displayDate(start || news.publishedAt);
  }
  function makeLink(label, href, className) {
    const link = document.createElement("a");
    link.className = className;
    link.textContent = label;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }
  function makeCard(news) {
    const article = document.createElement("article");
    article.className = "news-card";
    const meta = document.createElement("div");
    meta.className = "news-card-meta";
    const category = document.createElement("span");
    category.className = "news-card-category";
    category.textContent = CATEGORY_LABELS[news.category] || news.category || "日本画ニュース";
    const date = document.createElement("time");
    date.textContent = formatDate(news);
    if (news.publishedAt) date.dateTime = text(news.publishedAt);
    meta.append(category);
    if (date.textContent) meta.append(date);
    article.append(meta);

    const sourceUrl = safeUrl(news.sourceUrl);
    const detailUrl = text(news.slug) ? `/news/${encodeURIComponent(text(news.slug))}` : "";
    const cleanTitle = NewsData.cleanTitle(news.title);
    const title = detailUrl ? makeLink(cleanTitle, detailUrl, "news-title") : document.createElement("h2");
    if (!detailUrl) { title.className = "news-title"; title.textContent = cleanTitle || "無題"; }
    if (detailUrl) { title.target = "_self"; title.removeAttribute("rel"); }
    article.append(title);
    if (text(news.summary)) { const summary = document.createElement("p"); summary.className = "news-summary"; summary.textContent = text(news.summary); article.append(summary); }
    if (text(news.venue)) { const venue = document.createElement("p"); venue.className = "news-venue"; venue.innerHTML = "<strong>会場</strong> "; venue.append(document.createTextNode(text(news.venue))); article.append(venue); }

    const artists = Array.isArray(news.relatedArtists) ? news.relatedArtists : (Array.isArray(news.artists) ? news.artists : []);
    const rawArtistNames = Array.isArray(news.artistNames)
      ? news.artistNames.map(text).filter(Boolean)
      : [];
    if (artists.length || rawArtistNames.length) {
      const artistRow = document.createElement("div"); artistRow.className = "news-artists";
      const label = document.createElement("span"); label.className = "news-artists-label"; label.textContent = "関連作家"; artistRow.append(label);
      const linkedNames = new Set();
      artists.forEach((artist) => {
        const name = text(artist.name) || text(artist.romanName);
        if (!name) return;
        linkedNames.add(nameKey(name));
        const id = text(artist.id);
        if (!id) {
          const span = document.createElement("span"); span.className = "news-artist"; span.textContent = name; artistRow.append(span);
          return;
        }
        const href = `/?artist=${encodeURIComponent(id)}`;
        const link = document.createElement("a"); link.className = "news-artist"; link.href = href; link.textContent = name; artistRow.append(link);
      });
      rawArtistNames.filter((name) => !linkedNames.has(nameKey(name))).forEach((name) => {
        const span = document.createElement("span"); span.className = "news-artist"; span.textContent = name; artistRow.append(span);
      });
      article.append(artistRow);
    }
    const sourceRow = document.createElement("div"); sourceRow.className = "news-source-row";
    const sourceLabel = document.createElement("span"); sourceLabel.textContent = "出典"; sourceRow.append(sourceLabel);
    if (sourceUrl) sourceRow.append(makeLink(text(news.sourceName) || "原文", sourceUrl, "news-source")); else sourceRow.append(document.createTextNode(text(news.sourceName) || "出典未確認"));
    article.append(sourceRow);
    return article;
  }
  function render(items) {
    list.replaceChildren();
    if (!items.length) { const empty = document.createElement("p"); empty.className = "news-empty"; empty.textContent = "現在、掲載中のニュースはありません。"; list.append(empty); return; }
    list.append(...items.map(makeCard));
  }
  async function load(category) {
    activeCategory = category;
    tabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.newsCategory === category)));
    status.textContent = "読み込み中…";
    const query = category !== "latest" ? `?category=${encodeURIComponent(category)}&limit=50` : "?limit=50";
    try {
      const response = await fetch(`/api/news${query}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error("request failed");
      const payload = await response.json();
      const items = NewsData.select(payload.news, { category, limit: 50 });
      render(items);
      status.textContent = items.length ? `${items.length} 件` : "";
    } catch {
      render([]);
      status.textContent = "ニュースを読み込めませんでした。";
    }
  }
  tabs.forEach((tab) => tab.addEventListener("click", () => load(tab.dataset.newsCategory || "latest")));
  load(activeCategory);
})();
