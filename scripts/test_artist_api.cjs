const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-placeholder";
const row = { id: "test-artist", name: "Test record", roman_name: "Test", handle: "@test", instagram: "https://www.instagram.com/test/?keep=1", source_page: "https://example.org", link_type: "instagram", region: "東京", school: "東京藝術大学", styles: ["人物"], note: "Original source note", created_at: "2025-01-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z" };
let responseRows = [row];
global.fetch = async (url, options) => {
  assert.equal(url, "https://example.supabase.co/rest/v1/artists?select=*&order=name.asc");
  assert.equal(options.method, undefined, "Artist reading must stay a GET");
  return { ok: true, text: async () => JSON.stringify(responseRows) };
};
const handler = require("../api/artists.js");
const { artistSources } = require("../api/_artist-utils.js");
const { renderArtistPage } = require("../api/_artist-page.js");
async function request() {
  let payload;
  const res = { setHeader() {}, end(body) { payload = JSON.parse(body); } };
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  return payload.artists[0];
}
(async () => {
  const result = await request();
  for (const [apiKey, rowKey] of Object.entries({ id: "id", name: "name", romanName: "roman_name", handle: "handle", instagram: "instagram", sourcePage: "source_page", linkType: "link_type", region: "region", school: "school", styles: "styles", note: "note", updatedAt: "updated_at" })) assert.deepEqual(result[apiKey], row[rowKey], `${apiKey} remains unchanged`);
  assert.equal(result.createdAt, row.created_at);
  assert.ok(!("huiNote" in result));
  assert.ok(!("featured" in result));
  responseRows = [{ ...row, hui_note: "Hand-written HUI note", featured: true, image_url: "https://example.org/licensed.jpg" }];
  const optional = await request();
  assert.equal(optional.huiNote, "Hand-written HUI note");
  assert.equal(optional.featured, true);
  assert.equal(optional.imageUrl, "https://example.org/licensed.jpg");
  responseRows = [{ id: "old", name: "Old record" }];
  const legacy = await request();
  assert.deepEqual(legacy.styles, []);
  assert.ok(!("createdAt" in legacy));
  const sourceList = artistSources({ instagram: "https://www.instagram.com/test/", source_url: "https://example.org/profile", link_type: "website" });
  assert.deepEqual(sourceList.map((source) => source.name), ["公式サイト", "Instagram"]);
  assert.deepEqual(artistSources({ instagram: "https://www.instagram.com/https/", source_page: "https://www.instagram.com/https/", link_type: "instagram" }), [], "Invalid Instagram identities stay out of public source lists");
  const html = renderArtistPage({ ...row, sources: [{ source_name: "東京藝術大学", source_type: "大学", source_url: "https://example.org/source" }] }, "test-artist", new Map([[row.id, "test-artist"]]));
  assert.match(html, /<h1>Test record<\/h1>/, "Initial artist HTML contains the artist name");
  assert.match(html, /東京藝術大学/, "Initial artist HTML contains school and source information");
  assert.match(html, /<link rel="canonical" href="https:\/\/nihonga-online-deploy\.vercel\.app\/artists\/test-artist">/);
  assert.match(html, /application\/ld\+json/, "Artist detail includes structured data");
  console.log("Artist API tests passed: same query, unchanged legacy fields, optional metadata and missing-field compatibility.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
