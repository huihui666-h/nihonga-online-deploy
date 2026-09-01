const ALL = "全部";
const CACHE_KEY = "nihongaOnlineArtists";
const GUEST_KEY = "nihongaGuestAccess";

const state = {
  artists: [],
  rankings: [],
  user: null,
  authMode: "login",
  rankingExpanded: false,
  query: "",
  region: ALL,
  school: ALL,
  tag: ALL,
  loaded: false,
  loading: false,
  loadError: false,
  rankingLoaded: false,
  syncKey: "heroSync"
};

const els = {
  welcomeOverlay: document.querySelector("#welcomeOverlay"),
  welcomeEnterBtn: document.querySelector("#welcomeEnterBtn"),
  loginOverlay: document.querySelector("#loginOverlay"),
  loginForm: document.querySelector("#loginForm"),
  loginModeButton: document.querySelector("#loginModeButton"),
  registerModeButton: document.querySelector("#registerModeButton"),
  loginTitle: document.querySelector("#loginTitle"),
  loginDesc: document.querySelector("#loginDesc"),
  displayNameField: document.querySelector("#displayNameField"),
  displayNameInput: document.querySelector("#displayNameInput"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  passwordConfirmField: document.querySelector("#passwordConfirmField"),
  passwordConfirmInput: document.querySelector("#passwordConfirmInput"),
  rememberLoginInput: document.querySelector("#rememberLoginInput"),
  loginButton: document.querySelector("#loginButton"),
  guestLoginButton: document.querySelector("#guestLoginButton"),
  loginMessage: document.querySelector("#loginMessage"),
  logoutButton: document.querySelector("#logoutButton"),
  searchInput: document.querySelector("#searchInput"),
  regionFilters: document.querySelector("#regionFilters"),
  schoolFilters: document.querySelector("#schoolFilters"),
  artistGrid: document.querySelector("#artistGrid"),
  resultText: document.querySelector("#resultText"),
  artistCount: document.querySelector("#artistCount"),
  regionCount: document.querySelector("#regionCount"),
  schoolCount: document.querySelector("#schoolCount"),
  styleCount: document.querySelector("#styleCount"),
  resetButton: document.querySelector("#resetButton"),
  syncStatus: document.querySelector("#syncStatus"),
  rankingList: document.querySelector("#rankingList"),
  rankingToggleButton: document.querySelector("#rankingToggleButton"),
  submissionForm: document.querySelector("#submissionForm"),
  submissionMessage: document.querySelector("#submissionMessage"),
  correctionForm: document.querySelector("#correctionForm"),
  correctionMessage: document.querySelector("#correctionMessage"),
  correctionArtistSelect: document.querySelector("#correctionForm select[name=artistId]"),
  langSelect: document.querySelector("#langSelect"),
  loginLangSelect: document.querySelector("#loginLangSelect"),
  mobileFilterToggle: document.querySelector("#mobileFilterToggle"),
  sidebarControls: document.querySelector("#sidebarControls")
};

function setMessage(message, isError = false) {
  els.loginMessage.textContent = message;
  els.loginMessage.classList.toggle("is-error", isError);
}

function setSubmissionMessage(message, isError = false) {
  els.submissionMessage.textContent = message;
  els.submissionMessage.classList.toggle("is-error", isError);
}

function setSync(key, mode = "") {
  state.syncKey = key;
  els.syncStatus.textContent = I18N.t(key);
  els.syncStatus.dataset.mode = mode;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message || "请求失败。");
    error.status = response.status;
    throw error;
  }
  return data;
}

function authUserFromResponse(data) {
  if (!data || typeof data !== "object") return null;
  if (data.user && typeof data.user === "object") return data.user;
  if (data.account && typeof data.account === "object") return data.account;
  if (data.session && data.session.user && typeof data.session.user === "object") return data.session.user;
  return null;
}

function isAuthenticatedResponse(data) {
  return Boolean(authUserFromResponse(data) || data?.authenticated === true || data?.loggedIn === true);
}

function setAuthMode(mode) {
  state.authMode = mode === "register" ? "register" : "login";
  const registering = state.authMode === "register";
  els.loginForm.classList.toggle("is-register", registering);
  els.loginModeButton.classList.toggle("is-active", !registering);
  els.registerModeButton.classList.toggle("is-active", registering);
  els.loginModeButton.setAttribute("aria-selected", String(!registering));
  els.registerModeButton.setAttribute("aria-selected", String(registering));
  els.displayNameField.hidden = !registering;
  els.passwordConfirmField.hidden = !registering;
  els.displayNameInput.required = false;
  els.passwordConfirmInput.required = registering;
  els.passwordInput.autocomplete = registering ? "new-password" : "current-password";
  els.loginTitle.textContent = I18N.t(registering ? "registerTitle" : "loginTitle");
  els.loginDesc.textContent = I18N.t(registering ? "registerDesc" : "loginDesc");
  els.loginButton.textContent = I18N.t(registering ? "registerButton" : "loginButton");
  els.loginMessage.textContent = I18N.t(registering ? "registerDefault" : "loginDefault");
  els.loginMessage.classList.remove("is-error");
}

