const assert = require("assert");
const { Readable } = require("stream");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.ADMIN_PASSWORD = "test-admin-password";
process.env.NODE_ENV = "test";

const targetUserId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const users = [{
  id: targetUserId,
  email: "member@example.com",
  password_hash: "must-never-leave-the-api",
  display_name: "Member",
  status: "active",
  email_verified_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
  last_login_at: "2026-09-01T01:00:00.000Z"
}];
const artists = [{ id: "artist-1", name: "Test Artist", updated_at: "2026-09-01T00:00:00.000Z" }];
const sessions = [
  { id: "session-target", user_id: targetUserId },
  { id: "session-other", user_id: otherUserId }
];
const calls = [];

global.fetch = async function mockSupabaseFetch(input, options = {}) {
  const url = new URL(input);
  const table = url.pathname.split("/").pop();
  const method = String(options.method || "GET").toUpperCase();
  const payload = options.body ? JSON.parse(options.body) : null;
  const rows = table === "site_users" ? users : table === "site_sessions" ? sessions : table === "artists" ? artists : null;
  calls.push({ table, method });
  if (!rows) return jsonResponse(404, { message: "table not found" });

  const filtered = rows.filter((row) => {
    for (const [key, raw] of url.searchParams.entries()) {
      if (["select", "limit", "order"].includes(key) || !raw.startsWith("eq.")) continue;
      if (String(row[key]) !== raw.slice(3)) return false;
    }
    return true;
  });

  if (method === "GET") return jsonResponse(200, filtered);
  if (method === "PATCH") {
    filtered.forEach((row) => Object.assign(row, payload));
    return jsonResponse(200, filtered);
  }
  if (method === "DELETE") {
    filtered.forEach((row) => {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
    });
    return jsonResponse(204, null);
  }
  return jsonResponse(405, { message: "method not allowed" });
};

const adminArtists = require("../api/admin-artists");

function jsonResponse(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function request(method, url, body, password = process.env.ADMIN_PASSWORD, origin = "https://nihonga.example") {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []);
  req.method = method;
  req.url = url;
  req.headers = {
    host: "nihonga.example",
    origin,
    "x-forwarded-proto": "https",
    "x-admin-password": password
  };
  return req;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value = "") { this.body = String(value); },
    json() { return JSON.parse(this.body || "{}"); }
  };
}

async function call(method, url, body, password, origin) {
  const res = response();
  await adminArtists(request(method, url, body, password, origin), res);
  return res;
}

async function main() {
  const callCount = calls.length;
  const unauthorized = await call("GET", "/api/admin-artists?resource=users", undefined, "wrong-password");
  assert.strictEqual(unauthorized.statusCode, 401);
  assert.strictEqual(calls.length, callCount);

  const listed = await call("GET", "/api/admin-artists?resource=users");
  assert.strictEqual(listed.statusCode, 200);
  assert.strictEqual(listed.headers["cache-control"], "no-store");
  assert.strictEqual(listed.json().users[0].email, "member@example.com");
  assert.ok(!listed.body.includes("password_hash"));
  assert.ok(!listed.body.includes("must-never-leave-the-api"));

  const artistList = await call("GET", "/api/admin-artists");
  assert.strictEqual(artistList.statusCode, 200);
  assert.strictEqual(artistList.json().artists[0].name, "Test Artist");

  const unknownResource = await call("GET", "/api/admin-artists?resource=secrets");
  assert.strictEqual(unknownResource.statusCode, 400);

  const crossOrigin = await call(
    "PATCH",
    `/api/admin-artists?resource=users&id=${targetUserId}`,
    { status: "disabled" },
    process.env.ADMIN_PASSWORD,
    "https://other.example"
  );
  assert.strictEqual(crossOrigin.statusCode, 403);

  const extraField = await call(
    "PATCH",
    `/api/admin-artists?resource=users&id=${targetUserId}`,
    { status: "disabled", email: "changed@example.com" }
  );
  assert.strictEqual(extraField.statusCode, 400);

  const invalidId = await call("PATCH", "/api/admin-artists?resource=users&id=bad-id", { status: "disabled" });
  assert.strictEqual(invalidId.statusCode, 400);

  const invalidBody = await call(
    "PATCH",
    `/api/admin-artists?resource=users&id=${targetUserId}`,
    null
  );
  assert.strictEqual(invalidBody.statusCode, 400);

  const invalidArrayBody = await call(
    "PATCH",
    `/api/admin-artists?resource=users&id=${targetUserId}`,
    [{ status: "disabled" }]
  );
  assert.strictEqual(invalidArrayBody.statusCode, 400);

  const missingUser = await call(
    "PATCH",
    "/api/admin-artists?resource=users&id=33333333-3333-4333-8333-333333333333",
    { status: "disabled" }
  );
  assert.strictEqual(missingUser.statusCode, 404);

  const createUser = await call("POST", "/api/admin-artists?resource=users", { email: "new@example.com" });
  assert.strictEqual(createUser.statusCode, 405);
  const deleteUser = await call("DELETE", `/api/admin-artists?resource=users&id=${targetUserId}`);
  assert.strictEqual(deleteUser.statusCode, 405);

  const disabled = await call(
    "PATCH",
    `/api/admin-artists?resource=users&id=${targetUserId}`,
    { status: "disabled" }
  );
  assert.strictEqual(disabled.statusCode, 200);
  assert.strictEqual(disabled.json().user.status, "disabled");
  assert.deepStrictEqual(sessions.map((item) => item.id), ["session-other"]);

  sessions.push({ id: "stale-session", user_id: targetUserId });
  const beforeEnable = calls.length;
  const enabled = await call(
    "PATCH",
    `/api/admin-artists?resource=users&id=${targetUserId}`,
    { status: "active" }
  );
  assert.strictEqual(enabled.statusCode, 200);
  assert.strictEqual(enabled.json().user.status, "active");
  assert.deepStrictEqual(sessions.map((item) => item.id), ["session-other"]);
  assert.deepStrictEqual(calls.slice(beforeEnable, beforeEnable + 2), [
    { table: "site_sessions", method: "DELETE" },
    { table: "site_users", method: "PATCH" }
  ]);

  const invalidStatus = await call(
    "PATCH",
    `/api/admin-artists?resource=users&id=${targetUserId}`,
    { status: "deleted" }
  );
  assert.strictEqual(invalidStatus.statusCode, 400);

  console.log("admin user endpoint tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
