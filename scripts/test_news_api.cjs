const assert = require("node:assert/strict");
const NewsData = require("../public/news-data.js");

const now = Date.parse("2026-09-01T12:00:00Z");
const rows = [
  { id: "old", status: "published", category: "exhibition", publishedAt: "2026-08-01", endDate: "2026-08-31" },
  { id: "one", status: "published", category: "exhibition", publishedAt: "2026-09-01" },
  { id: "two", status: "published", category: "open_call", publishedAt: "2026-09-02" },
  { id: "three", status: "published", category: "artist_news", publishedAt: "2026-09-03" },
  { id: "four", status: "published", category: "exhibition", publishedAt: "2026-09-04" },
  { id: "museum-old", status: "published", category: "museum", publishedAt: "2026-08-01", endDate: "2026-01-01" },
  { id: "new-artist", status: "published", category: "new_artist", publishedAt: "2026-09-06" },
  { id: "draft", status: "candidate", category: "exhibition", publishedAt: "2026-09-05" }
];
assert.deepEqual(NewsData.select([], { now }), [], "Homepage supports no news");
assert.deepEqual(NewsData.select(rows.slice(1, 2), { limit: 3, now }).map((item) => item.id), ["one"], "Homepage supports one news item");
assert.deepEqual(NewsData.select(rows, { limit: 3, now }).map((item) => item.id), ["four", "three", "two"], "Homepage caps at three and excludes expired/candidates");
assert.deepEqual(NewsData.select(rows, { category: "exhibition", now }).map((item) => item.id), ["four", "one"], "Category filter excludes expired items");
assert.deepEqual(NewsData.select(rows, { category: "open_call", now }).map((item) => item.id), ["two"]);
assert.deepEqual(NewsData.select(rows, { category: "artist_news", now }).map((item) => item.id), ["three"]);
assert.equal(NewsData.active({ status: "published", endDate: "2026-09-01" }, now), true, "End dates remain active through the Tokyo calendar day");
assert.equal(NewsData.active({ status: "published", endDate: "2026-08-31" }, now), false, "Past Tokyo dates are expired");
assert.equal(NewsData.active({ status: "published", category: "museum", endDate: "2026-08-31" }, now), true, "Only exhibitions and open calls expire by end date");
assert.equal(NewsData.active({ status: "published", category: "new_artist", publishedAt: "2026-09-06" }, now), false, "Directory additions are not automatically treated as news");
assert.equal(NewsData.cleanTitle("2026-09-01 日本画展"), "日本画展", "A duplicated leading date is removed from a news title");
assert.equal(NewsData.cleanTitle("お知らせ：日本画展"), "日本画展", "Generic notification prefixes are removed from homepage titles");
assert.equal(NewsData.categoryLabel({ title: "西田俊英理事長の雑誌掲載記事について", category: "open_call" }), "作家動向", "Headline semantics correct a coarse crawler category label");
assert.equal(NewsData.itemCategory({ title: "西田俊英理事長の雑誌掲載記事について", category: "open_call" }), "artist_news", "Semantic categories keep corrected items out of the wrong tab");
assert.equal(NewsData.displayDate("2026-9-1"), "2026.09.01", "News dates use one consistent display format");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-placeholder";
let requested = [];
global.fetch = async (url) => {
  requested.push(url);
  if (url.includes("news_artists")) return { ok: true, text: async () => JSON.stringify([{ news_id: "one", artists: { id: "artist-1", name: "山田 花子", roman_name: "Hanako Yamada" } }]) };
  return { ok: true, text: async () => JSON.stringify([{ id: "one", title: "日本画展", status: "published", category: "exhibition", source_name: "日展", source_url: "https://example.test/one", end_date: "2026-10-01", raw_artist_names: ["山田花子"] }]) };
};
const handler = require("../api/artists.js");
const newsUtils = require("../api/_news-utils.js");
assert.equal(newsUtils.cleanNewsTitle("お知らせ：日本画展"), "日本画展", "Server news titles use the same compact cleanup");
assert.equal(newsUtils.newsCategoryLabel({ title: "西田俊英理事長の雑誌掲載記事について", category: "open_call" }), "作家動向", "Server news details use the same semantic category label");
(async () => {
  let body;
  const response = { setHeader() {}, end(value) { body = JSON.parse(value); } };
  await handler({ method: "GET", url: "/api/artists?resource=news&category=exhibition&limit=3" }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(body.news.length, 1);
  assert.deepEqual(body.news[0].relatedArtists, [{ id: "artist-1", name: "山田 花子", romanName: "Hanako Yamada" }]);
  assert.ok(requested[0].includes("status=eq.published"));
  assert.ok(requested[0].includes("category=neq.new_artist"));
  assert.ok(requested[0].includes("category.not.in.(exhibition,open_call)"));
  assert.ok(requested[0].includes("end_date.gte."));
  assert.ok(requested[0].includes("category=eq.exhibition"));
  assert.ok(requested[1].includes("news_artists"));

  // A database outage must be visible to the news client instead of being
  // represented as a successful empty result (which would hide incidents).
  global.fetch = async () => { throw new Error("database unavailable"); };
  let failureBody;
  const failureResponse = { setHeader() {}, end(value) { failureBody = JSON.parse(value); } };
  await handler({ method: "GET", url: "/api/artists?resource=news&limit=3" }, failureResponse);
  assert.equal(failureResponse.statusCode, 503);
  assert.equal(failureBody.ok, false);
  assert.equal(failureBody.news.length, 0);

  const functions = require("node:fs").readdirSync(require("node:path").resolve(__dirname, "../api"))
    .filter((name) => name.endsWith(".js") && !name.startsWith("_"));
  assert.ok(functions.length <= 12, `Vercel function count must stay within 12, found ${functions.length}`);
  console.log("News tests passed: homepage counts, category filtering, expiry filtering, API joins and related artist mapping.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
