import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  FeedVerificationError,
  keyIdOf,
  publicKeyBase64,
  signFeed,
} from "../src/feed/index.ts";
import { describe, expect, it } from "vitest";
import { type Download, loadRemoteFeed } from "../src/remote-feed.ts";

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyBase64(publicKey);
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    trusted: { [keyIdOf(pub)]: pub },
  };
};
const ours = keys();
const URL = "https://feed.test/v1/feed.json";

const feedBytes = (generatedAt: string, expiresAt: string): Uint8Array =>
  new TextEncoder().encode(
    canonicalJson({ schemaVersion: 1, generatedAt, expiresAt, vendors: [], events: [] }),
  );

const serving =
  (bytes: Uint8Array, pem = ours.pem, calls: string[] = []): Download =>
  async (url) => {
    calls.push(url);
    return url.endsWith(".sig")
      ? new TextEncoder().encode(JSON.stringify(signFeed(bytes, pem)))
      : bytes;
  };
const unreachable: Download = async () => {
  throw new FeedVerificationError("feed download failed with status 503");
};
const now = new Date("2026-10-01T00:00:00Z");
const fresh = feedBytes("2026-09-30T00:00:00Z", "2026-10-14T00:00:00Z");
const cacheDir = () => mkdtempSync(join(tmpdir(), "harbyn-cache-"));

describe("loadRemoteFeed (fail closed)", () => {
  it("refuses to run when no keys are pinned", async () => {
    await expect(
      loadRemoteFeed({ url: URL, trustedKeys: {}, cacheDir: cacheDir(), download: serving(fresh) }),
    ).rejects.toThrow(/no trusted feed keys/);
  });

  it("downloads, verifies, caches, and then works offline", async () => {
    const dir = cacheDir();
    const online = await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      download: serving(fresh),
    });
    expect(online.origin).toBe("network");
    expect(existsSync(join(dir, "feed.json.sig"))).toBe(true);
    const calls: string[] = [];
    const offline = await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      offline: true,
      download: serving(fresh, ours.pem, calls),
    });
    expect(offline.origin).toBe("cache");
    expect(calls).toEqual([]);
  });

  it("offline without a valid cache refuses instead of guessing", async () => {
    await expect(
      loadRemoteFeed({ trustedKeys: ours.trusted, cacheDir: cacheDir(), now, offline: true }),
    ).rejects.toThrow(/offline mode needs/);
  });

  it("rejects a feed signed by someone else and does not cache it", async () => {
    const dir = cacheDir();
    await expect(
      loadRemoteFeed({
        url: URL,
        trustedKeys: ours.trusted,
        cacheDir: dir,
        now,
        download: serving(fresh, keys().pem),
      }),
    ).rejects.toThrow(/untrusted key/);
    expect(existsSync(join(dir, "feed.json"))).toBe(false);
  });

  it("never falls back to the cache when the server sends a bad feed", async () => {
    const dir = cacheDir();
    await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      download: serving(fresh),
    });
    await expect(
      loadRemoteFeed({
        url: URL,
        trustedKeys: ours.trusted,
        cacheDir: dir,
        now,
        download: serving(fresh, keys().pem),
      }),
    ).rejects.toThrow(/untrusted key/);
  });

  it("rejects rollback to an older feed than the one already accepted", async () => {
    const dir = cacheDir();
    await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      download: serving(fresh),
    });
    const older = feedBytes("2026-09-20T00:00:00Z", "2026-10-04T00:00:00Z");
    await expect(
      loadRemoteFeed({
        url: URL,
        trustedKeys: ours.trusted,
        cacheDir: dir,
        now,
        download: serving(older),
      }),
    ).rejects.toThrow(/rollback/);
  });

  it("rejects expired feeds, from the network and from the cache", async () => {
    const expired = feedBytes("2026-09-01T00:00:00Z", "2026-09-15T00:00:00Z");
    await expect(
      loadRemoteFeed({
        url: URL,
        trustedKeys: ours.trusted,
        cacheDir: cacheDir(),
        now,
        download: serving(expired),
      }),
    ).rejects.toThrow(/expired/);
    const dir = cacheDir();
    await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      download: serving(fresh),
    });
    const later = new Date("2026-11-01T00:00:00Z");
    await expect(
      loadRemoteFeed({ trustedKeys: ours.trusted, cacheDir: dir, now: later, offline: true }),
    ).rejects.toThrow(/offline mode needs/);
  });

  it("ignores a tampered cache", async () => {
    const dir = cacheDir();
    await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      download: serving(fresh),
    });
    const tampered = readFileSync(join(dir, "feed.json"), "utf8").replace(
      '"events":[]',
      '"events":[ ]',
    );
    writeFileSync(join(dir, "feed.json"), tampered);
    await expect(
      loadRemoteFeed({ trustedKeys: ours.trusted, cacheDir: dir, now, offline: true }),
    ).rejects.toThrow(/offline mode needs/);
  });

  it("uses a still-valid cache, with a warning, when the network is down", async () => {
    const dir = cacheDir();
    await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      download: serving(fresh),
    });
    const result = await loadRemoteFeed({
      url: URL,
      trustedKeys: ours.trusted,
      cacheDir: dir,
      now,
      download: unreachable,
    });
    expect(result.origin).toBe("cache");
    expect(result.warning).toMatch(/using the cached copy/);
    await expect(
      loadRemoteFeed({
        url: URL,
        trustedKeys: ours.trusted,
        cacheDir: cacheDir(),
        now,
        download: unreachable,
      }),
    ).rejects.toThrow(/no valid cache/);
  });
});
