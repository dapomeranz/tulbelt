// Packages the extension as dist/tulbelt-<version>.zip, ready to upload to the
// Chrome Web Store. There is still no build step for development: load the repo
// unpacked. This only bundles the shipped files, so the zip is an allowlist
// (docs, probes and gitignored local notes never ship). Zip writing uses
// node:zlib directly to keep the repo dependency-free.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = join(import.meta.dirname, "..");
const SHIPPED = [
  "manifest.json",
  "background.js",
  "features.js",
  "edition.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons",
  "toggles",
  "LICENSE",
];

function listFiles(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((name) => listFiles(join(path, name)));
}

const files = SHIPPED.flatMap((p) => listFiles(join(ROOT, p))).map((abs) =>
  relative(ROOT, abs).split("\\").join("/"),
);

// Every file the manifest points at must be in the zip, or the packaged
// extension fails to load even though the unpacked repo works.
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
].filter(Boolean);
const missing = [...new Set(referenced)].filter((f) => !files.includes(f));
if (missing.length) {
  console.error(`manifest.json references files that would not ship:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

// Minimal zip writer: deflated entries plus a central directory. Timestamps are
// pinned to 1980-01-01 so the same sources always produce the same zip.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const locals = [];
const centrals = [];
let offset = 0;
for (const name of files) {
  const data = readFileSync(join(ROOT, name));
  const packed = deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  locals.push(local, nameBuf, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  local.copy(central, 6, 4, 30); // shared fields: version needed … name length
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + packed.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const outDir = join(ROOT, "dist");
if (!existsSync(outDir)) mkdirSync(outDir);
const out = join(outDir, `tulbelt-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`Built ${relative(ROOT, out)} (${files.length} files)`);
