/* Account presentation and optional local favorites. Authentication stays in app.js. */
const IndexAccount = (() => {
  const $ = (id) => document.getElementById(id);
  const t = (key, ...args) => I18N.t(key, ...args);
  let onChange = () => {};
  let onFavorites = () => {};
  // Access can throw in restricted browsers; helpers report storage failure honestly.
  const storage = () => { try { return window.localStorage; } catch { return null; } };
  const member = () => Boolean(IndexPreferences.memberId(state.user));
  const ids = () => IndexPreferences.favorites(storage(), state.user);
  const saved = (id) => member() && ids().includes(id);
  function comparison() {
    const rows = [
      ["featureBrowse", "featureAvailable", "featureAvailable"],
      ["featureContribute", "featureRegister", "featureAvailable"],
      ["featureHistory", "featureAvailable", "featureAvailable"],
      ["featureFavorites", "featureRegister", "featureAvailable"],
      ["featureSession", "featureGuestSession", "featureMemberSession"]
    ];
    return `<table class="access-table"><caption class="sr-only">${escapeHtml(t("accountGuide"))}</caption><thead><tr>${["featureLabel", "accountGuest", "accountMember"].map((key) => `<th scope="col">${escapeHtml(t(key))}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(t(row[0]))}</th>${row.slice(1).map((key) => `<td>${escapeHtml(t(key))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  function render() {
    const registered = member();
    $("accountButton").textContent = t(registered ? "accountMember" : state.user?.guest ? "accountEntry" : "accountUnknown");
    $("accountButton").dataset.accountType = registered ? "member" : "guest";
    $("accountBadge").textContent = t(registered ? "accountMember" : "accountGuest");
    $("accountName").textContent = registered ? ArtistIndex.clean(state.user.displayName) || t("accountMember") : t("accountGuest");
    $("accountDescription").textContent = t(registered ? "memberDescription" : "guestDescription");
    $("guestAccountActions").hidden = registered;
    $("memberAccountActions").hidden = !registered;
    $("favoritesToggle").hidden = !registered;
    document.querySelectorAll("[data-member-only-notice]").forEach((notice) => { notice.hidden = registered; });
    document.querySelectorAll("[data-member-only-form]").forEach((form) => {
      form.toggleAttribute("aria-disabled", !registered);
      form.querySelectorAll("input, textarea, select, button").forEach((control) => { control.disabled = !registered; });
    });
    const favoriteIds = new Set(ids());
    const count = state.artists.filter((artist) => favoriteIds.has(artist.id)).length;
    $("accountFavorites").textContent = t("favoritesCount", count);
    $("favoritesToggle").textContent = t("favoritesCount", count);
    document.querySelectorAll("[data-access-comparison]").forEach((element) => { element.innerHTML = comparison(); });
  }
  function open() {
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    render();
    $("accountDialog").showModal();
  }
  function signIn(mode) {
    $("accountDialog").close();
    setAuthMode(mode);
    showLogin();
    els.emailInput.focus();
  }
  function toggle(id) {
    if (!member()) { open(); return; }
    const result = IndexPreferences.toggleFavorite(storage(), state.user, id, state.artists);
    if (!result.ok) { $("experienceStatus").textContent = t("storageUnavailable"); $("artistActionStatus").textContent = t("storageUnavailable"); return; }
    onChange();
    $("experienceStatus").textContent = t(result.saved ? "favoriteSaved" : "favoriteRemoved");
    $("artistActionStatus").textContent = t(result.saved ? "favoriteSaved" : "favoriteRemoved");
  }
  function init(callbacks) {
    onChange = callbacks.onChange;
    onFavorites = callbacks.onFavorites;
    $("accountButton").addEventListener("click", open);
    $("accountSignIn").addEventListener("click", () => signIn("login"));
    $("accountRegister").addEventListener("click", () => signIn("register"));
    document.querySelectorAll("[data-require-member]").forEach((button) => button.addEventListener("click", () => signIn("login")));
    $("accountFavorites").addEventListener("click", () => { $("accountDialog").close(); onFavorites(); });
    $("logoutButton").addEventListener("click", () => $("accountDialog").close());
    render();
  }
  return { init, render, member, ids, saved, toggle, open };
})();
