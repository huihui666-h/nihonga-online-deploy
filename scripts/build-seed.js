#!/usr/bin/env node

/* Export the public Artist snapshot as a reviewable Supabase SQL seed. */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "imports", "existing-artists.json");
const DEFAULT_OUTPUT = path.join(ROOT, "seed", "supabase-init.sql");

const ARTIST_COLUMNS = [
  "name",
  "roman_name",
  "handle",
  "instagram",
  "source_page",
  "link_type",
  "region",
  "school",
  "styles",
  "note"
];

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

// Notes are displayed in the directory, but old snapshots may still contain
// contact details copied from a public profile. Keep those details out of a
// portable database seed while preserving the surrounding editorial note.
function sanitizeNote(value) {
  return text(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[contact removed]")
    .replace(/(?<![A-Z])(?:微信|wechat|telegram|line)(?=\s*[:：]|\s+@)\s*[:：]?\s*@?[A-Z0-9._-]{2,}/giu, "[contact removed]")
    .replace(/(?<![A-Z])(?:电话|手机|phone|telephone|tel)(?=\s*[:：]|\s+\+?[0-9])\s*[:：]?\s*\+?[0-9][0-9 .()\-]{6,}/giu, "[contact removed]")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function firstValue(record, ...keys) {
  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(record, key) &&
      record[key] !== null &&
      record[key] !== undefined &&
      (typeof record[key] !== "string" || record[key].trim())
    ) {
      return record[key];
    }
  }
  return "";
}

function normalizeStyles(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" || typeof item === "number").map(text).filter(Boolean);

  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string" || typeof item === "number").map(text).filter(Boolean);
    if (parsed === null || typeof parsed === "object") return [];
  } catch {
    // Treat a plain comma-separated styles value as a legacy snapshot field.
  }
  return raw.split(/[,，、\n]/u).map((item) => item.trim()).filter(Boolean);
}

function normalizeArtist(record, index = 0) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`artists[${index}] must be an object.`);
  }

  const name = text(firstValue(record, "name"));
  if (!name) throw new Error(`artists[${index}] is missing the required name.`);

  return {
    name,
    roman_name: text(firstValue(record, "roman_name", "romanName")),
    handle: text(firstValue(record, "handle")),
    instagram: text(firstValue(record, "instagram")),
    source_page: text(firstValue(record, "source_page", "sourcePage")),
    link_type: text(firstValue(record, "link_type", "linkType")) || "instagram",
    region: text(firstValue(record, "region")),
    school: text(firstValue(record, "school")),
    styles: normalizeStyles(firstValue(record, "styles")),
    note: sanitizeNote(firstValue(record, "note"))
  };
}

function readSnapshot(filePath) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`input snapshot not found: ${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`input snapshot is not valid JSON: ${filePath}`);
    }
    throw error;
  }

  const rows = Array.isArray(payload) ? payload : payload && payload.artists;
  if (!Array.isArray(rows)) {
    throw new Error("input snapshot must be an array or an object with an artists array.");
  }
  return rows.map((record, index) => normalizeArtist(record, index));
}

function sqlLiteral(value) {
  if (value === null || value === undefined || value === "") return "null";
  // PostgreSQL text cannot contain a NUL byte. Other backslashes remain in a
  // standard-conforming string literal and are not interpreted as escapes.
  return `'${String(value).replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

function stylesLiteral(styles) {
  return `${sqlLiteral(JSON.stringify(styles))}::jsonb`;
}

function artistValues(artist) {
  return [
    sqlLiteral(artist.name),
    sqlLiteral(artist.roman_name),
    sqlLiteral(artist.handle),
    sqlLiteral(artist.instagram),
    sqlLiteral(artist.source_page),
    sqlLiteral(artist.link_type),
    sqlLiteral(artist.region),
    sqlLiteral(artist.school),
    stylesLiteral(artist.styles),
    sqlLiteral(artist.note)
  ].join(", ");
}

