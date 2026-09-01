/* Shared release announcement: one acknowledgement per browser and release. */
(function (root) {
  const VERSION = "2026-09-01-nihonga-now";
  const STORAGE_KEY = "nihonga:announcement:seen";
  const LANGUAGE_CODES = { zh: "zh-CN", en: "en", ja: "ja" };
  const dialog = document.querySelector("#announcementDialog");
  if (!dialog) return;
  const triggers = [...document.querySelectorAll("[data-open-announcement]")];
  const acknowledgeButton = dialog.querySelector("[data-announcement-acknowledge]");
  let lastFocused = null;

  function storage() {
    try { return root.localStorage; } catch { return null; }
  }

  function hasSeen() {
    try { return storage()?.getItem(STORAGE_KEY) === VERSION; } catch { return false; }
  }

  function markSeen() {
    try { storage()?.setItem(STORAGE_KEY, VERSION); } catch { /* A blocked store only affects repeat display. */ }
  }

  function getI18n() {
    return typeof I18N !== "undefined" ? I18N : null;
  }

  function applyLanguage() {
    const i18n = getI18n();
    if (!i18n) return;
    document.documentElement.lang = LANGUAGE_CODES[i18n.current] || "ja";
    i18n.applyToDOM(dialog);
  }

  function openAnnouncement() {
    if (dialog.open) return;
    lastFocused = document.activeElement;
    applyLanguage();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => acknowledgeButton?.focus());
  }

  function acknowledgeAnnouncement() {
    markSeen();
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  triggers.forEach((trigger) => trigger.addEventListener("click", openAnnouncement));
  acknowledgeButton?.addEventListener("click", acknowledgeAnnouncement);
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.addEventListener("close", () => {
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus({ preventScroll: true });
    lastFocused = null;
  });
  applyLanguage();

  function maybeOpen() {
    if (!hasSeen()) openAnnouncement();
  }
  if (document.body.classList.contains("index-page")) {
    document.addEventListener("nihonga:directory-ready", maybeOpen, { once: true });
  } else if (document.readyState === "loading") {
    root.addEventListener("DOMContentLoaded", maybeOpen, { once: true });
  } else {
    root.setTimeout(maybeOpen, 0);
  }

  root.NihongaAnnouncement = Object.freeze({ VERSION, STORAGE_KEY, open: openAnnouncement, acknowledge: acknowledgeAnnouncement, hasSeen, markSeen });
})(window);
