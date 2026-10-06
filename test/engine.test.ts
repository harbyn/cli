import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    auth: {
      kind: "ci",
      connection: "00000000-0000-4000-8000-000000000001",
      token: "header.payload.signature",
    },
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
    expect(readdirSync(t.options.dir)).toEqual([]);
  });

  it("keeps a verified engine for the next run, which sends only its hashes and gets no bytes back", async () => {
    const cacheDir = join(mkdtempSync(join(tmpdir(), "harbyn-cache-test-")), "harbyn-engine-cache");
    const first = setup({}, { cacheDir });
    const fresh = await loadEngine(first.options);
    expect(fresh).toMatchObject({
      ok: true,
      fresh: true,
      engineSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.parse(String(first.requests[0]?.init.body))).toEqual({
      connection: "00000000-0000-4000-8000-000000000001",
    });
    expect(readFileSync(join(cacheDir, "harbyn-engine.mjs"), "utf8")).toBe(engineSource());

    const second = setup({ body: JSON.stringify({ cached: true }) }, { cacheDir });
    const reused = await loadEngine(second.options);
    expect(reused).toMatchObject({ ok: true, fresh: false });
    const sent = JSON.parse(String(second.requests[0]?.init.body)) as {
      have?: { engine: string; knowledge: string };
    };
    expect(sent.have?.engine).toBe(fresh.ok ? fresh.engineSha256 : "");
    expect(sent.have?.knowledge).toMatch(/^[0-9a-f]{64}$/);
    expect(second.imported).toHaveLength(1);
  });

  it("abuse: a tampered cache never runs, and a failed download never reaches the cache", async () => {
    const cacheDir = join(mkdtempSync(join(tmpdir(), "harbyn-cache-test-")), "harbyn-engine-cache");
    await loadEngine(setup({}, { cacheDir }).options);
    writeFileSync(join(cacheDir, "harbyn-engine.mjs"), `${engineSource()} globalThis.pwned = 1;`);
    const poisoned = setup({ body: JSON.stringify({ cached: true }) }, { cacheDir });
    expect(await loadEngine(poisoned.options)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/could not be verified/),
    });
    expect(poisoned.imported).toHaveLength(0);
    const empty = setup(
      { body: JSON.stringify({ cached: true }) },
      { cacheDir: join(tmpdir(), "harbyn-no-cache-here") },
    );
    expect(await loadEngine(empty.options)).toEqual({
      ok: false,
      message: "the engine response is malformed",
    });
    const clean = join(mkdtempSync(join(tmpdir(), "harbyn-cache-test-")), "harbyn-engine-cache");
    const tampered = setup(
      {
        engine: enc(`${engineSource()} globalThis.pwned = 1;`),
        release: { engine: enc(engineSource()), knowledge: enc(knowledgeJson) },
      },
      { cacheDir: clean },
    );
    expect((await loadEngine(tampered.options)).ok).toBe(false);
    expect(existsSync(join(clean, "harbyn-engine.mjs"))).toBe(false);
    if (process.platform !== "win32") {
      const linked = join(mkdtempSync(join(tmpdir(), "harbyn-cache-test-")), "harbyn-engine-cache");
      await loadEngine(setup({}, { cacheDir: linked }).options);
      const outside = join(mkdtempSync(join(tmpdir(), "harbyn-outside-")), "victim.txt");
      writeFileSync(outside, "untouched");
      const engineFile = join(linked, "harbyn-engine.mjs");
      const { rmSync } = await import("node:fs");
      rmSync(engineFile);
      symlinkSync(outside, engineFile);
      const viaLink = setup({}, { cacheDir: linked });
      const loaded = await loadEngine(viaLink.options);
      expect(loaded).toMatchObject({ ok: true, fresh: true });
      expect(JSON.parse(String(viaLink.requests[0]?.init.body)).have).toBeUndefined();
      expect(readFileSync(outside, "utf8")).toBe("untouched");
    }
  });

  it("with a CLI sign-in, asks the CLI endpoint with that token and names no repository", async () => {
    const t = setup({}, { auth: { kind: "cli", token: `hbn_cli_${"a".repeat(43)}` } });
    const loaded = await loadEngine(t.options);
    expect(loaded.ok).toBe(true);
    expect(t.requests[0]?.url).toBe("https://api.harbyn.com/cli/engine");
    expect(new Headers(t.requests[0]?.init.headers).get("authorization")).toBe(
      `Bearer hbn_cli_${"a".repeat(43)}`,
    );
    expect(JSON.parse(String(t.requests[0]?.init.body))).toEqual({});
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
