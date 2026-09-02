(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.SiteUpdates = api;
    api.init();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  function text(value, maximum = 500) {
    return String(value ?? "").trim().slice(0, maximum);
  }

  function normalize(items, limit = 3) {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => ({
        id: text(item?.id, 100),
        title: text(item?.title, 160),
        body: text(item?.body, 500),
        publishedOn: text(item?.publishedOn || item?.published_on, 10)
      }))
      .filter((item) => item.title && /^\d{4}-\d{2}-\d{2}$/.test(item.publishedOn))
      .slice(0, Math.max(1, Math.min(10, Number.parseInt(limit, 10) || 3)));
  }

  function displayDate(value) {
    return text(value, 10).replaceAll("-", ".");
  }

  function render(list, items) {
    const documentRef = list.ownerDocument;
    list.replaceChildren();
    if (!items.length) {
      const empty = documentRef.createElement("li");
      empty.className = "site-log-empty";
      empty.textContent = "公開中の更新記録はありません。";
      list.append(empty);
      return;
    }

    items.forEach((item) => {
      const entry = documentRef.createElement("li");
      entry.className = "site-log-entry";
      const time = documentRef.createElement("time");
      time.dateTime = item.publishedOn;
      time.textContent = displayDate(item.publishedOn);
      const content = documentRef.createElement("div");
      const title = documentRef.createElement("strong");
      title.textContent = item.title;
      content.append(title);
      if (item.body) {
        const body = documentRef.createElement("p");
        body.textContent = item.body;
        content.append(body);
      }
      entry.append(time, content);
      list.append(entry);
    });
  }

  async function load(list, fetchImpl = root.fetch) {
    list.setAttribute("aria-busy", "true");
    try {
      const response = await fetchImpl("/api/updates?limit=3", {
        headers: { Accept: "application/json" },
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
      });
      if (!response.ok) throw new Error("request failed");
      const payload = await response.json();
      if (payload.fallback || !Array.isArray(payload.updates)) return false;
      render(list, normalize(payload.updates, 3));
      list.dataset.source = "api";
      return true;
    } catch {
      // The server-rendered records remain visible if the optional table has
      // not been installed yet or the data service is temporarily unavailable.
      return false;
    } finally {
      list.setAttribute("aria-busy", "false");
    }
  }

  function init() {
    if (typeof document === "undefined") return;
    const list = document.querySelector("#siteUpdateList");
    if (list) load(list);
  }

  return { displayDate, init, load, normalize, render };
});
