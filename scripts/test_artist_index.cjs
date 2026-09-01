const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const index = require("../public/artist-index.js");
const old = JSON.parse(fs.readFileSync(require("node:path").resolve(__dirname, "../imports/existing-artists.json"), "utf8")).artists;
// Test-only records, never imported into the product or production database.
const records = [
  { id: "test-a", name: "検証 A", romanName: "Painter A", handle: "@artist.a", region: "東京", school: "東京藝術大学", styles: ["人物", "幻想"], huiNote: "静かな画面", createdAt: "2025-01-01T00:00:00Z" },
  { id: "test-b", name: "検証 B", styles: ["風景"], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" },
  { id: "test-c", name: "検証 C", updatedAt: "2026-09-01T00:00:00Z" }
];
assert.ok(old.length > 0);
assert.equal(index.recent(old).length, 0, "Legacy updatedAt must not become an added date");
assert.doesNotThrow(() => old.forEach((artist) => { index.matches(artist); index.editorial(artist); index.instagram(artist); }));
assert.ok(index.matches(records[0], { query: "PAINTER a" }));
assert.ok(index.matches(records[0], { query: "ＰＡＩＮＴＥＲ" }));
for (const query of ["人物", "東京藝術大学", "東京", "ARTIST.A", "静かな"]) assert.ok(index.matches(records[0], { query }));
assert.ok(index.matches(records[0], { region: "東京", school: "東京藝術大学", tag: "幻想" }));
assert.ok(!index.matches(records[0], { region: "京都", tag: "幻想" }));
assert.ok(!index.matches(records[0], { tag: "風景" }));
assert.deepEqual(index.recent(records).map(a => a.id), ["test-b", "test-a"]);
assert.deepEqual(index.recent([]), [], "No artists produces no recent cards");
assert.deepEqual(index.recent([{ id: "undated" }]), [], "Undated artists do not produce placeholder cards");
assert.deepEqual(index.recent([
  { id: "older", addedAt: "2025-01-01T00:00:00Z" },
  { id: "newer", createdAt: "2026-01-01T00:00:00Z" }
]).map((artist) => artist.id), ["newer", "older"], "Fully dated artists sort newest first");
assert.equal(index.addedTime({ createdAt: "bad", addedAt: "" }), null);
assert.equal(index.random([], null), null);
assert.equal(index.random([records[0]], "test-a").id, "test-a");
assert.equal(index.random(records, "test-a", () => 0).id, "test-b");
assert.deepEqual(index.featured(old, "2026-09-01"), index.featured(old, "2026-09-01"));
assert.equal(index.featured([{ ...records[0], featured: true }, ...records.slice(1)], "day")[0].id, "test-a");
assert.deepEqual(index.resolveIds(["missing", "test-b", "test-b", { id: "test-a" }], records), [records[1]]);
assert.equal(index.safeUrl("javascript:alert(1)"), "");
assert.equal(index.instagram({ handle: "IG 待补" }), "");
assert.equal(index.instagram({ instagram: "https://www.instagram.com/待会补/" }), "", "Placeholder Instagram URLs stay hidden");
assert.equal(index.instagram({ instagram: "https://www.instagram.com/real/?igsh=abc" }), "https://www.instagram.com/real/?igsh=abc");
assert.equal(index.clean("Unknown"), "");
assert.equal(index.editorial(records[0], { "test-a": { huiNote: "HUI supplied note" } }).huiNote, "HUI supplied note");
assert.equal(records[0].huiNote, "静かな画面", "Editorial metadata never mutates source data");
let requests = 0;
const context = { window: { ArtistIndex: index }, fetch: () => { requests++; throw new Error("No network allowed"); } };
vm.runInNewContext(fs.readFileSync(require("node:path").resolve(__dirname, "../public/ai-finder-service.js"), "utf8"), context);
(async () => {
  const response = await context.window.ArtistFinderService.findArtists({ query: "Find painters" });
  assert.equal(response.status, "coming-soon");
  assert.equal(response.artistIds.length, 0);
  assert.equal(requests, 0);
  assert.deepEqual(context.window.ArtistFinderService.resolveArtists({ artistIds: ["invented", "test-a"] }, records), [records[0]]);
  console.log(`Artist index tests passed: ${old.length} legacy artists, search/filter combinations, dates, random, safe links, editorial metadata, real-ID resolution and zero AI requests.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
