import { strToU8, zipSync } from "fflate";

/**
 * Packages a "starter vault" zip in-memory (works on desktop AND mobile — no filesystem/CLI needed)
 * and hands it to the OS: the native share sheet on mobile, a browser download on desktop.
 *
 * The zip is an empty Obsidian vault holding only this plugin + a preconfigured data.json, so the
 * new device turns on community plugins and immediately syncs the whole vault. Setup instructions
 * live at the zip root, OUTSIDE `vault/`, so they never sync up to S3.
 */

export interface StarterInput {
  pluginId: string;
  mainJs: Uint8Array;
  manifestJson: string;
  /** already-serialized { settings } — defaults + connection fields, identity/state cleared */
  dataJson: string;
}

const README = [
  "# S3 Vault Sync — set up this vault on a new device",
  "",
  "1. In Obsidian, choose \"Open folder as vault\" and pick the `vault/` folder next to this file.",
  "2. Settings → Community plugins → \"Turn on community plugins\" (accept the trust prompt).",
  "3. \"S3 Vault Sync\" is already enabled — it starts pulling the whole vault from S3.",
  "",
  "Notes",
  "- This device starts with a 10 MB download cap: bigger files stay in the cloud to keep the local",
  "  vault small. Change it under the plugin settings → \"Max download size (MB)\" (0 = no limit).",
  "- A unique device id is generated automatically the first time the plugin loads.",
  "- This bundle carries your S3 access key. Delete it once the device is set up.",
  "",
].join("\n");

/** Build the starter-vault zip bytes. */
export function buildStarterZip(input: StarterInput): Uint8Array {
  const pluginDir = `vault/.obsidian/plugins/${input.pluginId}`;
  return zipSync(
    {
      "README-SETUP.md": strToU8(README),
      // pre-enable the plugin so it loads the moment community plugins are turned on
      "vault/.obsidian/community-plugins.json": strToU8(JSON.stringify([input.pluginId]) + "\n"),
      [`${pluginDir}/main.js`]: input.mainJs,
      [`${pluginDir}/manifest.json`]: strToU8(input.manifestJson),
      [`${pluginDir}/data.json`]: strToU8(input.dataJson),
    },
    { level: 6 },
  );
}

export type DeliveryResult = "shared" | "downloaded" | "cancelled";

/** Hand bytes to the OS: share sheet where available (mobile), else a browser download (desktop). */
export async function deliverFile(bytes: Uint8Array, filename: string): Promise<DeliveryResult> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([ab], { type: "application/zip" });
  const nav = navigator as Navigator & {
    canShare?: (data?: unknown) => boolean;
    share?: (data?: unknown) => Promise<void>;
  };
  const file = new File([blob], filename, { type: "application/zip" });

  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: "S3 Vault Sync — new device setup" });
      return "shared";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return "cancelled";
      // otherwise fall through to the download path (e.g. share unsupported for this payload)
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return "downloaded";
}