function showDirectory() {
  els.loginOverlay.hidden = true;
  IndexUI.resume();
}

function showLogin(message = "", isError = false) {
  els.loginOverlay.hidden = false;
  IndexUI.syncAccess();
  if (message) setMessage(message, isError);
}

async function unlockWithSession(result, silent = false) {
  sessionStorage.removeItem(GUEST_KEY);
  state.user = authUserFromResponse(result) || {};
  if (!silent) setMessage(result.message || I18N.t("loginSuccess"));
  await loadArtists();
  await loadRankings();
  if (!silent) await delay(350);
  showDirectory();
}

async function unlockAsGuest(silent = false) {
  state.user = { guest: true };
  sessionStorage.setItem(GUEST_KEY, "1");
  if (!silent) setMessage(I18N.t("guestLoading"));
  await loadArtists();
  await loadRankings();
  if (!silent) await delay(250);
  showDirectory();
}

async function submitAuth() {
  const email = String(els.emailInput.value || "").trim().toLowerCase();
  const password = String(els.passwordInput.value || "");
  const passwordConfirm = String(els.passwordConfirmInput.value || "");
  const registering = state.authMode === "register";

  if (!email || !els.emailInput.checkValidity()) {
    setMessage(I18N.t("msgNeedEmail"), true);
    els.emailInput.focus();
    return;
  }
  if (!password || password.length < 8) {
    setMessage(I18N.t("msgNeedPasswordLength"), true);
    els.passwordInput.focus();
    return;
  }
  if (registering && password !== passwordConfirm) {
    setMessage(I18N.t("msgPasswordMismatch"), true);
    els.passwordConfirmInput.focus();
    return;
  }

  els.loginButton.disabled = true;
  setMessage(I18N.t(registering ? "msgRegistering" : "msgLoggingIn"));
  try {
    const result = await api(registering ? "/api/auth-register" : "/api/auth-login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        confirmPassword: registering ? passwordConfirm : undefined,
        displayName: String(els.displayNameInput.value || "").trim(),
        remember: Boolean(els.rememberLoginInput.checked)
      })
    });

    if (!isAuthenticatedResponse(result)) {
      if (registering) setAuthMode("login");
      setMessage(result.message || I18N.t("registerCheckEmail"));
      return;
    }

    await unlockWithSession(result);
    els.passwordInput.value = "";
    els.passwordConfirmInput.value = "";
  } catch (error) {
    showLogin(error.message, true);
  } finally {
    els.loginButton.disabled = false;
  }
}

async function restoreSession() {
  try {
    const result = await api("/api/auth-session", { method: "GET" });
    if (isAuthenticatedResponse(result)) {
      await unlockWithSession(result, true);
      return true;
    }
  } catch {
    // An unavailable session endpoint should leave the sign-in form usable.
  }

  if (sessionStorage.getItem(GUEST_KEY) === "1") {
    try {
      await unlockAsGuest(true);
      return true;
    } catch {
      sessionStorage.removeItem(GUEST_KEY);
    }
  }
  return false;
}

async function loadArtists() {
  state.loading = true;
  state.loadError = false;
  setSync("syncing", "loading");
  render();
  try {
    const data = await api("/api/artists");
    state.artists = Array.isArray(data.artists) ? data.artists : [];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.artists)); } catch { /* Storage is optional. */ }
    setSync("synced", "ok");
  } catch (error) {
    let cached = [];
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
      if (Array.isArray(saved)) cached = saved;
    } catch { /* A damaged cache must not prevent browsing or retrying. */ }
    state.artists = cached;
    state.loadError = !cached.length;
    setSync(cached.length ? "cacheWarn" : "syncError", cached.length ? "warn" : "error");
  }
  state.loading = false;
  state.loaded = true;
  render();
  populateCorrectionDropdown();
}

async function loadRankings() {
  try {
    const data = await api("/api/rankings");
    state.rankings = Array.isArray(data.rankings) ? data.rankings : [];
  } catch {
    state.rankings = [];
  }
  state.rankingLoaded = true;
  renderRankings();
}

