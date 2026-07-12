#!/usr/bin/env node
/**
 * make-starter-vault: bundle a ready-to-sync vault zip for a device.
 *
 * The zip contains ONLY the vault: a single top folder (named with --name) holding just the S3-sync
 * plugin (main.js + manifest.json) and a data.json that carries S3 connection fields on top of the
 * plugin's DEFAULT settings — most importantly the 10 MB download cap, so a device starts lean.
 * Per-device fields are cleared (deviceId + machineFingerprint → the device mints its own identity)
 * and NO state.json.gz is included, so the plugin does a clean full pull on first run.
 *
 * "Extract here" on the target device yields a ready-to-open vault folder. No instructions ride
 * inside the zip — those are delivered out of band.
 *
 * Credentials come from a file or the environment — never argv — so the secret key can't leak into
 * process listings. This is the CLI companion to the in-plugin "Export setup vault" button.
 *
 * Usage:
 *   node scripts/make-starter-vault.mjs --name <vault> \
 *     --bucket <b> --region <r> --prefix <user/vaults/name/> \
 *     --creds-file <json {accessKeyId,secretAccessKey}> [--out <file.zip>] [--no-build]
 *
 * Env alternative to --creds-file: VAULT_ACCESS_KEY_ID, VAULT_SECRET_ACCESS_KEY.
 *
 * WARNING: the output zip contains the AWS secret access key. Treat it like a credential —
 * transfer it over a trusted channel and delete it once the device is set up.
 */
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "vault-s3-sync";
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors DEFAULT_SETTINGS in packages/obsidian-plugin/src/main.ts.
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
  maxDownloadMB: 10, // small by default → the device stays lean
  verbose: false,
  mobileConcurrency: 8,
  desktopConcurrency: 50,
};

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(name) {
  return process.argv.includes(name);
}
function die(msg) {
  console.error(`make-starter-vault: ${msg}`);
  process.exit(1);
}

/** Keep the vault name usable as a directory segment (no separators / control chars). */
function safeVaultName(name) {
  const cleaned = String(name).replace(/[\\/\x00-\x1f]+/g, " ").trim();
  return cleaned || "vault";
}

async function loadCreds() {
  const credsFile = flag("--creds-file");
  if (credsFile) {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(credsFile, "utf8"));
    } catch {
      die(`cannot read creds file: ${credsFile}`);
    }
    // accept both our normalized shape and the raw `aws iam create-access-key` output
    const k = raw.AccessKey ?? raw;
    const accessKeyId = k.accessKeyId ?? k.AccessKeyId;
    const secretAccessKey = k.secretAccessKey ?? k.SecretAccessKey;
    if (!accessKeyId || !secretAccessKey) die(`creds file missing accessKeyId/secretAccessKey: ${credsFile}`);
    return { accessKeyId, secretAccessKey };
  }
  const accessKeyId = process.env.VAULT_ACCESS_KEY_ID;
  const secretAccessKey = process.env.VAULT_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    die("provide --creds-file, or VAULT_ACCESS_KEY_ID + VAULT_SECRET_ACCESS_KEY in the environment");
  }
  return { accessKeyId, secretAccessKey };
}

async function main() {
  const bucket = flag("--bucket");
  const region = flag("--region", DEFAULT_SETTINGS.region);
  const prefix = flag("--prefix", "");
  const vaultName = safeVaultName(flag("--name", "vault"));
  const out = path.resolve(flag("--out", path.join(process.cwd(), `${vaultName}.zip`)));
  if (!bucket) die("--bucket is required");
  const { accessKeyId, secretAccessKey } = await loadCreds();

  // 1. build the plugin so main.js is current (skippable if dist already present)
  const dist = path.join(repoDir, "packages/obsidian-plugin/dist/main.js");
  if (!has("--no-build") || !existsSync(dist)) {
    console.log("• building plugin…");
    execFileSync("npm", ["run", "build:plugin"], { cwd: repoDir, stdio: "inherit" });
  }
  const mainJs = await fs.readFile(dist);
  const manifestJson = await fs.readFile(
    path.join(repoDir, "packages/obsidian-plugin/manifest.json"),
    "utf8",
  );

  // 2. data.json = DEFAULTS + connection fields (identity + state cleared)
  const settings = { ...DEFAULT_SETTINGS, bucket, region, accessKeyId, secretAccessKey, prefix };
  const dataJson = JSON.stringify({ settings }, null, 2) + "\n";

  // 3. stage the vault ONLY — a single top folder named after the vault, no instructions inside
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "vault-zip-"));
  const obsidianDir = path.join(stage, vaultName, ".obsidian");
  const pluginDir = path.join(obsidianDir, "plugins", PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "main.js"), mainJs);
  await fs.writeFile(path.join(pluginDir, "manifest.json"), manifestJson);
  await fs.writeFile(path.join(pluginDir, "data.json"), dataJson);
  await fs.writeFile(path.join(obsidianDir, "community-plugins.json"), JSON.stringify([PLUGIN_ID]) + "\n");

  // 4. zip ("." includes dotfiles/dot-dirs, unlike a shell glob)
  await fs.rm(out, { force: true });
  execFileSync("zip", ["-r", "-q", out, "."], { cwd: stage });
  await fs.rm(stage, { recursive: true, force: true });

  const kb = Math.round((await fs.stat(out)).size / 1024);
  console.log(`\n✓ wrote ${out} (${kb} KB) — extracts to ${vaultName}/`);
  console.log(`  bucket=${bucket} region=${region} prefix=${prefix || "(none)"} maxDownloadMB=${settings.maxDownloadMB}`);
  console.log(`  accessKeyId=${accessKeyId.slice(0, 4)}… (secret embedded, ${secretAccessKey.length} chars)`);
  console.log("  deviceId + state: cleared → fresh identity and full pull on first run");
  console.log("  ⚠ this zip contains the AWS secret access key — share it over a trusted channel only.");
}

main().catch((e) => die(e?.stack ?? String(e)));
