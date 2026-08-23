import { strToU8, zipSync } from "fflate";

/**
 * Packages a starter-vault zip in-memory (works on desktop AND mobile — no filesystem/CLI needed)
 * and hands it to the OS: the native share sheet on mobile, a browser download on desktop.
 *
 * The zip contains ONLY the vault — a single top folder named after the vault, holding just this
 * plugin + a preconfigured data.json. "Extract here" on the target device yields a ready-to-open
 * vault. No instructions ride inside (those are delivered out of band), so nothing stray syncs up.
 */

export interface StarterInput {
  /** vault folder name — the zip's single top-level directory (matches the source vault) */
  vaultName: string;
  pluginId: string;
  mainJs: Uint8Array;
  manifestJson: string;
  /** Plugin stylesheet, when this install has one — omitted for builds that predate it (§4.10). */
  stylesCss?: string;
  /** already-serialized { settings } — defaults + connection fields, identity/state cleared */
  dataJson: string;
}

/** Keep the vault name usable as a zip path segment (no separators / control chars). */
export function safeVaultName(name: string): string {
  const cleaned = name.replace(/[\\/\x00-\x1f]+/g, " ").trim();
  return cleaned || "vault";
}

/** Build the starter-vault zip bytes. Extracts to `<vaultName>/` — the vault itself, nothing else. */
export function buildStarterZip(input: StarterInput): Uint8Array {
  const root = safeVaultName(input.vaultName);
  const pluginDir = `${root}/.obsidian/plugins/${input.pluginId}`;
  return zipSync(
    {
      // pre-enable the plugin so it loads the moment community plugins are turned on
      [`${root}/.obsidian/community-plugins.json`]: strToU8(JSON.stringify([input.pluginId]) + "\n"),
      [`${pluginDir}/main.js`]: input.mainJs,
      [`${pluginDir}/manifest.json`]: strToU8(input.manifestJson),
      // Ships with main.js or the new device's version-history modal renders unstyled.
      ...(input.stylesCss ? { [`${pluginDir}/styles.css`]: strToU8(input.stylesCss) } : {}),
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
