(function () {
  const button = document.querySelector("#artistShare");
  if (!button) return;
  const status = document.createElement("p");
  status.className = "artist-share-status";
  status.setAttribute("role", "status");
  button.parentElement.append(status);
  const url = window.location.href;
  const title = document.querySelector("h1")?.textContent?.trim() || "NIHONGA INDEX";
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "";
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: `${title}｜日本画家｜NIHONGA INDEX`, text: `${title} - NIHONGA INDEX`, url });
        status.textContent = "共有しました。";
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        status.textContent = "リンクをコピーしました。";
      } else {
        status.textContent = url;
      }
    } catch (error) {
      if (error?.name !== "AbortError") status.textContent = url;
    } finally {
      button.disabled = false;
    }
  });
})();
