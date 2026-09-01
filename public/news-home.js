(function () {
  const CATEGORY_LABELS = { exhibition: "展覧会", open_call: "公募", artist_news: "作家動向", museum: "美術館", nihonga_news: "日本画ニュース" };
  const list = document.querySelector("#newsHomeList");
  if (!list) return;
  const section = list.closest(".news-home-section");
  const text = (value) => String(value ?? "").trim();
  const safeUrl = (value) => { try { const url = new URL(text(value), window.location.origin); return /^https?:$/i.test(url.protocol) ? url.href : ""; } catch { return ""; } };
  const date = (item) => text(item.startDate) || text(item.publishedAt).slice(0, 10);
  const card = (item) => {
    const article = document.createElement("article"); article.className = "news-home-card";
    const meta = document.createElement("div"); meta.className = "news-card-meta";
    const category = document.createElement("span"); category.className = "news-card-category"; category.textContent = CATEGORY_LABELS[item.category] || item.category || "日本画ニュース";
    const time = document.createElement("time"); time.textContent = date(item); meta.append(category); if (time.textContent) meta.append(time); article.append(meta);
    const href = safeUrl(item.sourceUrl);
    const title = document.createElement(href ? "a" : "h3"); title.className = "news-title"; title.textContent = text(item.title) || "無題";
    if (href) { title.href = href; title.target = "_blank"; title.rel = "noopener noreferrer"; }
    article.append(title);
    if (text(item.venue)) { const venue = document.createElement("p"); venue.className = "news-venue"; venue.textContent = text(item.venue); article.append(venue); }
    if (text(item.summary)) { const summary = document.createElement("p"); summary.className = "news-summary"; summary.textContent = text(item.summary); article.append(summary); }
    const source = document.createElement("div"); source.className = "news-source-row"; source.textContent = text(item.sourceName) || "出典未確認";
    if (href) { const link = document.createElement("a"); link.className = "news-source"; link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "原文 ↗"; source.append(link); }
    article.append(source); return article;
  };
  async function load() {
    list.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/news?limit=3", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("request failed");
      const payload = await response.json(); const items = NewsData.select(payload.news, { limit: 3 });
      list.replaceChildren();
      section?.classList.toggle("is-empty", !items.length);
      if (items.length) list.append(...items.map(card));
      else { const empty = document.createElement("p"); empty.className = "news-home-empty"; empty.textContent = "掲載中のニュースを準備しています。"; list.append(empty); }
    } catch {
      const empty = document.createElement("p"); empty.className = "news-home-empty"; empty.textContent = "ニュースを読み込めませんでした。"; list.replaceChildren(empty);
      section?.classList.add("is-empty");
    } finally { list.setAttribute("aria-busy", "false"); }
  }
  load();
})();
