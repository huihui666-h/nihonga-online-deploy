const assert = require("node:assert/strict");
const { canonicalInstagramHandle, normalizeArtist } = require("../api/_supabase");

assert.equal(canonicalInstagramHandle("@Artist_Name"), "artist_name");
assert.equal(
  canonicalInstagramHandle("https://instagram.com/Artist_Name/?utm_source=seed"),
  "artist_name"
);
assert.equal(canonicalInstagramHandle("https://www.instagram.com/p/ABC123/"), "");
assert.equal(canonicalInstagramHandle("https://www.instagram.com/artist/posts/"), "");
assert.equal(canonicalInstagramHandle("https://example.com/artist"), "");

const normalized = normalizeArtist({
  name: "  山田　花子 ",
  handle: "@Artist_Name",
  instagram: "https://instagram.com/Artist_Name/?utm_source=seed",
  styles: [" 人物 ", "", "岩彩"],
  note: " public source "
});
assert.deepEqual(normalized, {
  name: "山田 花子",
  roman_name: "",
  handle: "@artist_name",
  instagram: "https://www.instagram.com/artist_name/",
  source_page: "https://www.instagram.com/artist_name/",
  link_type: "instagram",
  region: "",
  school: "",
  styles: ["人物", "岩彩"],
  note: "public source"
});

console.log("Artist write normalization tests passed.");
