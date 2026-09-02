// Keep the administrator credential in page memory only. Persisting it in
// localStorage would expose it to any script running in this origin.
let adminPassword = "";
let artists = [];
let submissions = [];
let rankings = [];
let news = [];
let users = [];
let usersLoaded = false;
let usersLoading = false;
let usersAtLimit = false;
let passwordResetUser = null;
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
  correctionList: document.querySelector("#correctionList"),
  newsAdminList: document.querySelector("#newsAdminList"),
  newsForm: document.querySelector("#newsForm"),
  newsIdInput: document.querySelector("#newsIdInput"),
  newNewsButton: document.querySelector("#newNewsButton"),
  deleteNewsButton: document.querySelector("#deleteNewsButton"),
  newsMessage: document.querySelector("#newsMessage"),
  userList: document.querySelector("#userList"),
  userListStatus: document.querySelector("#userListStatus"),
  userSearchInput: document.querySelector("#userSearchInput"),
  userStatusFilter: document.querySelector("#userStatusFilter"),
  refreshUsersButton: document.querySelector("#refreshUsersButton"),
  userTotalCount: document.querySelector("#userTotalCount"),
  userActiveCount: document.querySelector("#userActiveCount"),
  userDisabledCount: document.querySelector("#userDisabledCount"),
  passwordResetDialog: document.querySelector("#passwordResetDialog"),
  passwordResetForm: document.querySelector("#passwordResetForm"),
  passwordResetUser: document.querySelector("#passwordResetUser"),
  newUserPasswordInput: document.querySelector("#newUserPasswordInput"),
  showUserPasswordInput: document.querySelector("#showUserPasswordInput"),
  generateUserPasswordButton: document.querySelector("#generateUserPasswordButton"),
  submitPasswordResetButton: document.querySelector("#submitPasswordResetButton"),
  passwordResetMessage: document.querySelector("#passwordResetMessage"),
  closePasswordResetButton: document.querySelector("#closePasswordResetButton"),
  cancelPasswordResetButton: document.querySelector("#cancelPasswordResetButton")
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
  const [artistData, submissionData, rankingData, newsData] = await Promise.all([
    api("/api/admin-artists"),
    api("/api/admin-submissions"),
    api("/api/admin-rankings"),
    api("/api/admin-news")
  ]);
  artists = artistData.artists || [];
  submissions = submissionData.submissions || [];
  rankings = rankingData.rankings || [];
  news = newsData.news || [];
  renderArtists();
  renderSubmissions();
  renderRankingTools();
  renderCorrections();
  renderNewsAdmin();
}

async function loadUsers() {
  if (usersLoading) return;
  usersLoading = true;
  els.refreshUsersButton.disabled = true;
  els.userListStatus.textContent = "正在读取注册用户...";

  try {
    const data = await api("/api/admin-artists?resource=users");
    users = data.users || [];
    usersAtLimit = Boolean(data.atLimit);
    usersLoaded = true;
    renderUsers();
  } catch (error) {
    els.userListStatus.textContent = error.message || "读取注册用户失败。";
    setMessage(els.userListStatus.textContent, true);
    throw error;
  } finally {
    usersLoading = false;
    els.refreshUsersButton.disabled = false;
  }
}

