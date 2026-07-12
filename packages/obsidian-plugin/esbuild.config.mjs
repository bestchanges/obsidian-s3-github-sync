import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "dist");
mkdirSync(dist, { recursive: true });

const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));

await esbuild.build({
  entryPoints: [path.join(dir, "src/main.ts")],
  outfile: path.join(dist, "main.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2021",
  external: ["obsidian"],
  logLevel: "info",
  // Inline sourcemap by default (debuggable in-app); set PLUGIN_SOURCEMAP=false for a leaner release.
  sourcemap: process.env.PLUGIN_SOURCEMAP === "false" ? false : "inline",
});

// Assemble a drop-in plugin folder. Obsidian loads a plugin from exactly manifest.json + main.js
// (+ optional versions.json/styles.css), so dist/ is copy-ready and the zip is a transferable
// package whose contents equal a GitHub Release's assets (what BRAT downloads).
copyFileSync(path.join(dir, "manifest.json"), path.join(dist, "manifest.json"));
const pkgFiles = {
  "manifest.json": readFileSync(path.join(dist, "manifest.json")),
  "main.js": readFileSync(path.join(dist, "main.js")),
};
const versionsSrc = path.join(dir, "versions.json");
if (existsSync(versionsSrc)) {
  copyFileSync(versionsSrc, path.join(dist, "versions.json"));
  pkgFiles["versions.json"] = readFileSync(versionsSrc);
}

const zipName = `${manifest.id}-${manifest.version}.zip`;
writeFileSync(path.join(dist, zipName), zipSync(pkgFiles, { level: 9 }));

console.log(`Plugin built → dist/main.js`);
console.log(
  `Deployment package → dist/${zipName}  (v${manifest.version}, minAppVersion ${manifest.minAppVersion})`,
);