function unique(key) {
  const values = state.artists.map((artist) => artist[key]).filter(Boolean);
  return [ALL, ...new Set(values)];
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name) {
  return String(name || "NI").replace(/^示例艺术家/, "").slice(0, 2).toUpperCase();
}

function filteredArtists() {
  return IndexUI.filtered();
}



function renderStats() {
  IndexUI.renderStats();
}

function renderRankings() {
  els.rankingList.innerHTML = "";
  els.rankingToggleButton.hidden = true;

  if (!state.rankingLoaded) {
    els.rankingList.textContent = I18N.t("loadingRanking");
    return;
  }

  if (!state.rankings.length) {
    const empty = document.createElement("p");
    empty.className = "ranking-empty";
    empty.textContent = I18N.t("emptyRanking");
    els.rankingList.append(empty);
    return;
  }

  const visibleRankings = state.rankings.slice(0, state.rankingExpanded ? 10 : 3);
  els.rankingToggleButton.hidden = state.rankings.length <= 3;
  els.rankingToggleButton.textContent = state.rankingExpanded ? I18N.t("rankingCollapse") : I18N.t("rankingToggle");

  visibleRankings.forEach((item, index) => {
    const link = document.createElement("a");
    link.href = item.instagram || "#";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "ranking-item";
    link.innerHTML = `
      <strong>${index + 1}</strong>
      <span>${escapeHtml(item.name)}</span>
      <em>${escapeHtml(String(item.count))}${escapeHtml(I18N.t("rankingCountSuffix"))}</em>
    `;
    if (item.id) {
      link.addEventListener("click", () => trackArtistClick(item.id));
    }
    els.rankingList.append(link);
  });
}

function renderCards() {
  IndexUI.renderCards();
}

function render() {
  IndexUI.render();
}

function trackArtistClick(artistId) {
  bumpRankingCount(artistId);
  const payload = JSON.stringify({ artistId });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/track-click", new Blob([payload], { type: "application/json" }));
    setTimeout(loadRankings, 900);
    return;
  }

  fetch("/api/track-click", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true
  }).finally(() => setTimeout(loadRankings, 900));
}

function bumpRankingCount(artistId) {
  const current = state.rankings.find((item) => item.id === artistId);
  if (current) {
    current.count += 1;
  } else {
    const artist = state.artists.find((item) => item.id === artistId);
    if (artist) {
      state.rankings.push({
        id: artist.id,
        count: 1,
        name: artist.name || "",
        handle: artist.handle || "",
        instagram: artist.instagram || ""
      });
    }
  }
  state.rankings.sort((a, b) => b.count - a.count);
  renderRankings();
}

function normalizeSubmissionInstagram(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  if (match) return `https://www.instagram.com/${match[1].replace(/\/+$/, "")}/`;
  return `https://www.instagram.com/${text.replace(/^@/, "").replace(/\/+$/, "")}/`;
}

els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth();
});

els.loginModeButton.addEventListener("click", () => setAuthMode("login"));
els.registerModeButton.addEventListener("click", () => setAuthMode("register"));

els.guestLoginButton.addEventListener("click", async () => {
  els.guestLoginButton.disabled = true;
  try {
    await unlockAsGuest();
  } catch (error) {
    sessionStorage.removeItem(GUEST_KEY);
    showLogin(error.message, true);
  } finally {
    els.guestLoginButton.disabled = false;
  }
});

els.logoutButton.addEventListener("click", async () => {
  els.logoutButton.disabled = true;
  try {
    await api("/api/auth-logout", { method: "POST", body: JSON.stringify({}) });
  } catch {
    // Clear the local view even if the server session has already expired.
  } finally {
    els.logoutButton.disabled = false;
    sessionStorage.removeItem(GUEST_KEY);
    state.user = null;
    els.emailInput.value = "";
    els.passwordInput.value = "";
    els.passwordConfirmInput.value = "";
    els.rememberLoginInput.checked = false;
    setAuthMode("login");
    IndexUI.accountChanged();
    showLogin(I18N.t("msgLogout"));
  }
});

function setMobileFiltersOpen(open) {
  if (!els.mobileFilterToggle || !els.sidebarControls) return;
  els.mobileFilterToggle.setAttribute("aria-expanded", String(open));
  els.sidebarControls.classList.toggle("is-open", open);
}

if (els.mobileFilterToggle && els.sidebarControls) {
  els.mobileFilterToggle.addEventListener("click", () => {
    const open = els.mobileFilterToggle.getAttribute("aria-expanded") !== "true";
    setMobileFiltersOpen(open);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setMobileFiltersOpen(false);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) setMobileFiltersOpen(false);
  });
}

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderCards();
});

