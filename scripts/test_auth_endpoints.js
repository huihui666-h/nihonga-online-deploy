const assert = require("assert");
const { Readable } = require("stream");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.NODE_ENV = "test";

const users = [];
const sessions = [];
const submissions = [];
let nextId = 1;

global.fetch = async function mockSupabaseFetch(input, options = {}) {
  const url = new URL(input);
  const table = url.pathname.split("/").pop();
  const method = String(options.method || "GET").toUpperCase();
  const payload = options.body ? JSON.parse(options.body) : null;
  const rows = table === "site_users"
    ? users
    : table === "site_sessions"
      ? sessions
      : table === "artist_submissions"
        ? submissions
        : null;
  if (!rows) return jsonResponse(404, { message: "table not found" });

  const filtered = rows.filter((row) => {
    for (const [key, raw] of url.searchParams.entries()) {
      if (["select", "limit", "order"].includes(key)) continue;
      if (!raw.startsWith("eq.")) continue;
      if (String(row[key]) !== raw.slice(3)) return false;
    }
    return true;
  });

  if (method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") || "", 10);
    return jsonResponse(200, Number.isFinite(limit) ? filtered.slice(0, limit) : filtered);
  }
  if (method === "POST") {
    const items = Array.isArray(payload) ? payload : [payload];
    const created = items.map((item) => {
      const now = new Date().toISOString();
      const row = { id: `id-${nextId++}`, created_at: now, last_seen_at: now, ...item };
      rows.push(row);
      return row;
    });
    return jsonResponse(201, created);
  }
  if (method === "PATCH") {
    filtered.forEach((row) => Object.assign(row, payload));
    return jsonResponse(200, options.headers && /return=representation/.test(options.headers.prefer || "") ? filtered : null);
  }
  if (method === "DELETE") {
    for (const row of filtered) {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
    }
    return jsonResponse(204, null);
  }
  return jsonResponse(405, { message: "method not allowed" });
};

const register = require("../api/auth-register");
const login = require("../api/auth-login");
const session = require("../api/auth-session");
const logout = require("../api/auth-logout");
const submitArtist = require("../api/submissions");
const reportCorrection = require("../api/report-correction");

function jsonResponse(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function request(method, body, cookie = "", origin = "https://nihonga.example") {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []);
  req.method = method;
  req.url = "/";
  req.headers = {
    host: "nihonga.example",
    origin,
    "x-forwarded-proto": "https",
    "user-agent": "auth-test",
    cookie
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

async function call(handler, method, body, cookie = "", origin) {
  const res = response();
  await handler(request(method, body, cookie, origin), res);
  return res;
}

async function main() {
  const registered = await call(register, "POST", {
    email: " Artist@Example.com ",
    password: "strong-password",
    displayName: "日本画 学习者",
    remember: true
  });
  assert.strictEqual(registered.statusCode, 201);
  assert.strictEqual(registered.json().user.email, "artist@example.com");
  assert.ok(registered.json().user.lastLoginAt);
  assert.ok(!registered.body.includes("password_hash"));
  assert.notStrictEqual(users[0].password_hash, "strong-password");

  const setCookie = registered.headers["set-cookie"];
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(";")[0];

  const current = await call(session, "GET", undefined, cookie);
  assert.strictEqual(current.statusCode, 200);
  assert.strictEqual(current.json().authenticated, true);
  assert.strictEqual(current.json().user.email, "artist@example.com");

  const guestSubmission = await call(submitArtist, "POST", {
    name: "测试画家",
    instagram: "@test_artist"
  });
  assert.strictEqual(guestSubmission.statusCode, 401);
  assert.strictEqual(guestSubmission.json().message, "请登录后使用此功能。");

  const guestCorrection = await call(reportCorrection, "POST", {
    artistId: "artist-1",
    artistName: "测试画家",
    note: "更新资料"
  });
  assert.strictEqual(guestCorrection.statusCode, 401);
  assert.strictEqual(guestCorrection.json().message, "请登录后使用此功能。");
  assert.strictEqual(submissions.length, 0);

  const memberSubmission = await call(submitArtist, "POST", {
    name: "测试画家",
    instagram: "@test_artist"
  }, cookie);
  assert.strictEqual(memberSubmission.statusCode, 200);
  assert.strictEqual(memberSubmission.json().submission.status, "pending");

  const memberCorrection = await call(reportCorrection, "POST", {
    artistId: "artist-1",
    artistName: "测试画家",
    note: "更新资料"
  }, cookie);
  assert.strictEqual(memberCorrection.statusCode, 200);
  assert.strictEqual(memberCorrection.json().submission.status, "correction");
  assert.strictEqual(submissions.length, 2);

  const crossOriginSubmission = await call(submitArtist, "POST", {
    name: "测试画家",
    instagram: "@test_artist"
  }, cookie, "https://evil.example");
  assert.strictEqual(crossOriginSubmission.statusCode, 403);
  assert.strictEqual(submissions.length, 2);

  const wrong = await call(login, "POST", {
    email: "artist@example.com",
    password: "wrong-password"
  });
  assert.strictEqual(wrong.statusCode, 401);

  const loggedOut = await call(logout, "POST", {}, cookie);
  assert.strictEqual(loggedOut.statusCode, 200);
  assert.strictEqual(sessions.length, 0);
  assert.match(loggedOut.headers["set-cookie"], /Max-Age=0/);

  const loggedIn = await call(login, "POST", {
    email: "artist@example.com",
    password: "strong-password",
    remember: false
  });
  assert.strictEqual(loggedIn.statusCode, 200);
  assert.doesNotMatch(loggedIn.headers["set-cookie"], /Max-Age=/);

  console.log("auth endpoint tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
