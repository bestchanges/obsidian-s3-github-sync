import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(dir, "src/main.ts")],
  outfile: path.join(dir, "dist/main.js"),
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2021",
  external: ["obsidian"],
  logLevel: "info",
  sourcemap: "inline",
});
console.log("Plugin built → packages/obsidian-plugin/dist/main.js");
