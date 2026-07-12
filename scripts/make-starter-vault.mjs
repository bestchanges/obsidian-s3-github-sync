#!/usr/bin/env node
/**
 * make-starter-vault: bundle a ready-to-sync "starter vault" zip for provisioning a new device.
 *
 * The zip holds an EMPTY Obsidian vault containing only the S3-sync plugin (main.js + manifest.json)
 * and a data.json that carries your S3 credentials on top of the plugin's DEFAULT settings — most
 * importantly the 10 MB download cap, so a new device starts lean. Per-device fields are cleared
 * (deviceId + machineFingerprint → the new device mints its own identity) and NO state.json.gz is
 * included, so the plugin does a clean full pull of the whole vault on first run.
 *
 * The setup instructions live at the zip root, OUTSIDE the vault folder, so they never sync up to S3.
 *
 * On the new device:
 *   1. unzip
 *   2. Obsidian → "Open folder as vault" → pick the `vault/` folder
 *   3. Settings → Community plugins → "Turn on community plugins"
 *   4. "S3 Vault Sync" is already enabled and starts pulling the whole vault
 *
 * Usage:
 *   node scripts/make-starter-vault.mjs --from <configured-vault> [--out starter-vault.zip]
 *   npm run make-starter -- --from /path/to/configured/vault
 *
 * WARNING: the output zip contains your AWS secret access key. Treat it like a credential —
 * transfer it over a trusted channel and delete it once the new device is set up.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "vault-s3-sync";
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors DEFAULT_SETTINGS in packages/obsidian-plugin/src/main.ts — the new device starts here,
// with only the connection fields copied over from the source vault.
const DEFAULT_SETTINGS = {
  bucket: "",
  region: "us-east-1",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
  deviceId: "", // minted on first load from the machine label + a random suffix
  machineFingerprint: "",
  pollIntervalSec: 15,
  excludedFolders: [],
  maxDownloadMB: 10, // small by default → the new device stays lean
  verbose: false,
  mobileConcurrency: 8,
  desktopConcurrency: 50,
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function die(msg) {
  console.error(`make-starter-vault: ${msg}`);
  process.exit(1);
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

function setupReadme() {
  return [
    "# S3 Vault Sync — set up this vault on a new device",
    "",
    "1. In Obsidian, choose \"Open folder as vault\" and pick the `vault/` folder next to this file.",
    "2. Settings → Community plugins → \"Turn on community plugins\" (confirm the trust prompt).",
    "3. \"S3 Vault Sync\" is already enabled — it starts pulling the whole vault from S3.",
    "",
    "Notes",
    "- This device starts with a 10 MB download cap: files larger than that stay in the cloud to",
    "  keep the local vault small. Change it under the plugin settings → \"Max download size (MB)\"",
    "  (0 = no limit, i.e. download everything).",
    "- A unique device id is generated automatically the first time the plugin loads.",
    "- This bundle carries your S3 access key. Delete it once the device is set up.",
    "",
  ].join("\n");
}

async function main() {
  const from = arg("--from");
  const out = path.resolve(arg("--out", path.join(process.cwd(), "starter-vault.zip")));
  if (!from) {
    die("--from <configured-vault> is required (a vault whose plugin already holds your S3 creds)");
  }
  const fromPluginDir = path.resolve(from, ".obsidian/plugins", PLUGIN_ID);

  // 1. build the plugin so main.js is current
  console.log("• building plugin…");
  execFileSync("npm", ["run", "build:plugin"], { cwd: repoDir, stdio: "inherit" });
  const mainJs = await fs.readFile(path.join(repoDir, "packages/obsidian-plugin/dist/main.js"));
  const manifest = await fs.readFile(
    path.join(repoDir, "packages/obsidian-plugin/manifest.json"),
    "utf8",
  );

  // 2. read the source creds and rebuild data.json from DEFAULTS + connection fields only
  let src;
  try {
    src = await readJson(path.join(fromPluginDir, "data.json"));
  } catch {
    die(`no configured data.json at ${fromPluginDir} — point --from at a vault where the plugin is set up`);
  }
  const s = src.settings ?? src; // tolerate the legacy embedded shape
  for (const req of ["bucket", "accessKeyId", "secretAccessKey"]) {
    if (!s[req]) die(`source data.json is missing "${req}" — is that vault actually configured?`);
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    bucket: s.bucket,
    region: s.region ?? DEFAULT_SETTINGS.region,
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    prefix: s.prefix ?? "",
  };
  const dataJson = JSON.stringify({ settings }, null, 2) + "\n";

  // 3. stage the zip contents in a temp dir: an empty `vault/` + a top-level README
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "starter-vault-"));
  const pluginDir = path.join(stage, "vault/.obsidian/plugins", PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "main.js"), mainJs);
  await fs.writeFile(path.join(pluginDir, "manifest.json"), manifest);
  await fs.writeFile(path.join(pluginDir, "data.json"), dataJson);
  // pre-enable the plugin so it loads the moment community plugins are turned on
  await fs.writeFile(
    path.join(stage, "vault/.obsidian/community-plugins.json"),
    JSON.stringify([PLUGIN_ID]) + "\n",
  );
  await fs.writeFile(path.join(stage, "README-SETUP.md"), setupReadme());

  // 4. zip it ("." includes dotfiles/dot-dirs, unlike a shell glob)
  await fs.rm(out, { force: true });
  execFileSync("zip", ["-r", "-q", out, "."], { cwd: stage });
  await fs.rm(stage, { recursive: true, force: true });

  const kb = Math.round((await fs.stat(out)).size / 1024);
  console.log(`\n✓ wrote ${out} (${kb} KB)`);
  console.log(`  vault/.obsidian/plugins/${PLUGIN_ID}/{main.js, manifest.json, data.json}`);
  console.log(`  vault/.obsidian/community-plugins.json  (plugin pre-enabled)`);
  console.log(`  README-SETUP.md                          (outside the vault — won't sync)`);
  console.log(
    `  settings: bucket=${settings.bucket} region=${settings.region} ` +
      `prefix=${settings.prefix || "(none)"} maxDownloadMB=${settings.maxDownloadMB}`,
  );
  console.log("  deviceId + state: cleared → fresh identity and full pull on first run");
  console.log("  ⚠ this zip contains your AWS secret access key — share it over a trusted channel only.");
}

main().catch((e) => die(e?.stack ?? String(e)));
