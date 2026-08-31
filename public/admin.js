const ADMIN_KEY = "nihongaAdminPassword";

let adminPassword = localStorage.getItem(ADMIN_KEY) || "";
let artists = [];
let submissions = [];
let rankings = [];
const expandedSubmissionIds = new Set();

const els = {
  adminLogin: document.querySelector("#adminLogin"),
  adminPanel: document.querySelector("#adminPanel"),
  adminPasswordInput: document.querySelector("#adminPasswordInput"),
  adminLoginButton: document.querySelector("#adminLoginButton"),
  adminMessage: document.querySelector("#adminMessage"),
  tabs: document.querySelectorAll(".tabs button"),
  tabPanels: document.querySelectorAll(".tab-panel"),
  profileInput: document.querySelector("#profileInput"),
  detectButton: document.querySelector("#detectButton"),
  newArtistButton: document.querySelector("#newArtistButton"),
  artistSearchInput: document.querySelector("#artistSearchInput"),
  artistList: document.querySelector("#artistList"),
  artistForm: document.querySelector("#artistForm"),
  artistIdInput: document.querySelector("#artistIdInput"),
  deleteArtistButton: document.querySelector("#deleteArtistButton"),
  submissionList: document.querySelector("#submissionList"),
  rankingForm: document.querySelector("#rankingForm"),
  rankingAdminList: document.querySelector("#rankingAdminList"),
  correctionList: document.querySelector("#correctionList")
};

function setMessage(message, isError = false) {
  els.adminMessage.textContent = message;
  els.adminMessage.classList.toggle("is-error", isError);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-admin-password": adminPassword,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || "请求失败。");
  }
  return data;
}

function splitTags(value) {
  return String(value || "")
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function fillArtistForm(artist = {}) {
  els.artistIdInput.value = artist.id || "";
  els.artistForm.elements.name.value = artist.name || "";
  els.artistForm.elements.romanName.value = artist.roman_name || artist.romanName || "";
  els.artistForm.elements.handle.value = artist.handle || "";
  els.artistForm.elements.instagram.value = artist.instagram || "";
  els.artistForm.elements.school.value = artist.school || "";
  els.artistForm.elements.region.value = artist.region || "";
  els.artistForm.elements.styles.value = Array.isArray(artist.styles) ? artist.styles.join("，") : "";
  els.artistForm.elements.sourcePage.value = artist.source_page || artist.sourcePage || artist.instagram || "";
  els.artistForm.elements.note.value = artist.note || "";
}

function readArtistForm() {
  return {
    name: els.artistForm.elements.name.value.trim(),
    romanName: els.artistForm.elements.romanName.value.trim(),
    handle: normalizeHandle(els.artistForm.elements.handle.value),
    instagram: els.artistForm.elements.instagram.value.trim(),
    school: els.artistForm.elements.school.value.trim(),
    region: els.artistForm.elements.region.value.trim(),
    styles: splitTags(els.artistForm.elements.styles.value),
    sourcePage: els.artistForm.elements.sourcePage.value.trim(),
    note: els.artistForm.elements.note.value.trim(),
    linkType: "instagram"
  };
}

function normalizeHandle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  const handle = match ? match[1] : text.replace(/^@/, "");
  return `@${handle.replace(/\/+$/, "")}`;
}

function detectSchool(text) {
  const rules = [
    ["東京藝術大学", "東京", ["東京藝術大学", "東京藝大", "Tokyo University of the Arts", "Geidai", "TUA"]],
    ["多摩美術大学", "東京", ["多摩美術大学", "多摩美", "Tama Art University"]],
    ["武蔵野美術大学", "東京", ["武蔵野美術大学", "武蔵美", "Musashino Art University", "MAU"]],
    ["女子美術大学", "東京", ["女子美術大学", "女子美", "Joshibi"]],
    ["日本大学芸術学部", "東京", ["日本大学芸術学部", "日芸", "Nihon University College of Art"]],
    ["文星芸術大学", "栃木", ["文星芸術大学", "Bunsei University of Art"]],
    ["京都芸術大学", "京都", ["京都芸術大学", "京都造形芸術大学", "Kyoto University of the Arts"]],
    ["京都精華大学", "京都", ["京都精華大学", "Kyoto Seika University"]],
    ["東北芸術工科大学", "山形", ["東北芸術工科大学", "TUAD"]],
    ["愛知県立芸術大学", "愛知", ["愛知県立芸術大学", "Aichi University of the Arts"]],
    ["金沢美術工芸大学", "石川", ["金沢美術工芸大学", "Kanazawa College of Art"]]
  ];

  for (const [school, region, keys] of rules) {
    if (keys.some((key) => text.toLowerCase().includes(key.toLowerCase()))) {
      return { school, region };
    }
  }
  return { school: "", region: "" };
}

