const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-placeholder";
process.env.ADMIN_PASSWORD = "test-admin-password";

const SiteUpdates = require("../public/site-updates.js");
const { _test: publicTest } = require("../api/_updates.js");
const { _test: adminTest } = require("../api/_admin-updates.js");

assert.deepEqual(SiteUpdates.normalize(null), []);
assert.deepEqual(
  SiteUpdates.normalize([
    { id: "1", title: "公開", body: "本文", publishedOn: "2026-09-02" },
    { id: "2", title: "", body: "invalid", publishedOn: "2026-09-01" },
    { id: "3", title: "日付なし", body: "invalid", publishedOn: "" }
  ]),
  [{ id: "1", title: "公開", body: "本文", publishedOn: "2026-09-02" }]
);
assert.equal(SiteUpdates.displayDate("2026-09-02"), "2026.09.02");
assert.equal(publicTest.integer("99", 3, 10), 10);
assert.deepEqual(publicTest.rowToUpdate({ id: "1", title: "A", body: "B", published_on: "2026-09-02" }), {
  id: "1", title: "A", body: "B", publishedOn: "2026-09-02", updatedAt: ""
});

assert.deepEqual(adminTest.normalizeSiteUpdate({
  title: "  更新  ",
  body: " 本文\nです ",
  publishedOn: "2026-09-02",
  status: "published"
}, { requireTitle: true }), {
  title: "更新",
  body: "本文 です",
  published_on: "2026-09-02",
  status: "published"
});
assert.throws(() => adminTest.normalizeSiteUpdate({ title: "A", publishedOn: "2026-02-30", status: "published" }), /发布日期不正确/);
assert.throws(() => adminTest.normalizeSiteUpdate({ title: "A", publishedOn: "2026-09-02", status: "deleted" }), /发布状态不受支持/);
assert.throws(() => adminTest.normalizeSiteUpdate({ title: "A", extra: "x" }), /字段不正确/);

let requests = [];
global.fetch = async (url, options = {}) => {
  requests.push({ url, options });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{ id: "update-1", title: "公開", body: "本文", published_on: "2026-09-02" }])
  };
};

const handler = require("../api/artists.js");
const { Readable } = require("node:stream");

function response() {
  let body;
  return {
    setHeader() {},
    end(value) { body = value ? JSON.parse(value) : null; },
    get body() { return body; }
  };
}

(async () => {
  const publicResponse = response();
  await handler({ method: "GET", url: "/api/artists?resource=updates&limit=3", headers: {} }, publicResponse);
  assert.equal(publicResponse.statusCode, 200);
  assert.equal(publicResponse.body.updates[0].title, "公開");
  assert.ok(requests[0].url.includes("status=eq.published"));
  assert.ok(requests[0].url.includes("limit=3"));

  const unauthorized = response();
  await handler({ method: "GET", url: "/api/artists?resource=admin-updates", headers: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const authorized = response();
  await handler({
    method: "GET",
    url: "/api/artists?resource=admin-updates",
    headers: { "x-admin-password": "test-admin-password" }
  }, authorized);
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.body.updates[0].title, "公開");

  const createRequest = Readable.from([JSON.stringify({
    title: "新しい更新",
    body: "公開前の記録",
    publishedOn: "2026-09-02",
    status: "draft"
  })]);
  createRequest.method = "POST";
  createRequest.url = "/api/artists?resource=admin-updates";
  createRequest.headers = {
    "x-admin-password": "test-admin-password",
    origin: "https://example.test",
    host: "example.test",
    "x-forwarded-proto": "https"
  };
  const created = response();
  await handler(createRequest, created);
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(requests.at(-1).options.body).status, "draft");
  assert.equal(JSON.parse(requests.at(-1).options.body).published_on, "2026-09-02");

  console.log("Site update tests passed: normalization, published-only query, limits, admin authentication and draft creation.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