function renderUsers() {
  const query = els.userSearchInput.value.trim().toLowerCase();
  const status = els.userStatusFilter.value;
  const activeCount = users.filter((user) => user.status === "active").length;
  const disabledCount = users.length - activeCount;
  const visibleUsers = users.filter((user) => {
    const matchesQuery = !query || `${user.displayName || ""} ${user.email || ""}`.toLowerCase().includes(query);
    const normalizedStatus = user.status === "active" ? "active" : "disabled";
    return matchesQuery && (status === "all" || status === normalizedStatus);
  });

  els.userTotalCount.textContent = String(users.length);
  els.userActiveCount.textContent = String(activeCount);
  els.userDisabledCount.textContent = String(disabledCount);
  els.userListStatus.textContent = `显示 ${visibleUsers.length} / ${users.length} 位用户${usersAtLimit ? "（已达到最近 1000 位显示上限）" : ""}`;
  els.userList.innerHTML = "";

  if (!visibleUsers.length) {
    const empty = document.createElement("p");
    empty.className = "user-empty";
    empty.textContent = users.length ? "没有符合筛选条件的用户。" : "暂无注册用户。";
    els.userList.append(empty);
    return;
  }

  visibleUsers.forEach((user) => {
    const isActive = user.status === "active";
    const nextStatus = isActive ? "disabled" : "active";
    const row = document.createElement("article");
    row.className = "user-row";
    row.setAttribute("role", "row");
    row.innerHTML = `
      <div class="user-identity" role="cell">
        <strong>${escapeHtml(user.displayName || "未设置昵称")}</strong>
        <span>${escapeHtml(user.email || "未填写邮箱")}</span>
      </div>
      <div role="cell"><span class="user-status ${isActive ? "is-active" : "is-disabled"}">${isActive ? "正常" : "已停用"}</span></div>
      <div class="user-date" role="cell"><span>注册时间</span><time>${escapeHtml(formatAdminDate(user.createdAt, "未知"))}</time></div>
      <div class="user-date" role="cell"><span>最后登录</span><time>${escapeHtml(formatAdminDate(user.lastLoginAt, "暂无记录"))}</time></div>
      <div class="user-action" role="cell"><button data-user-action="status" class="${isActive ? "danger" : "secondary"}" type="button">${isActive ? "停用账户" : "重新启用"}</button><button data-user-action="password" class="secondary" type="button">重设密码</button></div>
    `;

    const actionButton = row.querySelector('[data-user-action="status"]');
    actionButton.setAttribute("aria-label", `${isActive ? "停用" : "启用"} ${user.email || "此用户"}`);
    actionButton.addEventListener("click", () => {
      changeUserStatus(user, nextStatus, actionButton).catch((error) => setMessage(error.message, true));
    });
    row.querySelector('[data-user-action="password"]').addEventListener("click", () => openPasswordReset(user));
    els.userList.append(row);
  });
}

function openPasswordReset(user) {
  passwordResetUser = user;
  els.passwordResetUser.textContent = `用户：${user.email || user.displayName || user.id}`;
  els.newUserPasswordInput.value = "";
  els.newUserPasswordInput.type = "password";
  els.showUserPasswordInput.checked = false;
  els.passwordResetMessage.textContent = "";
  els.passwordResetMessage.classList.remove("is-error");
  els.passwordResetDialog.showModal();
  els.newUserPasswordInput.focus();
}

function closePasswordReset() {
  els.passwordResetDialog.close();
  passwordResetUser = null;
  els.newUserPasswordInput.value = "";
}

function generateUserPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const values = new Uint32Array(16);
  crypto.getRandomValues(values);
  els.newUserPasswordInput.value = Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
  els.newUserPasswordInput.type = "text";
  els.showUserPasswordInput.checked = true;
  els.newUserPasswordInput.focus();
  els.newUserPasswordInput.select();
}