function detectFromProfile(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join(" ");
  const handleMatch = joined.match(/(?:instagram\.com\/)?@?([A-Za-z0-9_.]{3,30})/);
  const firstNameLine = lines.find((line) => !/^\d|帖子|粉丝|关注|follow|following|followers/i.test(line)) || "";
  const { school, region } = detectSchool(joined);
  const styles = new Set(["日本画"]);

  if (/中国|華人|华人|Chinese|China|中央美术|中央美術|国画|中國畫|中国画|中文/.test(joined)) {
    styles.add("中国/華人");
  }
  if (/版画|printmaking|print/.test(joined)) {
    styles.add("版画");
  }
  if (school) styles.add(school);

  const handle = handleMatch ? normalizeHandle(handleMatch[1]) : "";
  const instagram = handle ? `https://www.instagram.com/${handle.replace("@", "")}/` : "";

  return {
    name: firstNameLine || handle || "未命名画家",
    romanName: "",
    handle,
    instagram,
    school,
    region,
    styles: Array.from(styles),
    sourcePage: instagram,
    note: `Instagram 简介：${joined.slice(0, 180)}${joined.length > 180 ? "..." : ""}`,
    linkType: "instagram"
  };
}

async function loadAll() {
  const [artistData, submissionData, rankingData] = await Promise.all([
    api("/api/admin-artists"),
    api("/api/admin-submissions"),
    api("/api/admin-rankings")
  ]);
  artists = artistData.artists || [];
  submissions = submissionData.submissions || [];
  rankings = rankingData.rankings || [];
  renderArtists();
  renderSubmissions();
  renderRankingTools();
  renderCorrections();
}

