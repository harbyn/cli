import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEngineRelease,
  keyIdOf,
  publicKeyBase64,
  signEngineRelease,
  signFeed,
} from "../src/feed/index.ts";
import { describe, expect, it } from "vitest";
import {
  ENGINE_RELEASE_URL,
  ENGINE_URL,
  type LoadEngineOptions,
  loadEngine,
} from "../src/engine.ts";
import type { Download } from "../src/remote-feed.ts";

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyBase64(publicKey);
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    trusted: { [keyIdOf(pub)]: pub },
  };
};
const ours = keys();
const now = new Date("2026-10-04T12:00:00Z");
const enc = (text: string) => new TextEncoder().encode(text);

const engineSource = (abi = 1) =>
  `export const ENGINE_ABI = ${abi}; export const runAction = async () => {}; export const runMigrate = async () => 0;`;
const knowledgeJson = JSON.stringify({ schemaVersion: 1, migrations: [] });

interface Served {
  engine?: Uint8Array;
  knowledge?: Uint8Array;
  status?: number;
  body?: string;
  release?: {
    engine: Uint8Array;
    knowledge: Uint8Array;
    at?: Date;
    pem?: string;
    feedSignature?: boolean;
  };
}

const setup = (served: Served = {}, over: Partial<LoadEngineOptions> = {}) => {
  const engine = served.engine ?? enc(engineSource());
  const knowledge = served.knowledge ?? enc(knowledgeJson);
  const rel = served.release ?? { engine, knowledge };
  const releaseBytes = buildEngineRelease({
    commit: "c".repeat(40),
    engine: rel.engine,
    knowledge: rel.knowledge,
    now: rel.at ?? now,
  });
  const envelope = rel.feedSignature
    ? signFeed(releaseBytes, rel.pem ?? ours.pem)
    : signEngineRelease(releaseBytes, rel.pem ?? ours.pem);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const imported: string[] = [];
  const download: Download = async (url) => {
    if (url === ENGINE_RELEASE_URL) return releaseBytes;
    if (url === `${ENGINE_RELEASE_URL}.sig`) return enc(JSON.stringify(envelope));
    throw new Error(`unexpected download ${url}`);
  };
  const options: LoadEngineOptions = {
    connection: "00000000-0000-4000-8000-000000000001",
    token: "header.payload.signature",
    dir: mkdtempSync(join(tmpdir(), "harbyn-engine-test-")),
    trustedKeys: ours.trusted,
    now,
    download,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const body =
        served.body ??
        JSON.stringify({
          engine: Buffer.from(engine).toString("base64"),
          knowledge: Buffer.from(knowledge).toString("base64"),
        });
      return new Response(body, {
        status: served.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    ...over,
  };
  const withImporter = (importer?: (url: string) => Promise<unknown>): LoadEngineOptions => ({
    ...options,
    importer: async (url) => {
      imported.push(url);
      return importer ? importer(url) : import(url);
    },
  });
  return { options: withImporter(), withImporter, requests, imported };
};

describe("paid engine loader", () => {
  it("runs only an engine whose bytes a signed release names, and sends nothing but the connection", async () => {
    const t = setup();
    const loaded = await loadEngine(t.options);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.engine.ENGINE_ABI).toBe(1);
    expect(await loaded.engine.runMigrate([], () => [], loaded.knowledge)).toBe(0);
    expect(loaded.knowledge.migrations).toEqual([]);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.url).toBe(ENGINE_URL);
    expect(t.requests[0]?.init.redirect).toBe("error");
    expect(JSON.parse(String(t.requests[0]?.init.body))).toEqual({
      connection: "00000000-0000-4000-8000-000000000001",
    });
    expect(t.imported).toHaveLength(1);
  });

  it("does nothing while no engine key is pinned", async () => {
    const t = setup({}, { trustedKeys: {} });
    expect(await loadEngine(t.options)).toEqual({
      ok: false,
      message: "automatic fixes are not available in this release of the Action yet",
    });
    expect(t.requests).toHaveLength(0);
  });

  it("abuse: a tampered engine or knowledge is never imported", async () => {
    for (const served of [
      {
        engine: enc(`${engineSource()} globalThis.pwned = 1;`),
        release: { engine: enc(engineSource()), knowledge: enc(knowledgeJson) },
      },
      {
        knowledge: enc(JSON.stringify({ schemaVersion: 1, migrations: [{ eventId: "x" }] })),
        release: { engine: enc(engineSource()), knowledge: enc(knowledgeJson) },
      },
    ]) {
      const t = setup(served);
      const loaded = await loadEngine(t.options);
      expect(loaded).toMatchObject({
        ok: false,
        message: expect.stringMatching(
          /could not be verified .*not the one the signed release names/,
        ),
      });
      expect(t.imported).toHaveLength(0);
    }
  });

  it("abuse: an untrusted key, a feed signature, or an expired release is refused", async () => {
    for (const release of [
      { pem: keys().pem },
      { feedSignature: true },
      { at: new Date("2026-09-01T00:00:00Z") },
    ]) {
      const t = setup({
        release: { engine: enc(engineSource()), knowledge: enc(knowledgeJson), ...release },
      });
      const loaded = await loadEngine(t.options);
      expect(loaded).toMatchObject({
        ok: false,
        message: expect.stringMatching(/could not be verified/),
      });
      expect(t.imported).toHaveLength(0);
    }
  });

  it("shows the API's refusal as one short printable line", async () => {
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x202e);
    const t = setup({
      status: 402,
      body: JSON.stringify({
        error: `Automatic fixes are part of Harbyn Pro and Team.${esc}[2J${rlo}\n::error::x${"y".repeat(500)}`,
      }),
    });
    const loaded = await loadEngine(t.options);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.message.startsWith("Automatic fixes are part of Harbyn Pro and Team.")).toBe(
      true,
    );
    expect(
      [...loaded.message].every(
        (ch) => (ch.codePointAt(0) ?? 0) >= 0x20 && (ch.codePointAt(0) ?? 0) <= 0x7e,
      ),
    ).toBe(true);
    expect(loaded.message.length).toBeLessThanOrEqual(300);
  });

  it("refuses an engine built for another loader version, and a malformed or oversized response", async () => {
    const abi = setup({ engine: enc(engineSource(2)) });
    expect(await loadEngine(abi.options)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/does not match this Action/),
    });
    const malformed = setup({ body: "{}" });
    expect(await loadEngine(malformed.options)).toEqual({
      ok: false,
      message: "the engine response is malformed",
    });
    const huge = setup(
      {},
      {
        fetch: async () =>
          new Response("x", { headers: { "content-length": String(64 * 1024 * 1024) } }),
      },
    );
    expect(await loadEngine(huge.options)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/size limit/),
    });
  });
});