function renderSql(artists, sourceName = "local Artist snapshot") {
  if (!Array.isArray(artists)) throw new Error("artists must be an array.");
  const normalized = artists.map((artist, index) => normalizeArtist(artist, index));
  const values = normalized.map(artistValues);
  const safeSourceName = text(sourceName).replace(/[\r\n]+/gu, " ");
  const lines = [
    "-- Generated by scripts/build-seed.js. Review before running in Supabase.",
    `-- Source: ${safeSourceName || "local Artist snapshot"}`,
    "-- Only public artists fields are exported; IDs, timestamps, credentials, and unknown fields are omitted.",
    "",
    "begin;",
    "",
    "create extension if not exists pgcrypto;",
    "",
    "create table if not exists public.artists (",
    "  id uuid primary key default gen_random_uuid(),",
    "  name text not null,",
    "  roman_name text default '',",
    "  handle text default '',",
    "  instagram text default '',",
    "  source_page text default '',",
    "  link_type text default 'instagram',",
    "  region text default '',",
    "  school text default '',",
    "  styles jsonb not null default '[]'::jsonb,",
    "  note text default '',",
    "  created_at timestamptz not null default now(),",
    "  updated_at timestamptz not null default now()",
    ");",
    "",
    "alter table public.artists enable row level security;",
    "",
    "-- Full-snapshot seed: this intentionally removes existing Artist rows.",
    "-- Review the input and keep a database backup before running this file.",
    "delete from public.artists;"
  ];

  if (values.length) {
    lines.push(
      "",
      "insert into public.artists",
      `  (${ARTIST_COLUMNS.join(", ")})`,
      "values",
      values.map((value, index) => `(${value})${index === values.length - 1 ? ";" : ","}`).join("\n")
    );
  } else {
    lines.push("", "-- No artist rows were present in the input snapshot.");
  }

  lines.push("", "commit;");

  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--force" || argument === "-f") {
      options.force = true;
      continue;
    }
    if (argument === "--input" || argument === "-i") {
      options.input = path.resolve(ROOT, argv[++index] || "");
      continue;
    }
    if (argument === "--out" || argument === "-o") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a path (or - for stdout).`);
      options.output = value === "-" ? "-" : path.resolve(ROOT, value);
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/build-seed.js [options]",
    "",
    "Options:",
    "  -i, --input PATH  Artist JSON snapshot (default: imports/existing-artists.json)",
    "  -o, --out PATH    SQL output path, or - for stdout (default: seed/supabase-init.sql)",
    "  -f, --force       Overwrite an existing output file",
    "  -h, --help        Show this help"
  ].join("\n");
}

function writeOutput(filePath, contents, options = {}) {
  if (filePath === "-") {
    process.stdout.write(contents);
    return;
  }

  // Refuse accidental replacement of a reviewed seed. A caller can opt in
  // explicitly with --force; stdout remains available for a dry review.
  const force = options === true || Boolean(options && options.force);
  if (!force && fs.existsSync(filePath)) {
    throw new Error(`output already exists: ${filePath}; pass --force to overwrite`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let backupPath = "";
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    // Windows does not replace an existing path with renameSync. Move the old
    // file aside first so a failed replacement can restore it.
    if (force && fs.existsSync(filePath)) {
      backupPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.bak`;
      fs.renameSync(filePath, backupPath);
    }
    fs.renameSync(temporaryPath, filePath);
    if (backupPath) fs.rmSync(backupPath, { force: true });
  } catch (error) {
    if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(filePath)) {
      try { fs.renameSync(backupPath, filePath); } catch { /* preserve the original error */ }
    }
    throw error;
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    if (backupPath && fs.existsSync(backupPath) && fs.existsSync(filePath)) fs.rmSync(backupPath, { force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const artists = readSnapshot(options.input);
  const sourceName = path.relative(ROOT, options.input).replace(/\\/g, "/") || path.basename(options.input);
  writeOutput(options.output, renderSql(artists, sourceName), { force: options.force });
  if (options.output !== "-") process.stdout.write(`Exported ${artists.length} artists to ${options.output}\n`);
}

module.exports = {
  ARTIST_COLUMNS,
  normalizeArtist,
  normalizeStyles,
  sanitizeNote,
  parseArgs,
  readSnapshot,
  renderSql,
  sqlLiteral,
  writeOutput
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`build-seed: ${error.message || error}\n`);
    process.exitCode = 1;
  }
}
