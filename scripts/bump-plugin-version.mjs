// Bump the Obsidian plugin version in one place so manifest.json (Obsidian's source of truth),
// package.json, and versions.json (plugin version → minAppVersion, used by Obsidian/BRAT) never
// drift apart. Run `npm run build:plugin` afterwards to produce the deployment package.
//
// Usage: node scripts/bump-plugin-version.mjs <major.minor.patch>
//    or: npm run bump:plugin -- 0.2.0
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgDir = path.join(root, "packages/obsidian-plugin");

const target = process.argv[2];
if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
  console.error("Usage: node scripts/bump-plugin-version.mjs <major.minor.patch>");
  process.exit(1);
}

const writeJson = (file, obj) => writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");

const manifestPath = path.join(pkgDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const prev = manifest.version;
manifest.version = target;
writeJson(manifestPath, manifest);

const pkgPath = path.join(pkgDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = target;
writeJson(pkgPath, pkg);

const versionsPath = path.join(pkgDir, "versions.json");
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
versions[target] = manifest.minAppVersion; // bump minAppVersion in manifest.json first if it changed
writeJson(versionsPath, versions);

console.log(`plugin version ${prev} → ${target} (minAppVersion ${manifest.minAppVersion})`);
console.log("updated: manifest.json, package.json, versions.json");
console.log("next: npm run build:plugin   # produces dist/ + the deployment zip");