async function resetUserPassword() {
  if (!passwordResetUser) return;
  const newPassword = els.newUserPasswordInput.value;
  if (newPassword.length < 8 || newPassword.length > 128) {
    els.passwordResetMessage.textContent = "新密码长度需要为 8 至 128 个字符。";
    els.passwordResetMessage.classList.add("is-error");
    return;
  }
  els.submitPasswordResetButton.disabled = true;
  els.passwordResetMessage.classList.remove("is-error");
  els.passwordResetMessage.textContent = "正在重设密码...";
  try {
    await api(`/api/admin-artists?resource=users&id=${encodeURIComponent(passwordResetUser.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ newPassword })
    });
    els.passwordResetMessage.textContent = "密码已重设，旧会话已清除。请将新密码安全地告知用户。";
    setMessage(`已重设 ${passwordResetUser.email || "该用户"} 的密码，旧会话已清除。`);
  } catch (error) {
    els.passwordResetMessage.textContent = error.message;
    els.passwordResetMessage.classList.add("is-error");
  } finally {
    els.submitPasswordResetButton.disabled = false;
  }
}

function formatAdminDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

async function changeUserStatus(user, nextStatus, button) {
  if (nextStatus === "disabled" && !confirm(`确定停用 ${user.email || "此用户"}？该用户会立即退出登录。`)) return;

  button.disabled = true;
  try {
    const data = await api(`/api/admin-artists?resource=users&id=${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus })
    });
    users = users.map((item) => item.id === user.id ? data.user : item);
    setMessage(nextStatus === "active" ? "用户已重新启用，旧会话已清除。" : "用户已停用并退出登录。");
    renderUsers();
  } catch (error) {
    await loadUsers().catch(() => {});
    throw error;
  } finally {
    button.disabled = false;
  }
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
        <p><b>出典：</b><a href="${escapeHtml(safeHttpUrl(item.source_page || item.instagram) || "#")}" target="_blank" rel="noreferrer">${escapeHtml(item.source_page || item.instagram || "未填写")}</a></p>
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

const NEWS_CATEGORY_LABELS = {
  exhibition: "展覧会", open_call: "公募", artist_news: "作家動向", museum: "美術館",
  nihonga_news: "日本画新闻", new_artist: "新規作家", award: "受賞", selection: "入選", solo: "個展",
  graduation: "卒展", university: "大学", gallery: "画廊"
};

function fillNewsForm(item = {}) {
  if (!els.newsForm) return;
  els.newsIdInput.value = item.id || "";
  els.newsForm.elements.title.value = item.title || "";
  els.newsForm.elements.category.value = item.category || "nihonga_news";
  els.newsForm.elements.status.value = item.status || "candidate";
  els.newsForm.elements.publishedAt.value = String(item.published_at || item.publishedAt || "").slice(0, 10);
  els.newsForm.elements.startDate.value = String(item.start_date || item.startDate || "").slice(0, 10);
  els.newsForm.elements.endDate.value = String(item.end_date || item.endDate || "").slice(0, 10);
  els.newsForm.elements.sourceName.value = item.source_name || item.sourceName || "";
  els.newsForm.elements.sourceUrl.value = item.source_url || item.sourceUrl || "";
  els.newsForm.elements.venue.value = item.venue || "";
  els.newsForm.elements.tags.value = Array.isArray(item.tags) ? item.tags.join("，") : (item.tags || "");
  els.newsForm.elements.summary.value = item.summary || "";
  els.newsForm.hidden = false;
  els.newsMessage.textContent = "";
}

function readNewsForm() {
  const form = els.newsForm;
  return {
    title: form.elements.title.value.trim(),
    category: form.elements.category.value,
    status: form.elements.status.value,
    publishedAt: form.elements.publishedAt.value,
    startDate: form.elements.startDate.value,
    endDate: form.elements.endDate.value,
    sourceName: form.elements.sourceName.value.trim(),
    sourceUrl: form.elements.sourceUrl.value.trim(),
    venue: form.elements.venue.value.trim(),
    tags: form.elements.tags.value.split(/[,，、\n]/).map((value) => value.trim()).filter(Boolean),
    summary: form.elements.summary.value.trim()
  };
}