els.resetButton.addEventListener("click", () => {
  state.query = "";
  state.region = ALL;
  state.school = ALL;
  state.tag = ALL;
  els.searchInput.value = "";
  render();
  populateCorrectionDropdown();
});

els.rankingToggleButton.addEventListener("click", () => {
  state.rankingExpanded = !state.rankingExpanded;
  renderRankings();
});

function populateCorrectionDropdown() {
  const select = els.correctionArtistSelect;
  if (!select) return;
  while (select.options.length > 1) select.remove(1);
  state.artists.slice().sort((a, b) => a.name.localeCompare(b.name, "ja")).forEach((artist) => {
    const option = document.createElement("option");
    option.value = artist.id;
    const school = ArtistIndex.clean(artist.school);
    option.textContent = school ? `${artist.name} (${school})` : artist.name;
    select.append(option);
  });
}

els.submissionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.submissionForm);
  const payload = {
    name: String(form.get("name") || "").trim(),
    instagram: normalizeSubmissionInstagram(form.get("instagram")),
    school: String(form.get("school") || "").trim(),
    note: String(form.get("note") || "").trim()
  };

  if (!payload.name || !payload.instagram) {
    setSubmissionMessage(I18N.t("msgNeedNameAndIG"), true);
    return;
  }

  try {
    setSubmissionMessage(I18N.t("msgSubmitting"));
    await api("/api/submissions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    els.submissionForm.reset();
    setSubmissionMessage(I18N.t("msgSubmitted"));
  } catch (error) {
    setSubmissionMessage(error.status === 401 ? I18N.t("memberOnlyContribution") : error.message, true);
  }
});

els.correctionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.correctionForm);
  const artistId = String(form.get("artistId") || "").trim();
  const note = String(form.get("note") || "").trim();

  if (!artistId || !note) {
    els.correctionMessage.textContent = I18N.t("msgNeedArtistAndNote");
    els.correctionMessage.classList.add("is-error");
    return;
  }

  const artist = state.artists.find((a) => a.id === artistId);
  try {
    els.correctionMessage.textContent = I18N.t("correctSubmitting");
    els.correctionMessage.classList.remove("is-error");
    await api("/api/report-correction", {
      method: "POST",
      body: JSON.stringify({
        artistId,
        artistName: artist ? artist.name : "",
        note
      })
    });
    els.correctionForm.reset();
    els.correctionMessage.textContent = I18N.t("correctDone");
  } catch (error) {
    els.correctionMessage.textContent = error.status === 401 ? I18N.t("memberOnlyContribution") : error.message;
    els.correctionMessage.classList.add("is-error");
  }
});

function refreshI18n() { if (typeof I18N !== "undefined") { I18N.applyToDOM(); I18N.applyToDOM(els.loginOverlay); I18N.applyToDOM(els.welcomeOverlay); setAuthMode(state.authMode); } render(); renderRankings(); }
els.langSelect.addEventListener("change", () => { I18N.setLang(els.langSelect.value); if (els.loginLangSelect) els.loginLangSelect.value = I18N.current; refreshI18n(); });
if (els.langSelect && typeof I18N !== "undefined") { els.langSelect.value = I18N.current; } if (els.loginLangSelect && typeof I18N !== "undefined") { els.loginLangSelect.value = I18N.current; els.loginLangSelect.addEventListener("change", () => { I18N.setLang(els.loginLangSelect.value); if (els.langSelect) els.langSelect.value = I18N.current; refreshI18n(); }); }
I18N.applyToDOM();
IndexUI.init();

// Welcome page logic. Returning visitors with an existing session can resume
// the directory without having to pass through the welcome screen again.
setAuthMode("login");
const initialSession = restoreSession();

function enterWelcome({ animate = true } = {}) {
  if (els.welcomeOverlay.hidden) return;
  if (!animate) {
    els.welcomeOverlay.classList.remove("fade-out");
    els.welcomeOverlay.hidden = true;
    IndexUI.syncAccess();
    IndexUI.resume();
    return;
  }
  els.welcomeOverlay.classList.add("fade-out");
  setTimeout(() => {
    els.welcomeOverlay.hidden = true;
    IndexUI.resume();
  }, 800);
}

els.welcomeEnterBtn.addEventListener("click", () => {
  enterWelcome();
  initialSession.then((restored) => {
    if (!restored) showLogin();
  });
});

initialSession.then((restored) => {
  if (restored) enterWelcome({ animate: false });
  else showLogin();
});



