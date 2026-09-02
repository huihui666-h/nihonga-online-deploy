/* Presentation layer over the original app state and API functions. */
const IndexUI = (() => {
  const PAGE_SIZE = 12;
  let limit = PAGE_SIZE;
  let randomId = null;
  let detailId = null;
  let finderSent = false;
  let view = "grid";
  let onlyFavorites = false;
  let filterSignature = null;
  let savedBrowse = null;
  let shared = null;
  let resumed = false;
  let scrollTimer;
  const $ = (id) => document.getElementById(id);
  const t = (key, ...args) => I18N.t(key, ...args);
  const artists = () => state.artists.map((artist) => ArtistIndex.editorial(artist, ArtistEditorial));
  const filtered = () => {
    const saved = new Set(onlyFavorites ? IndexAccount.ids() : []);
    return artists().filter((artist) => ArtistIndex.matches(artist, state) && (!onlyFavorites || (IndexAccount.member() && saved.has(artist.id))));
  };
  const label = (value) => ArtistVocabulary.label(value, I18N.current);
  const dateText = (time) => new Intl.DateTimeFormat({ zh: "zh-CN", ja: "ja-JP", en: "en-GB" }[I18N.current] || "ja-JP", { year: "numeric", month: "short", day: "numeric" }).format(time);
  const noDataKey = () => state.loadError ? "loadFailed" : "noArtists";

  function empty(container, key, retry = false) {
    container.replaceChildren();
    const element = document.createElement("div");
    element.className = "index-empty";
    element.textContent = t(key);
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "outline-button";
      button.textContent = t("retryLoad");
      button.addEventListener("click", loadArtists);
      element.append(button);
    }
    container.append(element);
  }

  function skeleton(container, count) {
    container.innerHTML = `<p class="skeleton-label" role="status">${escapeHtml(t("loadingArtists"))}</p>`
      + Array.from({ length: count }, () => '<div class="skeleton-card" aria-hidden="true"><span></span><span></span><span></span></div>').join("");
  }

  function createCard(artist, { kind = "grid", index = 0 } = {}) {
    const card = document.createElement("article");
    card.className = `artist-card index-card ${kind}-card`;
    card.dataset.artistId = artist.id;
    const clean = ArtistIndex.clean;
    const name = clean(artist.name) || clean(artist.handle);
    const roman = clean(artist.romanName);
    const handle = /^@?[a-z0-9_.]{1,30}$/i.test(String(artist.handle || "")) ? `@${artist.handle.replace(/^@/, "")}` : "";
    const instagram = ArtistIndex.instagram(artist);
    const tags = ArtistIndex.tags(artist).filter((tag) => tag !== artist.school && tag !== artist.region);
    const imageUrl = ArtistIndex.safeUrl(artist.imageUrl);
    const slug = String(artist.slug || ArtistIndex.slug?.(artist) || artist.id || "artist");
    const artistPageUrl = `/artists/${encodeURIComponent(slug)}`;
    // Discovery cards keep a stable visual rhythm even when an artist has no image.
    // Detail views omit the placeholder when no image is available to stay compact.
    const showMedia = kind !== "detail" || Boolean(imageUrl);
    const added = ArtistIndex.addedTime(artist);
    const title = name ? (kind === "detail" ? `<h3 id="artistDialogTitle">${escapeHtml(name)}</h3>` : `<h3><a class="artist-name-link" href="${escapeHtml(artistPageUrl)}">${escapeHtml(name)}</a></h3>`) : "";
    card.innerHTML = `
      ${showMedia ? `<div class="card-media${imageUrl ? " has-image" : ""}">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(clean(artist.imageAlt) || name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<span class="card-monogram" aria-hidden="true">${escapeHtml(initials(name))}</span><span class="card-index" aria-hidden="true">${escapeHtml(t("cardIndexLabel"))} / ${String(index + 1).padStart(2, "0")}</span>`}</div>` : ""}
      <div class="card-body">
        <div class="artist-identity">${kind === "recent" && added !== null ? `<time class="artist-added" datetime="${new Date(added).toISOString()}">${escapeHtml(dateText(added))}</time>` : ""}${title}${roman ? `<p class="artist-roman">${escapeHtml(roman)}</p>` : ""}${handle ? `<p class="artist-handle">${escapeHtml(handle)}</p>` : ""}</div>
        ${tags.length ? `<div class="tag-row">${(kind === "detail" ? tags : tags.slice(0, 3)).map((tag) => `<span title="${escapeHtml(tag)}">${escapeHtml(label(tag))}</span>`).join("")}</div>` : ""}
        ${clean(artist.school) || clean(artist.region) ? `<p class="artist-meta">${[clean(artist.school), clean(artist.region)].filter(Boolean).map((item) => `<span title="${escapeHtml(item)}">${escapeHtml(label(item))}</span>`).join("")}</p>` : ""}
        ${clean(artist.huiNote) ? `<p class="hui-note"><strong>${escapeHtml(t("huiNoteLabel"))}</strong>${escapeHtml(clean(artist.huiNote))}</p>` : ""}
        ${instagram || kind !== "detail" ? `<div class="card-actions">${instagram ? `<a class="ig-link" href="${escapeHtml(instagram)}" target="_blank" rel="noopener noreferrer">Instagram ↗</a>` : ""}${kind !== "detail" ? `<button type="button" class="detail-button">${escapeHtml(t("cardDetails"))} <span aria-hidden="true">→</span></button>` : ""}</div>` : ""}
      </div>`;
    card.querySelector(".detail-button")?.addEventListener("click", () => openArtist(artist.id));
    card.querySelector(".ig-link")?.addEventListener("click", () => { if (artist.id) trackArtistClick(artist.id); });
    card.querySelector("img")?.addEventListener("error", (event) => {
      const media = event.target.parentElement;
      media.classList.remove("has-image");
      media.innerHTML = `<span class="card-monogram" aria-hidden="true">${escapeHtml(initials(name))}</span><span class="card-index" aria-hidden="true">${escapeHtml(t("cardIndexLabel"))} / ${String(index + 1).padStart(2, "0")}</span>`;
    }, { once: true });
    return card;
  }

  function renderFilters() {
    const allArtists = artists();
    const filterConfig = [["regionFilters", "region"], ["schoolFilters", "school"], ["tagFilters", "tag"]];
    filterConfig.forEach(([id, field]) => {
      const select = $(id);
      const values = [...new Set(field === "tag" ? allArtists.flatMap(ArtistIndex.tags) : allArtists.map((artist) => artist[field]).filter((value) => ArtistIndex.clean(value)))].sort((a, b) => a.localeCompare(b, "ja"));
      select.replaceChildren();
      [ALL, ...values].forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === ALL ? t("filterAll") : label(value);
        select.append(option);
      });
      select.value = state[field];
      select.disabled = !state.loaded || state.loading;
    });
  }

  function renderActiveFilters() {
    const container = $("activeFilters");
    container.replaceChildren();
    ["query", "region", "school", "tag"].forEach((field) => {
      const value = state[field];
      if (!value || value === ALL || (field === "query" && !value.trim())) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "active-filter";
      const displayValue = field === "query" ? value : label(value);
      button.setAttribute("aria-label", t("removeFilter", displayValue));
      button.textContent = `${displayValue} ×`;
      button.addEventListener("click", () => {
        state[field] = field === "query" ? "" : ALL;
        renderFilters();
        renderCards();
        $(field === "query" ? "searchInput" : `${field}Filters`).focus();
      });
      container.append(button);
    });
    container.hidden = !container.childElementCount;
    $("resetButton").hidden = !container.childElementCount;
  }

  function renderCards() {
    const nextSignature = JSON.stringify([state.query, state.region, state.school, state.tag, onlyFavorites]);
    if (filterSignature !== null && filterSignature !== nextSignature) limit = PAGE_SIZE;
    filterSignature = nextSignature;
    $("artistGrid").classList.toggle("is-list", view === "list");
    $("gridViewButton").setAttribute("aria-pressed", String(view === "grid"));
    $("listViewButton").setAttribute("aria-pressed", String(view === "list"));
    $("favoritesToggle").setAttribute("aria-pressed", String(onlyFavorites));
    $("favoritesScope").hidden = !onlyFavorites;
    persistBrowse();
    [$("searchInput"), $("heroSearchInput")].forEach((input) => { if (input.value !== state.query) input.value = state.query; });
    renderActiveFilters();
    const container = $("artistGrid");
    const loading = state.loading || !state.loaded;
    container.setAttribute("aria-busy", String(loading));
    $("loadMoreButton").hidden = true;
    $("shownCount").textContent = "";
    $("heroSearchResult").hidden = !state.query.trim() || loading;
    if (loading) {
      $("resultText").textContent = t("loadingArtists");
      skeleton(container, 3);
      return;
    }
    const list = filtered();
    $("resultText").textContent = state.loadError && !state.artists.length ? t("loadFailed") : t("resultText", list.length);
    $("heroSearchResult").textContent = t("searchResultsLink", list.length);
    if (!list.length) {
      const favoritesKey = IndexAccount.ids().length ? "favoritesNoMatches" : "favoritesEmpty";
      empty(container, state.loadError ? noDataKey() : onlyFavorites ? favoritesKey : state.artists.length ? "emptyResults" : noDataKey(), state.loadError);
      if (onlyFavorites) {
        const button = document.createElement("button");
        button.className = "outline-button";
        button.type = "button";
        button.textContent = t("allDirectory");
        button.addEventListener("click", () => { onlyFavorites = false; renderCards(); });
        container.firstElementChild.append(button);
      }
      return;
    }
    const visible = list.slice(0, limit);
    container.replaceChildren(...visible.map((artist, index) => createCard(artist, { index })));
    $("shownCount").textContent = t("showingArtists", visible.length, list.length);
    $("loadMoreButton").hidden = list.length <= limit;
  }

  function renderStats() {
    const loading = !state.loaded || state.loading;
    $("statistics").setAttribute("aria-busy", String(loading));
    const values = [state.artists.length, new Set(state.artists.map((artist) => ArtistIndex.clean(artist.region)).filter(Boolean)).size, new Set(state.artists.map((artist) => ArtistIndex.clean(artist.school)).filter(Boolean)).size, new Set(state.artists.flatMap(ArtistIndex.tags)).size];
    ["artistCount", "regionCount", "schoolCount", "styleCount"].forEach((id, index) => { $(id).textContent = loading || (state.loadError && !state.artists.length) ? "—" : values[index]; });
  }

  function renderDiscovery() {
    const allArtists = artists();
    const loading = !state.loaded || state.loading;
    // Keep Recently Added visible while data loads; Nihonga Now owns slot 03.
    $("recent").hidden = false;
    $("randomButton").disabled = loading || !allArtists.length;
    ["featuredGrid", "recentGrid"].forEach((id) => $(id).setAttribute("aria-busy", String(loading)));
    $("quickTags").replaceChildren();
    if (loading) {
      skeleton($("featuredGrid"), 4);
      skeleton($("recentGrid"), 4);
      return;
    }
    if (!allArtists.length) {
      empty($("featuredGrid"), noDataKey());
      empty($("recentGrid"), noDataKey());
      empty($("randomArtist"), "noDiscovery");
      return;
    }
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
    $("featuredDescription").textContent = t(allArtists.some((artist) => artist.featured === true) ? "featuredManual" : "featuredDaily");
    $("featuredGrid").replaceChildren(...ArtistIndex.featured(allArtists, date).map((artist, index) => createCard(artist, { kind: "featured", index })));
    const recent = ArtistIndex.recent(allArtists);
    if (recent.length) $("recentGrid").replaceChildren(...recent.map((artist) => createCard(artist, { kind: "recent" })));
    else empty($("recentGrid"), "recentUnavailable");
    const availableTags = [...new Set(allArtists.flatMap(ArtistIndex.tags))];
    // Only existing tags. Do not infer subjects or techniques from biographies.
    const preferred = ["人物", "動物", "花鳥", "風景", "幻想", "抽象", "絵画", "日本画家", "若手作家", "中国/華人"];
    const quickTags = [...new Set([...preferred.filter((tag) => availableTags.includes(tag)), ...availableTags.filter((tag) => tag !== "日本画")])].slice(0, 5);
    quickTags.forEach((tag) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label(tag);
      button.addEventListener("click", () => {
        state.tag = tag;
        renderFilters(); renderCards(); scrollDirectory();
      });
      $("quickTags").append(button);
    });
    if (randomId) {
      const selected = allArtists.find((artist) => artist.id === randomId);
      if (selected) $("randomArtist").replaceChildren(createCard(selected, { kind: "random" }));
    }
    $("randomButton").querySelector("[data-i18n]").textContent = t(randomId ? "randomAgain" : "randomButton");
  }

  function renderDetail() {
    const artist = artists().find((item) => item.id === detailId);
    if (!artist) return;
    const container = $("artistDetail");
    container.replaceChildren(createCard(artist, { kind: "detail" }));
    if (ArtistIndex.clean(artist.note)) {
      const source = document.createElement("details");
      source.className = "detail-source";
      source.innerHTML = `<summary>${escapeHtml(t("sourceNote"))}</summary><p>${escapeHtml(artist.note)}</p>`;
      container.append(source);
    }
    const footer = document.createElement("div");
    footer.className = "detail-footer";
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = "favorite-button";
    favorite.setAttribute("aria-pressed", String(IndexAccount.saved(artist.id)));
    favorite.textContent = t(IndexAccount.saved(artist.id) ? "removeFavorite" : "saveArtist");
    favorite.addEventListener("click", () => IndexAccount.toggle(artist.id));
    footer.append(favorite);
    const share = document.createElement("button");
    share.type = "button";
    share.textContent = t("shareArtist");
    share.addEventListener("click", () => openShare(artist.id));
    footer.append(share);
    const sources = [];
    const futureSources = Array.isArray(artist.sources) ? artist.sources : Array.isArray(artist.artist_sources) ? artist.artist_sources : [];
    futureSources.forEach((item) => {
      const url = ArtistIndex.safeUrl(item?.url || item?.sourceUrl || item?.source_url);
      if (url && !sources.some((source) => source.url === url)) sources.push({ url, name: ArtistIndex.clean(item?.name || item?.sourceName || item?.source_name) || t("sourceLabel"), type: ArtistIndex.clean(item?.type || item?.sourceType || item?.source_type) });
    });
    const legacySource = ArtistIndex.safeUrl(artist.sourcePage);
    if (legacySource && !sources.some((source) => source.url === legacySource)) sources.push({ url: legacySource, name: t("sourceLabel"), type: "" });
    const instagramSource = ArtistIndex.instagram(artist);
    if (instagramSource && !sources.some((source) => source.url === instagramSource)) sources.push({ url: instagramSource, name: "Instagram", type: "SNS" });
    if (sources.length === 1) {
      const link = document.createElement("a");
      link.href = sources[0].url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = t("sourceLabel");
      link.addEventListener("click", () => trackArtistClick(artist.id));
      footer.append(link);
    } else if (sources.length > 1) {
      const details = document.createElement("details");
      details.className = "detail-sources-popover";
      const summary = document.createElement("summary");
      summary.textContent = t("sourceLabel");
      details.append(summary);
      const list = document.createElement("ul");
      sources.slice(0, 12).forEach((source) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = source.name;
        link.addEventListener("click", () => trackArtistClick(artist.id));
        item.append(link);
        if (source.type) { const type = document.createElement("small"); type.textContent = source.type; item.append(type); }
        list.append(item);
      });
      details.append(list);
      footer.append(details);
    }
    const report = document.createElement("button");
    report.type = "button";
    report.textContent = t("cardReport");
    report.addEventListener("click", () => {
      $("artistDialog").close();
      $("correction-panel").open = true;
      els.correctionArtistSelect.value = artist.id;
      els.correctionArtistSelect.dispatchEvent(new Event("change"));
      $("correction-panel").scrollIntoView({ behavior: "auto", block: "start" });
      $("correctionForm").querySelector("textarea").focus({ preventScroll: true });
    });
    footer.append(report);
    container.append(footer);
  }

  function openArtist(id) {
    detailId = id;
    $("artistActionStatus").textContent = "";
    renderDetail();
    $("artistDialog").showModal();
  }

  function scrollDirectory() {
    $("all-artists").scrollIntoView({ behavior: "auto", block: "start" });
    $("directoryTitle").focus({ preventScroll: true });
  }

  function renderFinder() {
    $("finderPrompts").replaceChildren();
    t("finderPrompts").forEach((prompt) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = prompt;
      button.addEventListener("click", () => { $("finderInput").value = prompt; $("finderInput").focus(); });
      $("finderPrompts").append(button);
    });
    if (finderSent) $("finderStatus").textContent = t("finderComingSoon");
  }

  function renderContributionLabels() {
    document.querySelectorAll(".submission-panel").forEach((panel) => {
      panel.querySelector(".submission-expand").textContent = t(panel.open ? "rankingCollapse" : "submitExpand");
    });
  }

  function render() {
    document.documentElement.lang = { zh: "zh-CN", en: "en", ja: "ja" }[I18N.current] || "ja";
    if (!IndexAccount.member()) onlyFavorites = false;
    renderFilters(); renderStats(); renderCards(); renderDiscovery(); renderFinder(); renderContributionLabels(); IndexAccount.render();
    document.querySelector('meta[name="description"]').content = t("metaDescription");
    document.querySelectorAll('img[src="assets/hasegawa-pine-trees.jpg"]').forEach((image) => { if (image.alt) image.alt = t("imageTitle"); });
    if (state.syncKey) $("syncStatus").textContent = t(state.syncKey);
    if ($("artistDialog").open) renderDetail();
  }

  function init() {
    shared = IndexPreferences.fromUrl(location.href);
    let stored;
    try { stored = IndexPreferences.read(sessionStorage, IndexPreferences.BROWSE_KEY, {}); } catch { stored = {}; }
    const hasStoredView = stored?.view === "grid" || stored?.view === "list";
    const hasSharedView = new URL(location.href).searchParams.has("view");
    savedBrowse = shared.explicit ? shared.browse : IndexPreferences.sanitize(stored);
    ["query", "region", "school", "tag"].forEach((key) => { state[key] = savedBrowse[key]; });
    limit = savedBrowse.limit;
    randomId = savedBrowse.randomId || null;
    view = hasSharedView || hasStoredView ? savedBrowse.view : window.matchMedia("(max-width: 760px)").matches ? "list" : "grid";
    if (shared.lang) {
      try { I18N.setLang(shared.lang); } catch { I18N.current = shared.lang; }
      els.langSelect.value = shared.lang;
      els.loginLangSelect.value = shared.lang;
      I18N.applyToDOM();
    }
    IndexAccount.init({ onChange: () => {
      IndexAccount.render(); renderCards(false);
      if ($("artistDialog").open) { renderDetail(); $("artistDetail").querySelector(".favorite-button").focus({ preventScroll: true }); }
    }, onFavorites: () => {
      onlyFavorites = true; state.query = ""; state.region = ALL; state.school = ALL; state.tag = ALL;
      renderFilters(); renderCards(); scrollDirectory();
    } });
    $("favoritesToggle").addEventListener("click", () => { if (IndexAccount.member()) { onlyFavorites = !onlyFavorites; renderCards(); } });
    $("shareSearchButton").addEventListener("click", () => openShare());
    $("copyLinkButton").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("shareLinkInput").value); $("shareStatus").textContent = t("copiedLink"); }
      catch { $("shareLinkInput").focus(); $("shareLinkInput").select(); $("shareStatus").textContent = t("copyManually"); }
    });
    window.addEventListener("scroll", () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(persistBrowse, 150); }, { passive: true });
    window.addEventListener("pagehide", persistBrowse);
    window.addEventListener("storage", (event) => { if (event.key === null || event.key?.startsWith("nihonga:favorites:v1:")) { IndexAccount.render(); renderCards(false); if ($("artistDialog").open) renderDetail(); } });
    document.querySelectorAll(".submission-panel").forEach((panel) => panel.addEventListener("toggle", renderContributionLabels));
    ["region", "school", "tag"].forEach((field) => $(`${field}Filters`).addEventListener("change", (event) => { state[field] = event.target.value; renderCards(); }));
    $("heroSearchInput").addEventListener("input", (event) => { state.query = event.target.value; renderCards(); });
    $("heroSearchForm").addEventListener("submit", (event) => { event.preventDefault(); scrollDirectory(); });
    $("loadMoreButton").addEventListener("click", () => {
      const previousLimit = limit;
      limit += PAGE_SIZE;
      renderCards(false);
      $("artistGrid").children[previousLimit]?.querySelector(".artist-name-link")?.focus({ preventScroll: true });
    });
    ["grid", "list"].forEach((nextView) => $(`${nextView}ViewButton`).addEventListener("click", () => {
      view = nextView;
      renderCards(false);
    }));
    $("randomButton").addEventListener("click", () => {
      const artist = ArtistIndex.random(artists(), randomId);
      if (!artist) return;
      randomId = artist.id;
      persistBrowse();
      $("randomArtist").replaceChildren(createCard(artist, { kind: "random" }));
      $("randomButton").querySelector("[data-i18n]").textContent = t("randomAgain");
    });
    document.querySelectorAll("[data-open-finder]").forEach((button) => button.addEventListener("click", () => $("aiFinderDialog").showModal()));
    document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
    document.querySelectorAll(".index-dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    }));
    $("aiFinderForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const response = await ArtistFinderService.findArtists({ query: $("finderInput").value.trim() });
      if (response.status === "coming-soon") { finderSent = true; $("finderStatus").textContent = t("finderComingSoon"); }
    });
    render();
    syncAccess();
  }
  function persistBrowse() {
    if (!resumed || !state.user) return;
    try { IndexPreferences.write(sessionStorage, IndexPreferences.BROWSE_KEY, IndexPreferences.sanitize({ ...state, view, limit, randomId, scrollY: window.scrollY })); } catch { /* Browsing still works without storage. */ }
  }
  function resume() {
    syncAccess();
    if (resumed || !state.user || !state.loaded || !els.welcomeOverlay.hidden || !els.loginOverlay.hidden) return;
    resumed = true;
    requestAnimationFrame(() => {
      if (shared.artistId) {
        if (state.artists.some((artist) => artist.id === shared.artistId)) openArtist(shared.artistId);
        else $("experienceStatus").textContent = t("missingArtist");
      } else if (shared.explicit) scrollDirectory();
      else if (savedBrowse.scrollY) window.scrollTo({ top: savedBrowse.scrollY, behavior: "instant" });
      persistBrowse();
    });
  }
  async function openShare(artistId) {
    const returnToArtist = $("artistDialog").open;
    if (returnToArtist) $("artistDialog").close();
    const artist = artistId ? artists().find((item) => item.id === artistId) : null;
    const artistSlug = artist ? String(artist.slug || ArtistIndex.slug?.(artist) || artist.id) : "";
    const shareUrl = artistSlug ? new URL(`/artists/${encodeURIComponent(artistSlug)}`, location.origin).href : IndexPreferences.shareUrl(location.href, { ...state, view }, I18N.current);
    if (artistId && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `${artist?.name || "日本画作家"}｜NIHONGA INDEX`, text: "日本画作家インデックス", url: shareUrl });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    $("shareLinkInput").value = shareUrl;
    $("shareStatus").textContent = "";
    $("localShareHelp").hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    $("shareDialog").showModal();
    if (returnToArtist) $("shareDialog").addEventListener("close", () => { if (state.user && !$("accountDialog").open) openArtist(artistId); }, { once: true });
  }
  function accountChanged() {
    onlyFavorites = false;
    render();
  }
  function syncAccess() {
    const welcomeOpen = !els.welcomeOverlay.hidden;
    els.loginOverlay.inert = welcomeOpen;
    $("home").inert = welcomeOpen || !els.loginOverlay.hidden;
  }
  return { init, render, renderCards, renderStats, filtered, resume, accountChanged, syncAccess };
})();
