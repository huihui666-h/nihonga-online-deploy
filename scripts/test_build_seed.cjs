const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const builder = require("./build-seed.js");

const fixture = {
  artists: [
    {
      id: "private-id-must-not-be-exported",
      name: "O'Reilly",
      romanName: "Painter",
      handle: "@oreilly_art",
      instagram: "https://www.instagram.com/oreilly_art/",
      sourcePage: "https://example.test/source",
      linkType: "instagram",
      region: "東京",
      school: "",
      styles: "日本画, 岩彩",
      note: "Line one\nLine two",
      adminPassword: "must-not-be-exported"
    }
  ]
};

const artist = builder.normalizeArtist(fixture.artists[0]);
assert.deepEqual(artist.styles, ["日本画", "岩彩"]);
assert.equal(artist.name, "O'Reilly");
assert.equal(builder.sanitizeNote("Contact email: artist@example.com"), "Contact email: [contact removed]");
assert.equal(builder.sanitizeNote("WeChat: artist_id Telegram @artist_id 电话: +81 (0)90-1234-5678"), "[contact removed] [contact removed] [contact removed]");
assert.equal(builder.sanitizeNote("online @artist is editorial text"), "online @artist is editorial text");
assert.deepEqual(builder.normalizeStyles(["岩彩", { label: "private" }, 7, null]), ["岩彩", "7"]);
assert.deepEqual(builder.normalizeStyles('["岩彩", {"label":"private"}, 7]'), ["岩彩", "7"]);
assert.deepEqual(builder.normalizeStyles('{"label":"private"}'), []);
assert.equal(builder.sqlLiteral("O'Reilly"), "'O''Reilly'");
assert.equal(builder.sqlLiteral("line\\path\u0000tail"), "'line\\pathtail'");
assert.deepEqual(builder.parseArgs(["--force"]), {
  input: path.join(__dirname, "..", "imports", "existing-artists.json"),
  output: path.join(__dirname, "..", "seed", "supabase-init.sql"),
  force: true
});

const sql = builder.renderSql(fixture.artists, "fixture.json");
assert.match(sql, /insert into public\.artists/);
assert.match(sql, /begin;[\s\S]*delete from public\.artists;[\s\S]*commit;/);
assert.match(sql, /'O''Reilly'/);
assert.match(sql, /'\["日本画","岩彩"\]'::jsonb/);
assert.match(sql, /Line one\nLine two/);
assert.doesNotMatch(sql, /private-id-must-not-be-exported/);
assert.doesNotMatch(sql, /must-not-be-exported/);
assert.doesNotMatch(sql, /artist@example\.com/);
assert.doesNotMatch(sql, /licenses/);
assert.match(sql, /credentials, and unknown fields are omitted/);
assert.throws(() => builder.normalizeArtist({ handle: "@missing_name" }, 3), /missing the required name/);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nihonga-build-seed-"));
try {
  const inputPath = path.join(tempDir, "artists.json");
  const outputPath = path.join(tempDir, "nested", "seed.sql");
  fs.writeFileSync(inputPath, JSON.stringify(fixture), "utf8");
  const result = spawnSync(process.execPath, [path.join(__dirname, "build-seed.js"), "--input", inputPath, "--out", outputPath], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Exported 1 artists/);
  const writtenSql = fs.readFileSync(outputPath, "utf8");
  assert.match(writtenSql, /insert into public\.artists/);
  assert.match(writtenSql, /'O''Reilly'/);
  assert.doesNotMatch(writtenSql, /private-id-must-not-be-exported|must-not-be-exported|licenses/);

  fs.writeFileSync(outputPath, "reviewed seed must be preserved", "utf8");
  const withoutForce = spawnSync(process.execPath, [path.join(__dirname, "build-seed.js"), "--input", inputPath, "--out", outputPath], {
    encoding: "utf8"
  });
  assert.notEqual(withoutForce.status, 0);
  assert.match(withoutForce.stderr, /output already exists/);
  assert.match(withoutForce.stderr, /--force/);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "reviewed seed must be preserved");

  const withForce = spawnSync(process.execPath, [path.join(__dirname, "build-seed.js"), "--input", inputPath, "--out", outputPath, "--force"], {
    encoding: "utf8"
  });
  assert.equal(withForce.status, 0, withForce.stderr);
  assert.match(fs.readFileSync(outputPath, "utf8"), /insert into public\.artists/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("build-seed tests passed.");
