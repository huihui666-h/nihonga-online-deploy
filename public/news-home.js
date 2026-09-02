(function () {
  const CATEGORY_LABELS = { exhibition: "展覧会", open_call: "公募", artist_news: "作家動向", museum: "美術館", nihonga_news: "日本画ニュース", award: "受賞", selection: "入選", solo: "個展", graduation: "卒展", university: "大学", gallery: "画廊" };
  const list = document.querySelector("#newsHomeList");
  if (!list) return;
  const section = list.closest(".news-home-section");
  const text = (value) => String(value ?? "").trim();
  const safeUrl = (value) => { try { const url = new URL(text(value), window.location.origin); return /^https?:$/i.test(url.protocol) ? url.href : ""; } catch { return ""; } };
  const date = (item) => NewsData.displayDate(text(item.publishedAt) || text(item.startDate));
  let newsItems = [];
  const categoryLabel = (item) => /受賞|入選|award|prize/i.test(text(item.title)) ? "受賞・入選" : CATEGORY_LABELS[item.category] || item.category || "日本画ニュース";
  const card = (item) => {
    const article = document.createElement("article"); article.className = "news-home-card";
    const meta = document.createElement("div"); meta.className = "news-card-meta";
    const category = document.createElement("span"); category.className = "news-card-category"; category.textContent = categoryLabel(item);
    const time = document.createElement("time"); time.textContent = date(item); meta.append(category); if (time.textContent) meta.append(time); article.append(meta);
    const href = safeUrl(item.sourceUrl);
    const detailHref = text(item.detailUrl) || (text(item.slug) ? `/news/${encodeURIComponent(text(item.slug))}` : "");
    const title = document.createElement(detailHref ? "a" : "h3"); title.className = "news-title"; title.textContent = NewsData.cleanTitle(item.title) || "無題";
    if (detailHref) title.href = detailHref;
    article.append(title);
    // Homepage cards stay compact: category, date, title and source only.
    const source = document.createElement("div"); source.className = "news-source-row"; source.textContent = text(item.sourceName) || "出典未確認";
    if (href) { const link = document.createElement("a"); link.className = "news-source"; link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "原文 ↗"; source.append(link); }
    article.append(source); return article;
  };
  const render = () => {
    const items = NewsData.select(newsItems, { limit: 4 });
    list.replaceChildren(); section?.classList.toggle("is-empty", !items.length);
    if (items.length) list.append(...items.map(card));
    else { const empty = document.createElement("p"); empty.className = "news-home-empty"; empty.textContent = "掲載中のニュースを準備しています。"; list.append(empty); }
  };
  async function load() {
    list.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/news?limit=4", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("request failed");
      const payload = await response.json(); newsItems = NewsData.select(payload.news, { limit: 4 }); render();
    } catch {
      const empty = document.createElement("p"); empty.className = "news-home-empty"; empty.textContent = "ニュースを読み込めませんでした。"; list.replaceChildren(empty);
      section?.classList.add("is-empty");
    } finally { list.setAttribute("aria-busy", "false"); }
  }
  load();
})();