function renderNewsAdmin() {
  if (!els.newsAdminList) return;
  els.newsAdminList.replaceChildren();
  if (!news.length) {
    const empty = document.createElement("p");
    empty.className = "helper-message";
    empty.textContent = "暂无新闻记录。";
    els.newsAdminList.append(empty);
    return;
  }
  news.forEach((item) => {
    const row = document.createElement("article");
    row.className = `submission-row news-admin-row is-${escapeHtml(item.status || "candidate")}`;
    const date = item.published_at || item.publishedAt || item.start_date || item.startDate || item.created_at || "";
    row.innerHTML = `<div class="submission-summary"><div><strong>${escapeHtml(item.title || "无标题")}</strong><span>${escapeHtml(NEWS_CATEGORY_LABELS[item.category] || item.category || "日本画新闻")} · ${escapeHtml(item.status || "candidate")} · ${escapeHtml(String(date).slice(0, 10))}</span><span>${escapeHtml(item.source_name || item.sourceName || "出典未确认")}</span></div><div class="button-row"><button data-news-action="edit" type="button">编辑</button><button data-news-action="delete" class="danger" type="button">删除</button></div></div>`;
    row.querySelector('[data-news-action="edit"]').addEventListener("click", () => fillNewsForm(item));
    row.querySelector('[data-news-action="delete"]').addEventListener("click", () => deleteNews(item.id));
    els.newsAdminList.append(row);
  });
}

async function saveNews(event) {
  event.preventDefault();
  const id = els.newsIdInput.value.trim();
  const payload = readNewsForm();
  els.newsMessage.textContent = "保存中…";
  els.newsMessage.classList.remove("is-error");
  try {
    const data = await api(id ? `/api/admin-news?id=${encodeURIComponent(id)}` : "/api/admin-news", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
    const saved = data.news;
    news = id ? news.map((item) => item.id === id ? saved : item) : [saved, ...news];
    renderNewsAdmin();
    els.newsMessage.textContent = "新闻已保存。";
    if (!id) fillNewsForm(saved);
    setMessage("NIHONGA NOW 新闻已更新，前台刷新后生效。");
  } catch (error) {
    els.newsMessage.textContent = error.message || "保存失败。";
    els.newsMessage.classList.add("is-error");
  }
}

async function deleteNews(id) {
  if (!id || !confirm("确定删除这条新闻？此操作不可恢复。")) return;
  try {
    await api(`/api/admin-news?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    news = news.filter((item) => item.id !== id);
    if (els.newsIdInput.value === id) { els.newsForm.reset(); els.newsIdInput.value = ""; els.newsForm.hidden = true; }
    renderNewsAdmin();
    setMessage("新闻已删除，sitemap 和前台会同步更新。");
  } catch (error) { setMessage(error.message || "删除失败。", true); }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return /^https?:$/i.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
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
    await loadAll();
    els.adminLogin.hidden = true;
    els.adminPanel.hidden = false;
    setMessage("后台已连接。");
  } catch (error) {
    adminPassword = "";
    setMessage(error.message, true);
  }
});

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    els.tabPanels.forEach((panel) => {
      panel.hidden = panel.id !== tab.dataset.tab;
    });
    if (tab.dataset.tab === "usersTab" && !usersLoaded) {
      loadUsers().catch(() => {});
    }
  });
});

els.newNewsButton?.addEventListener("click", () => fillNewsForm({ status: "candidate", category: "nihonga_news" }));
els.newsForm?.addEventListener("submit", saveNews);
els.deleteNewsButton?.addEventListener("click", () => deleteNews(els.newsIdInput.value.trim()));

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
els.userSearchInput.addEventListener("input", renderUsers);
els.userStatusFilter.addEventListener("change", renderUsers);
els.refreshUsersButton.addEventListener("click", () => {
  loadUsers().catch(() => {});
});
els.passwordResetForm.addEventListener("submit", (event) => { event.preventDefault(); resetUserPassword(); });
els.generateUserPasswordButton.addEventListener("click", generateUserPassword);
els.showUserPasswordInput.addEventListener("change", () => { els.newUserPasswordInput.type = els.showUserPasswordInput.checked ? "text" : "password"; });
els.closePasswordResetButton.addEventListener("click", closePasswordReset);
els.cancelPasswordResetButton.addEventListener("click", closePasswordReset);
els.passwordResetDialog.addEventListener("click", (event) => {
  if (event.target !== els.passwordResetDialog) return;
  const box = els.passwordResetDialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closePasswordReset();
});

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
