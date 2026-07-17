import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(dir, "dist");
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(dir, "src/handler.ts")],
  outfile: path.join(dist, "index.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "info",
  // Bundled CJS deps (AWS SDK) call require() at runtime; an ESM bundle has none without this.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

// Deployment zip: index.mjs at the archive root (Lambda handler = `index.handler`, ESM runtime).
// Explicit unix mode — entries default to 0, which the Lambda runtime cannot read.
const zip = zipSync(
  { "index.mjs": [readFileSync(path.join(dist, "index.mjs")), { os: 3, attrs: 0o644 << 16 }] },
  { level: 9 },
);
writeFileSync(path.join(dist, "mcp-server.zip"), zip);
console.log("Lambda bundle → dist/index.mjs · package → dist/mcp-server.zip");