function renderArtists() {
  const query = els.artistSearchInput.value.trim().toLowerCase();
  const list = artists.filter((artist) => {
    const haystack = [
      artist.name,
      artist.roman_name,
      artist.handle,
      artist.school,
      artist.region,
      artist.note,
      ...(Array.isArray(artist.styles) ? artist.styles : [])
    ].join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });

  els.artistList.innerHTML = "";
  list.forEach((artist) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<strong>${escapeHtml(artist.name)}</strong><span>${escapeHtml(artist.handle || "")} ${escapeHtml(artist.school || "")}</span>`;
    button.addEventListener("click", () => fillArtistForm(artist));
    els.artistList.append(button);
  });
}

function renderSubmissions() {
  els.submissionList.innerHTML = "";

  if (!submissions.length) {
    const empty = document.createElement("p");
    empty.className = "helper-message";
    empty.textContent = "暂无投稿";
    els.submissionList.append(empty);
    return;
  }

  submissions.forEach((item) => {
    const isExpanded = expandedSubmissionIds.has(item.id);
    const createdAt = item.created_at ? new Date(item.created_at).toLocaleString("zh-CN", { hour12: false }) : "";
    const statusText = {
      pending: "待审核",
      approved: "已通过",
      rejected: "已拒绝"
    }[item.status] || item.status || "待审核";
    const row = document.createElement("article");
    row.className = `submission-row is-${item.status} ${isExpanded ? "is-expanded" : ""}`;
    row.innerHTML = `
      <div class="submission-summary">
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(statusText)} · ${escapeHtml(item.school || "学校待补")} · ${escapeHtml(createdAt)}</span>
        </div>
        <button data-action="toggle" class="secondary submission-toggle" type="button">${isExpanded ? "收起" : "展开"}</button>
      </div>
      <div class="submission-detail" ${isExpanded ? "" : "hidden"}>
        <p><b>IG：</b><a href="${escapeHtml(item.instagram || "#")}" target="_blank" rel="noreferrer">${escapeHtml(item.instagram || "未填写")}</a></p>
        <p><b>账号：</b>${escapeHtml(item.handle || "自动识别待补")}</p>
        <p><b>备注：</b>${escapeHtml(item.note || "无备注")}</p>
        <div class="button-row">
          <button data-action="approve" type="button">通过并加入目录</button>
          <button data-action="reject" class="secondary" type="button">拒绝</button>
          <button data-action="delete" class="danger" type="button">删除投稿</button>
        </div>
      </div>
    `;
    row.querySelector('[data-action="toggle"]').addEventListener("click", () => {
      if (expandedSubmissionIds.has(item.id)) {
        expandedSubmissionIds.delete(item.id);
      } else {
        expandedSubmissionIds.add(item.id);
      }
      renderSubmissions();
    });
    const approveButton = row.querySelector('[data-action="approve"]');
    approveButton.disabled = item.status === "approved";
    approveButton.addEventListener("click", () => reviewSubmission(item.id, "approve"));
    row.querySelector('[data-action="reject"]').addEventListener("click", () => reviewSubmission(item.id, "reject"));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteSubmission(item.id));
    els.submissionList.append(row);
  });
}

function renderRankingTools() {
  const select = els.rankingForm.elements.artistId;
  const selected = select.value;
  select.innerHTML = "";

  artists.forEach((artist) => {
    const option = document.createElement("option");
    option.value = artist.id;
    option.textContent = `${artist.name}${artist.handle ? ` · ${artist.handle}` : ""}${artist.school ? ` · ${artist.school}` : ""}`;
    select.append(option);
  });

  if (selected && artists.some((artist) => artist.id === selected)) {
    select.value = selected;
  }

  els.rankingAdminList.innerHTML = "";
  if (!rankings.length) {
    const empty = document.createElement("p");
    empty.className = "helper-message";
    empty.textContent = "今天还没有点击记录。";
    els.rankingAdminList.append(empty);
    return;
  }

  rankings.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.innerHTML = `<strong>${index + 1}. ${escapeHtml(item.name)} · ${escapeHtml(String(item.count))} 次</strong><span>${escapeHtml(item.handle || "")} ${escapeHtml(item.school || "")}</span>`;
    row.addEventListener("click", () => {
      els.rankingForm.elements.artistId.value = item.id;
      els.rankingForm.elements.count.value = item.count;
    });
    els.rankingAdminList.append(row);
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function reviewSubmission(id, action) {
  await api(`/api/admin-submissions?id=${encodeURIComponent(id)}&action=${action}`, {
    method: "PATCH",
    body: JSON.stringify({})
  });
  setMessage(action === "approve" ? "投稿已通过并加入目录。" : "投稿已拒绝。");
  await loadAll();
}

async function deleteSubmission(id) {
  if (!confirm("确定删除这条投稿记录？")) return;
  await api(`/api/admin-submissions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  setMessage("投稿记录已删除。");
  await loadAll();
}

els.adminLoginButton.addEventListener("click", async () => {
  adminPassword = els.adminPasswordInput.value.trim();
  if (!adminPassword) {
    setMessage("请输入管理员密码。", true);
    return;
  }
  try {
    localStorage.setItem(ADMIN_KEY, adminPassword);
    await loadAll();
    els.adminLogin.hidden = true;
    els.adminPanel.hidden = false;
    setMessage("后台已连接。");
  } catch (error) {
    localStorage.removeItem(ADMIN_KEY);
    setMessage(error.message, true);
  }
});

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    els.tabPanels.forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.tab;
    });
  });
});

els.detectButton.addEventListener("click", () => {
  const text = els.profileInput.value.trim();
  if (!text) {
    setMessage("先粘贴 Instagram 简介。", true);
    return;
  }
  fillArtistForm(detectFromProfile(text));
  setMessage("已识别到表单里，你可以手动改细节后保存。");
});

