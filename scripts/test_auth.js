const assert = require("assert");

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key";

const {
  getSessionToken,
  hashPassword,
  normalizeEmail,
  publicUser,
  requireSameOrigin,
  setSessionCookie,
  verifyPassword
} = require("../api/_auth");

async function main() {
  assert.strictEqual(normalizeEmail("  Artist@Example.COM "), "artist@example.com");
  assert.strictEqual(normalizeEmail("not-an-email"), "");
  assert.strictEqual(normalizeEmail("x@y"), "");

  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
  assert.strictEqual(await verifyPassword("correct horse battery staple", encoded), true);
  assert.strictEqual(await verifyPassword("wrong password", encoded), false);
  assert.strictEqual(await verifyPassword("correct horse battery staple", "damaged"), false);

  const token = "A".repeat(43);
  assert.strictEqual(getSessionToken({ headers: { cookie: `nihonga_session=${token}` } }), token);
  assert.strictEqual(getSessionToken({ headers: { authorization: `Bearer ${token}` } }), token);
  assert.strictEqual(getSessionToken({ headers: { cookie: "nihonga_session=bad" } }), "");

  const forbiddenResponse = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
  assert.strictEqual(requireSameOrigin({
    headers: {
      origin: "https://evil.example",
      host: "nihonga.example",
      "x-forwarded-proto": "https"
    }
  }, forbiddenResponse), false);
  assert.strictEqual(forbiddenResponse.statusCode, 403);

  assert.strictEqual(requireSameOrigin({
    headers: {
      origin: "https://nihonga.example",
      host: "nihonga.example",
      "x-forwarded-proto": "https"
    }
  }, forbiddenResponse), true);

  assert.strictEqual(requireSameOrigin({
    headers: {
      origin: "https://nihonga.example",
      host: "nihonga.example"
    }
  }, forbiddenResponse), true);

  assert.deepStrictEqual(publicUser({
    id: "u1",
    email: "artist@example.com",
    display_name: "Artist",
    status: "active",
    email_verified_at: null,
    created_at: "2026-01-01T00:00:00Z",
    last_login_at: null,
    password_hash: "must-not-leak"
  }), {
    id: "u1",
    email: "artist@example.com",
    displayName: "Artist",
    status: "active",
    emailVerified: false,
    createdAt: "2026-01-01T00:00:00Z",
    lastLoginAt: ""
  });

  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    }
  };
  setSessionCookie({ headers: { "x-forwarded-proto": "https" } }, response, token, 3600);
  assert.match(response.headers["Set-Cookie"], /^nihonga_session=/);
  assert.match(response.headers["Set-Cookie"], /HttpOnly/);
  assert.match(response.headers["Set-Cookie"], /SameSite=Lax/);
  assert.match(response.headers["Set-Cookie"], /Secure/);

  console.log("auth tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
