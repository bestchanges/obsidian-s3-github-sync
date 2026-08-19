import { describe, expect, it } from "vitest";
import { createRevPublisher, revTopic } from "../src/notify";
import { revTopic as pluginRevTopic } from "../../obsidian-plugin/src/notify";

describe("revTopic", () => {
  it("namespaces by vault prefix", () => {
    expect(revTopic("vaults3sync/")).toBe("vaultsync/vaults3sync/rev");
    expect(revTopic("egorka/vaults/gsd2/")).toBe("vaultsync/egorka-vaults-gsd2/rev");
    expect(revTopic("")).toBe("vaultsync/default/rev");
  });

  // The two implementations are duplicated across the legs by design (core stays pure — no AWS
  // SDK, no fetch — so neither leg can own it). That makes them exactly the kind of pair §6 says
  // must move in lockstep: if they ever disagree, one leg publishes where the other isn't
  // listening and push silently stops working, with polling masking it.
  it("agrees with the plugin's implementation for every prefix shape", () => {
    for (const prefix of [
      "",
      "/",
      "vaults3sync/",
      "egorka/vaults/gsd2/",
      "Mixed_Case-123/",
      "a/#/+",
      "...",
      "trailing---",
      "юникод/",
    ]) {
      expect(revTopic(prefix), `prefix ${JSON.stringify(prefix)}`).toBe(pluginRevTopic(prefix));
    }
  });

  it("never emits an MQTT wildcard or an empty level", () => {
    for (const prefix of ["a/#/+", "///", "+", "#"]) {
      const topic = revTopic(prefix);
      expect(topic).not.toMatch(/[#+]/);
      expect(topic.split("/").every((level) => level.length > 0)).toBe(true);
    }
  });
});

describe("createRevPublisher", () => {
  it("is a silent no-op when no endpoint is configured", async () => {
    const publisher = createRevPublisher({ prefix: "v/", by: "git-sync" });
    const logs: string[] = [];
    await expect(
      createRevPublisher({ prefix: "v/", by: "git-sync", log: (m) => logs.push(m) }).publish(5),
    ).resolves.toBeUndefined();
    await expect(publisher.publish(1)).resolves.toBeUndefined();
    expect(logs).toEqual([]); // "off" must be silent, not chatty
  });

  it("never rejects when publishing fails — an announcement can't fail the run", async () => {
    // Unroutable endpoint: the SDK call fails, and the publisher must still resolve.
    const logs: string[] = [];
    const publisher = createRevPublisher({
      endpoint: "127.0.0.1:1",
      region: "us-east-1",
      prefix: "v/",
      by: "git-sync",
      log: (m) => logs.push(m),
    });
    await expect(publisher.publish(42)).resolves.toBeUndefined();
    expect(logs.join()).toMatch(/announce rev 42 failed/);
  });
});
