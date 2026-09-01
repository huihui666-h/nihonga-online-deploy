const {
  readBody,
  requireAdmin,
  sendJson,
  setCors
} = require("./_supabase");
const { requireSameOrigin } = require("./_auth");

const DEFAULT_BASE_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TITLE = 300;
const MAX_EXCERPT = 1400;
const MAX_SOURCE_URL = 500;

async function handleNewsAi(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }
  if (!requireAdmin(req, res) || !requireSameOrigin(req, res)) return;

  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    sendJson(res, 503, { ok: false, message: "服务器尚未配置 OPENAI_API_KEY。" });
    return;
  }

  try {
    const body = await readBody(req);
    const candidate = normalizeCandidate(body);
    if (!candidate.title || !candidate.sourceUrl || !candidate.excerpt) {
      sendJson(res, 400, { ok: false, message: "标题、来源链接和正文摘录不能为空。" });
      return;
    }

    const response = await requestModel(apiKey, candidate);
    const metadata = normalizeModelResponse(response);
    sendJson(res, 200, { ok: true, metadata });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    sendJson(res, status, {
      ok: false,
      message: error.message || "AI 处理失败。"
    });
  }
}

function normalizeCandidate(body) {
  const value = body && typeof body === "object" ? body : {};
  return {
    title: clean(value.title, MAX_TITLE),
    sourceUrl: clean(value.sourceUrl || value.source_url, MAX_SOURCE_URL),
    excerpt: clean(value.excerpt || value.rawExcerpt || value.raw_excerpt, MAX_EXCERPT),
    publishedAt: clean(value.publishedAt || value.published_at, 30),
    startDate: clean(value.startDate || value.start_date, 30),
    endDate: clean(value.endDate || value.end_date, 30),
    venue: clean(value.venue, 160)
  };
}

function clean(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function buildPrompt(candidate) {
  return [
    "You are a Nihonga news metadata editor. Process only the supplied candidate; do not search the web.",
    "Return one strict JSON object and no markdown. Determine whether it directly concerns Japanese painting (日本画).",
    "Write an original, concise Japanese factual summary; do not copy sentences. Dates must be YYYY-MM-DD or null.",
    "Allowed category values: exhibition, open_call, artist_news, museum, nihonga_news.",
    "Required keys: relevant, relevance_score, category, title, summary, artist_names, venue, start_date, end_date, tags.",
    JSON.stringify({
      title: candidate.title,
      source_url: candidate.sourceUrl,
      excerpt: candidate.excerpt,
      published_at: candidate.publishedAt,
      start_date: candidate.startDate,
      end_date: candidate.endDate,
      venue: candidate.venue
    })
  ].join("\n");
}

async function requestModel(apiKey, candidate) {
  const wireApi = String(process.env.OPENAI_WIRE_API || "chat").trim().toLowerCase();
  const baseUrl = endpointFor(String(process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).trim(), wireApi);
  const model = String(process.env.OPENAI_MODEL || DEFAULT_MODEL).trim();
  const body = wireApi === "responses"
    ? {
        model,
        instructions: "Output strict JSON only.",
        input: buildPrompt(candidate),
        temperature: 0.1,
        max_output_tokens: 700,
        text: { format: { type: "json_object" } }
      }
    : {
        model,
        temperature: 0.1,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Output strict JSON only." },
          { role: "user", content: buildPrompt(candidate) }
        ]
      };
  let response;
  try {
    response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "nihonga-news-admin/1.0"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    const error = new Error("AI 服务请求失败。");
    error.status = 502;
    throw error;
  }

  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error("AI 服务返回错误。");
    error.status = response.status === 401 || response.status === 403 ? 502 : 503;
    throw error;
  }
  return payload;
}

function endpointFor(baseUrl, wireApi) {
  if (wireApi !== "responses") return baseUrl;
  if (/\/v1\/responses\/?$/i.test(baseUrl)) return baseUrl;
  if (/\/v1\/?$/i.test(baseUrl)) return `${baseUrl.replace(/\/$/, "")}/responses`;
  return `${baseUrl.replace(/\/$/, "")}/v1/responses`;
}

function normalizeModelResponse(payload) {
  const content = extractContent(payload);
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI 返回内容格式不正确。");
  }
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("AI 返回的不是有效 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 返回内容格式不正确。");
  }
  return {
    relevant: value.relevant === true,
    relevance_score: Number.isFinite(Number(value.relevance_score))
      ? Math.max(0, Math.min(1, Number(value.relevance_score)))
      : null,
    category: ["exhibition", "open_call", "artist_news", "museum", "nihonga_news"].includes(value.category)
      ? value.category
      : "nihonga_news",
    title: clean(value.title, MAX_TITLE),
    summary: clean(value.summary, 600),
    artist_names: arrayOfStrings(value.artist_names, 120, 30),
    venue: clean(value.venue, 160),
    start_date: dateOrNull(value.start_date),
    end_date: dateOrNull(value.end_date),
    tags: arrayOfStrings(value.tags, 60, 20)
  };
}

function extractContent(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const choiceContent = payload?.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string") return choiceContent;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.output_text === "string") return part.output_text;
    }
  }
  return "";
}

function arrayOfStrings(value, maxLength, maxItems) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function dateOrNull(value) {
  const text = clean(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

module.exports = { handleNewsAi };
module.exports._test = {
  buildPrompt,
  endpointFor,
  extractContent,
  normalizeCandidate,
  normalizeModelResponse
};
