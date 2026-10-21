import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEngineRelease,
  canonicalJson,
  keyIdOf,
  publicKeyBase64,
  signEngineRelease,
  signFeed,
  verifyEngineRelease,
} from "../src/feed/index.ts";
import { describe, expect, it } from "vitest";
import { ENGINE_KEYS, ENGINE_RECOVERY_KEY_ID } from "../src/engine.ts";
import {
  type Download,
  FEED_RECOVERY_KEY_ID,
  loadRemoteFeed,
  PRODUCTION_KEYS,
} from "../src/remote-feed.ts";

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyBase64(publicKey);
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    id: keyIdOf(pub),
    pub,
  };
};
const ci = pair();
const recovery = pair();
const stranger = pair();
const pinned = { [ci.id]: ci.pub, [recovery.id]: recovery.pub };

const now = new Date("2026-10-21T12:00:00Z");
const feed = new TextEncoder().encode(
  canonicalJson({
    schemaVersion: 1,
    generatedAt: "2026-10-21T00:00:00Z",
    expiresAt: "2026-10-25T00:00:00Z",
    vendors: [],
    events: [],
  }),
);
const serving =
  (pem: string): Download =>
  async (url) =>
    url.endsWith(".sig") ? new TextEncoder().encode(JSON.stringify(signFeed(feed, pem))) : feed;
const load = (pem: string) =>
  loadRemoteFeed({
    url: "https://feed.test/v1/feed.json",
    trustedKeys: pinned,
    cacheDir: mkdtempSync(join(tmpdir(), "rk-")),
    now,
    download: serving(pem),
  });

describe("recovery keys", () => {
  it("the shipped pins hold the CI key and the offline recovery key, each matching its own id", () => {
    for (const [keys, recoveryId] of [
      [PRODUCTION_KEYS, FEED_RECOVERY_KEY_ID],
      [ENGINE_KEYS, ENGINE_RECOVERY_KEY_ID],
    ] as const) {
      expect(Object.keys(keys)).toHaveLength(2);
      expect(Object.keys(keys)).toContain(recoveryId);
      for (const [id, spki] of Object.entries(keys)) expect(keyIdOf(spki)).toBe(id);
    }
    expect(FEED_RECOVERY_KEY_ID).toBe("d46fdcaf720b8e0b");
    expect(ENGINE_RECOVERY_KEY_ID).toBe("1798d44c4fa9b587");
    expect(Object.keys(PRODUCTION_KEYS)).not.toContain(ENGINE_RECOVERY_KEY_ID);
  });

  it("a feed signed by the CI key or by the recovery key verifies", async () => {
    expect((await load(ci.pem)).feed.generatedAt).toBe("2026-10-21T00:00:00Z");
    expect((await load(recovery.pem)).feed.generatedAt).toBe("2026-10-21T00:00:00Z");
  });

  it("abuse: a feed signed by any other key is refused", async () => {
    await expect(load(stranger.pem)).rejects.toThrow(/untrusted key/);
  });

  it("an engine release signed by the CI key or the recovery key verifies; any other key is refused", () => {
    const enc = new TextEncoder();
    const release = buildEngineRelease({
      commit: "c".repeat(40),
      engine: enc.encode("engine"),
      knowledge: enc.encode("{}"),
      now,
    });
    for (const signer of [ci, recovery]) {
      expect(
        verifyEngineRelease(release, signEngineRelease(release, signer.pem), pinned, { now })
          .commit,
      ).toBe("c".repeat(40));
    }
    expect(() =>
      verifyEngineRelease(release, signEngineRelease(release, stranger.pem), pinned, { now }),
    ).toThrow(/untrusted key/);
  });
});
