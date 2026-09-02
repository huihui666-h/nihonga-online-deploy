(function () {
  const form = document.querySelector("#artistSubmissionForm");
  const status = document.querySelector("#artistSubmissionStatus");
  const correctionForm = document.querySelector("#artistCorrectionForm");
  const correctionStatus = document.querySelector("#artistCorrectionStatus");
  if (!form || !status) return;
  const params = new URLSearchParams(window.location.search);
  const preset = params.get("artist");
  const correctionMode = params.get("mode") === "correction" && preset && correctionForm && correctionStatus;
  if (correctionMode) {
    form.hidden = true;
    correctionForm.hidden = false;
    correctionStatus.textContent = "作家情報を確認しています…";
    fetch("/api/artists", { headers: { Accept: "application/json" } })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("作家情報を読み込めませんでした。")))
      .then((payload) => {
        const artist = Array.isArray(payload.artists) ? payload.artists.find((item) => String(item.slug || "") === preset) : null;
        if (!artist) throw new Error("作家ページが見つかりません。");
        correctionForm.querySelector('[name="artistId"]').value = artist.id || "";
        correctionForm.querySelector('[name="artistName"]').value = artist.name || "";
        document.querySelector("#correctionTarget").textContent = `${artist.name || "作家"} の情報を修正`;
        correctionStatus.textContent = "修正内容を入力してください。送信後、確認してから反映します。";
      })
      .catch((error) => { correctionStatus.textContent = error.message; correctionStatus.classList.add("is-error"); });
    correctionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(correctionForm).entries());
      const button = correctionForm.querySelector("button[type=submit]");
      button.disabled = true; correctionStatus.textContent = "送信中…"; correctionStatus.classList.remove("is-error");
      try {
        const response = await fetch("/api/report-correction", { method: "POST", credentials: "include", headers: { "content-type": "application/json", Accept: "application/json" }, body: JSON.stringify(data) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new Error(payload.message || "送信できませんでした。");
        correctionForm.reset(); correctionStatus.textContent = "修正報告を受け付けました。確認後に反映します。";
      } catch (error) { correctionStatus.textContent = error.message || "送信できませんでした。"; correctionStatus.classList.add("is-error"); }
      finally { button.disabled = false; }
    });
    return;
  }
  if (preset) status.textContent = "掲載を希望する作家情報を入力してください。";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "送信中…";
    status.classList.remove("is-error");
    try {
      const response = await fetch("/api/submissions?resource=artist", { method: "POST", credentials: "include", headers: { "content-type": "application/json", Accept: "application/json" }, body: JSON.stringify(data) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.message || "送信できませんでした。");
      form.reset();
      status.textContent = "申請を受け付けました。確認後に掲載します。";
    } catch (error) {
      status.textContent = error.message || "送信できませんでした。";
      status.classList.add("is-error");
    } finally { button.disabled = false; }
  });
})();