els.newArtistButton.addEventListener("click", () => fillArtistForm({ styles: ["日本画"], linkType: "instagram" }));
els.artistSearchInput.addEventListener("input", renderArtists);

els.artistForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = els.artistIdInput.value;
  const payload = readArtistForm();
  if (!payload.instagram && payload.handle) {
    payload.instagram = `https://www.instagram.com/${payload.handle.replace("@", "")}/`;
  }
  const path = id ? `/api/admin-artists?id=${encodeURIComponent(id)}` : "/api/admin-artists";
  const method = id ? "PATCH" : "POST";
  await api(path, { method, body: JSON.stringify(payload) });
  setMessage("画家资料已保存，网站会自动同步。");
  await loadAll();
});

els.deleteArtistButton.addEventListener("click", async () => {
  const id = els.artistIdInput.value;
  if (!id) {
    setMessage("先从左边选择一个画家。", true);
    return;
  }
  if (!confirm("确定删除这个画家？")) return;
  await api(`/api/admin-artists?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  fillArtistForm({ styles: ["日本画"], linkType: "instagram" });
  setMessage("画家已删除。");
  await loadAll();
});

els.rankingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    artistId: els.rankingForm.elements.artistId.value,
    count: Number.parseInt(els.rankingForm.elements.count.value, 10)
  };
  const data = await api("/api/admin-rankings", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  rankings = data.rankings || [];
  setMessage("今日点击量已更新，前台排名会同步变化。");
  renderRankingTools();
  renderCorrections();
});

function renderCorrections() {
  if (!els.correctionList) return;
  els.correctionList.innerHTML = "";
  const corrections = submissions.filter((s) => s.status === "correction");
  if (!corrections.length) {
    els.correctionList.innerHTML = `<div class="empty">暂无修改报告</div>`;
    return;
  }
  corrections.forEach((card) => {
    const artistId = card.instagram || "";
    const artist = artists.find((a) => a.id === artistId);
    const row = document.createElement("div");
    row.className = "submission-row";
    row.innerHTML = `
      <div class="submission-summary">
        <div>
          <strong>${escapeHtml(card.name || "未命名")}</strong>
          ${artist ? `<span>当前学校: ${escapeHtml(artist.school || "未确认")} | 地区: ${escapeHtml(artist.region || "未确认")}</span>` : ""}
          <span style="color:var(--red);font-weight:700">✏ ${escapeHtml(card.note || "")}</span>
          <span>${new Date(card.created_at).toLocaleString("zh-CN")}</span>
        </div>
        <div class="button-row">
          <button class="edit-artist-btn" type="button">编辑此画家</button>
          <button class="secondary" type="button">已完成</button>
          <button class="danger" type="button">删除</button>
        </div>
      </div>
    `;
    row.querySelector(".edit-artist-btn").addEventListener("click", () => {
      els.tabs.forEach((t) => t.classList.remove("is-active"));
      const artistsTab = document.querySelector(`[data-tab="artistsTab"]`);
      if (artistsTab) artistsTab.classList.add("is-active");
      els.tabPanels.forEach((p) => p.hidden = true);
      const panel = document.querySelector("#artistsTab");
      if (panel) panel.hidden = false;
      const found = artists.find((a) => a.id === artistId);
      if (found) fillArtistForm(found);
    });
    row.querySelector(".secondary").addEventListener("click", async () => {
      if (!confirm("确认已完成修改？这将删除此报告。")) return;
      await api(`/api/admin-submissions?id=${encodeURIComponent(card.id)}`, { method: "DELETE" });
      setMessage("已标记完成。");
      await loadAll();
    });
    row.querySelector(".danger").addEventListener("click", async () => {
      if (!confirm("删除此修改报告？")) return;
      await api(`/api/admin-submissions?id=${encodeURIComponent(card.id)}`, { method: "DELETE" });
      setMessage("已删除。");
      await loadAll();
    });
    els.correctionList.append(row);
  });
}


if (adminPassword) {
  els.adminPasswordInput.value = adminPassword;
}
