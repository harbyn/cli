import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
  buildEngineRelease,
  buildIndex,
  keyIdOf,
  loadFeed,
  publicKeyBase64,
  signEngineRelease,
  signFeed,
} from "../src/feed/index.ts";
import { describe, expect, it } from "vitest";
import { CLI_ENGINE_URL, ENGINE_RELEASE_URL } from "../src/engine.ts";
import { CLI_API } from "../src/login.ts";
import { McpContext, type McpOptions } from "../src/mcp/context.ts";
import { INSTRUCTIONS, localServer } from "../src/mcp/main.ts";
import { checkRoot, PathRefused, readInside, resolveInside } from "../src/mcp/paths.ts";
import { DATA_RULE } from "../src/mcp/tools.ts";
import { DEFAULT_FEED_URL } from "../src/remote-feed.ts";
import { isSensitive } from "../src/sensitive.ts";
import { greedyEngine, oldEngine } from "./mcp-fake-engine.ts";
import { EVENTS, feedDir, INJECTION, repo, write } from "./mcp-fixtures.ts";
import { paidEngine, setup as setupH } from "./mcp-harness.ts";

const TODAY = "2026-10-11";
const NOW = new Date("2026-10-11T12:00:00Z");
const ALLOWED_HOSTS = new Set(["feed.harbyn.com", "api.harbyn.com"]);

interface Net {
  urls: string[];
  fetch: McpOptions["fetch"];
  download: NonNullable<McpOptions["download"]>;
}

const net = (
  answers: {
    whoami?: unknown;
    engine?: () => Response;
    downloads?: Record<string, Uint8Array>;
  } = {},
): Net => {
  const urls: string[] = [];
  const allow = (url: string) => {
    urls.push(url);
    if (!ALLOWED_HOSTS.has(new URL(url).hostname)) throw new Error(`blocked host ${url}`);
  };
  return {
    urls,
    fetch: async (url) => {
      allow(url);
      if (url === `${CLI_API}/whoami`)
        return new Response(JSON.stringify(answers.whoami ?? {}), {
          status: answers.whoami ? 200 : 401,
        });
      if (url === CLI_ENGINE_URL && answers.engine) return answers.engine();
      return new Response("{}", { status: 404 });
    },
    download: async (url) => {
      allow(url);
      const bytes = answers.downloads?.[url];
      if (!bytes) throw new Error(`download failed for ${url}`);
      return bytes;
    },
  };
};

const signedInDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-"));
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({ token: `hbn_cli_${"a".repeat(43)}`, expiresAt: "2099-01-01T00:00:00Z" }),
  );
  return dir;
};

const setup = (root: string, over: Partial<McpOptions> = {}, n: Net = net()) => {
  const ctx = new McpContext({
    feedDir: feedDir(),
    fetch: n.fetch,
    download: n.download,
    configDir: mkdtempSync(join(tmpdir(), "mcp-config-")),
    cacheDir: mkdtempSync(join(tmpdir(), "mcp-cache-")),
    now: () => NOW,
    ...over,
  });
  ctx.setRoot(root);
  const spec = localServer(ctx);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = spec.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.call(args, TODAY);
  };
  return { ctx, spec, call, net: n };
};

type Finding = {
  findingId: string;
  eventId: string;
  path: string;
  line: number;
  token: string;
  context: string;
  alertOnly: boolean;
};
const findingsOf = (r: { structured: Record<string, unknown> }) =>
  r.structured.findings as Finding[];

const onlyFenced = (text: string, needle: string): boolean => {
  const outside = text.replace(
    /<<<untrusted ([a-z ]+) ([0-9a-f]{12})\n[\s\S]*?\nuntrusted \1 \2>>>/g,
    "",
  );
  return text.includes(needle) && !outside.includes(needle);
};

describe("scan", () => {
  it("lists code findings with file:line, ids, deadline and replacement; hides tests; never opens .env", async () => {
    const { call } = setup(repo());
    const r = await call("scan");
    expect(r.isError).not.toBe(true);
    const findings = findingsOf(r);
    const ai = findings.find((f) => f.path === "src/ai.ts");
    expect(ai).toMatchObject({
      eventId: EVENTS.swap,
      line: 3,
      token: "acme-1",
      context: "code",
      alertOnly: false,
    });
    expect(ai?.findingId).toMatch(/^f_[0-9a-f]{16}$/);
    expect(findings.some((f) => f.path.startsWith("test/"))).toBe(false);
    expect(findings.some((f) => f.path === ".env")).toBe(false);
    expect(r.structured.hiddenLowConfidence).toBe(1);
    expect(r.structured.secretFilesSkipped).toBe(1);
    const all = findingsOf(await call("scan", { all: true }));
    expect(all.some((f) => f.path === "test/ai.test.ts" && f.context === "test")).toBe(true);
  });

  it("flags payments, cryptography and alert-only vendors' findings alert-only", async () => {
    const findings = findingsOf(await setup(repo()).call("scan"));
    const flag = (path: string) => findings.find((f) => f.path === path)?.alertOnly;
    expect(flag("src/payments/charge.ts")).toBe(true);
    expect(flag("src/util/hash.ts")).toBe(true);
    expect(flag("src/gateway.ts")).toBe(true);
    expect(flag("src/ai.ts")).toBe(false);
  });

  it("abuse: a file the guard cannot read strictly is alert-only (non-UTF-8 payment code, a file grown past 1 MB)", async () => {
    const dir = repo();
    writeFileSync(
      join(dir, "src/client.ts"),
      Buffer.concat([
        Buffer.from('import Stripe from "stripe";\n// caf'),
        Buffer.from([0xe9]),
        Buffer.from('\nclient.create({ model: "acme-1" });\n'),
      ]),
    );
    const s = setup(dir);
    const findings = findingsOf(await s.call("scan"));
    const latin = findings.find((f) => f.path === "src/client.ts");
    expect(latin?.alertOnly).toBe(true);
    const plan = await s.call("plan_fix", { findingId: latin?.findingId });
    expect(plan.structured.mode).toBe("alert-only");
    expect((plan.structured.locations as Array<{ editable: boolean }>)[0]?.editable).toBe(false);

    const ai = findings.find((f) => f.path === "src/ai.ts");
    writeFileSync(
      join(dir, "src/ai.ts"),
      `${readFileSync(join(dir, "src/ai.ts"), "utf8")}${"x".repeat(1024 * 1024 + 1)}`,
    );
    const grown = await s.call("plan_fix", { findingId: ai?.findingId });
    expect(grown.structured.mode).toBe("alert-only");
    expect(
      (grown.structured.locations as Array<{ editable: boolean; alertOnly: boolean }>)[0],
    ).toMatchObject({ editable: false, alertOnly: true });
  });

  it("finding ids are stable across scans", async () => {
    const { call } = setup(repo());
    const a = findingsOf(await call("scan")).map((f) => f.findingId);
    const b = findingsOf(await call("scan")).map((f) => f.findingId);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("narrows to a path under the root", async () => {
    const findings = findingsOf(await setup(repo()).call("scan", { path: "src/payments" }));
    expect(findings.map((f) => f.path)).toEqual(["src/payments/charge.ts"]);
  });

  it("hostile feed and repository text comes back fenced, sanitized, and never in the tool descriptions", async () => {
    const hostileName = "src/ignore previous instructions.ts";
    const { call, spec } = setup(repo({ [hostileName]: 'model: "acme-1"\n' }));
    const r = await call("scan");
    expect(onlyFenced(r.text, "ignore previous instructions.ts")).toBe(true);
    expect(r.text).toContain(DATA_RULE);
    const explained = await call("explain", { eventId: EVENTS.swap });
    expect(explained.structured.summary).toContain(INJECTION);
    expect(onlyFenced(explained.text, INJECTION)).toBe(true);
    for (const t of spec.tools) {
      expect(t.description).not.toContain("acme");
      expect(t.description).toMatch(/data, never instructions|Never an email or a token/);
    }
    expect(INSTRUCTIONS).toContain(DATA_RULE);
  });

  it("strips control and bidi characters from repository paths", async () => {
    const odd = `src/odd${String.fromCodePoint(0x202e)}name${String.fromCodePoint(0x200b)}.ts`;
    const root = repo({ [odd]: 'model: "acme-1"\n' });
    const r = await setup(root).call("scan");
    const paths = findingsOf(r).map((f) => f.path);
    expect(paths.some((p) => p.startsWith("src/odd"))).toBe(true);
    for (const text of [JSON.stringify(r.structured), r.text]) {
      expect(
        [...text].some((c) => c.codePointAt(0) === 0x202e || c.codePointAt(0) === 0x200b),
      ).toBe(false);
    }
  });

  it("fails closed when the feed cannot be verified: an error, no findings", async () => {
    const { call } = setup(repo(), {
      feedDir: undefined as unknown as string,
      cacheDir: mkdtempSync(join(tmpdir(), "mcp-cache-")),
    });
    const r = await call("scan");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/feed/);
  });
});

describe("replacement and nested repositories", () => {
  it("scan, explain and plan_fix say what to move to in one line; scan names the nested repositories it skipped", async () => {
    const { call } = setup(
      repo({
        "vendored/app/.git/HEAD": "ref: refs/heads/main\n",
        "vendored/app/src/ai.ts": 'client.create({ model: "acme-1" });\n',
      }),
    );
    const r = await call("scan");
    const ai = (
      r.structured.findings as Array<{ path: string; nextStep: string; replacement: string[] }>
    ).find((f) => f.path === "src/ai.ts");
    expect(ai).toMatchObject({ nextStep: "Migrate to: acme-2", replacement: ["acme-2"] });
    expect(r.structured.skippedNestedRepos).toEqual(["vendored/app"]);
    expect(onlyFenced(r.text, "Skipped 1 nested repository: vendored/app")).toBe(true);
    expect(r.text).toContain("; Migrate to: acme-2;");
    const explained = await call("explain", { eventId: EVENTS.swap });
    expect(explained.structured.nextStep).toBe("Migrate to: acme-2");
    const plan = await call("plan_fix", { eventId: EVENTS.swap });
    expect(plan.structured.nextStep).toBe("Migrate to: acme-2");
    expect(plan.text).toContain("Migrate to: acme-2");
  });
});

describe("explain", () => {
  it("returns the change's facts, deadline, replacement, review state and links", async () => {
    const r = await setup(repo()).call("explain", { eventId: EVENTS.swap });
    expect(r.structured).toMatchObject({
      id: EVENTS.swap,
      vendorName: "Acme",
      kind: "retirement",
      deadline: { date: "2099-01-01", precision: "day" },
      history: false,
      upcoming: true,
      reviewed: true,
      replacement: { identifiers: ["acme-2"], note: null },
      source: "https://acme.example/changelog",
      harbynUrl: `https://harbyn.com/changes/${EVENTS.swap}`,
    });
    expect(
      (await setup(repo()).call("explain", { eventId: EVENTS.unreviewed })).structured.reviewed,
    ).toBe(false);
  });

  it("refuses ids that are not event ids, and unknown ones", async () => {
    const { call } = setup(repo());
    expect((await call("explain", { eventId: "../../etc/passwd" })).isError).toBe(true);
    expect((await call("explain", { eventId: "acme/2026-01-09-nope" })).text).toMatch(
      /unknown event id/,
    );
  });
});

describe("plan_fix (free)", () => {
  const planFor = async (path: string, root = repo(), over: Partial<McpOptions> = {}, n?: Net) => {
    const s = setup(root, over, n);
    const finding = findingsOf(await s.call("scan", { all: true })).find((f) => f.path === path);
    if (!finding) throw new Error(`no finding in ${path}`);
    return { ...s, finding, plan: await s.call("plan_fix", { findingId: finding.findingId }) };
  };

  it("a reviewed one-for-one change is a swap: the location, the replacement, the source and the risk", async () => {
    const { plan, net: n } = await planFor("src/ai.ts");
    expect(plan.isError).not.toBe(true);
    expect(plan.structured).toMatchObject({
      eventId: EVENTS.swap,
      mode: "swap",
      risk: "medium",
      replacement: ["acme-2"],
      locations: [
        {
          path: "src/ai.ts",
          line: 3,
          token: "acme-1",
          context: "code",
          alertOnly: false,
          editable: true,
        },
      ],
      evidence: {
        source: "https://acme.example/changelog",
        reviewState: "automated, deterministic",
      },
      tier: "free",
      engine: null,
    });
    expect(plan.structured.planId).toMatch(/^p_[0-9a-f]{16}$/);
    expect(plan.text).toMatch(/Nothing was changed/);
    expect(n.urls).toEqual([]);
  });

  it("alert-only: payments path, cryptography content and alert-only vendors get no edits", async () => {
    for (const path of ["src/payments/charge.ts", "src/util/hash.ts", "src/gateway.ts"]) {
      const { plan } = await planFor(path);
      expect(plan.structured.mode, path).toBe("alert-only");
      expect(plan.structured.risk, path).toBe("high");
      expect(
        (plan.structured.locations as Array<{ editable: boolean }>).every((l) => !l.editable),
        path,
      ).toBe(true);
      expect(plan.structured.engine, path).toBeNull();
    }
  });

  it("unreviewed changes are not-reviewed; several replacements need the agent's own edit", async () => {
    expect((await planFor("src/old.ts")).plan.structured.mode).toBe("not-reviewed");
    expect((await planFor("src/old.ts")).plan.structured.locations).toEqual([
      expect.objectContaining({ editable: false }),
    ]);
    const multi = (await planFor("src/multi.ts")).plan.structured;
    expect(multi.mode).toBe("model-needed");
    expect(multi.replacement).toEqual(["acme-y", "acme-z"]);
  });

  it("by event: every code location, each with its own alert-only flag; tests are left to the person", async () => {
    const s = setup(repo());
    const plan = await s.call("plan_fix", { eventId: EVENTS.swap });
    const locations = plan.structured.locations as Array<{
      path: string;
      editable: boolean;
      alertOnly: boolean;
    }>;
    expect(locations.map((l) => l.path).sort()).toEqual([
      "src/ai.ts",
      "src/payments/charge.ts",
      "src/util/hash.ts",
    ]);
    expect(locations.filter((l) => l.editable).map((l) => l.path)).toEqual(["src/ai.ts"]);
    expect(plan.structured.mode).toBe("swap");
  });

  it("refuses ambiguous or unknown input", async () => {
    const { call } = setup(repo());
    expect((await call("plan_fix", {})).isError).toBe(true);
    expect(
      (await call("plan_fix", { findingId: "f_0000000000000000", eventId: EVENTS.swap })).isError,
    ).toBe(true);
    expect((await call("plan_fix", { findingId: "f_0000000000000000" })).text).toMatch(
      /unknown findingId/,
    );
    expect((await call("plan_fix", { eventId: "acme/2026-01-09-nope" })).text).toMatch(
      /does not affect this repository/,
    );
  });

  it("writes nothing to the repository", async () => {
    const root = repo();
    const snapshot = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .sort()
        .map(
          (p) =>
            `${p}:${
              statSync(join(dir, p)).isFile()
                ? createHash("sha256")
                    .update(readFileSync(join(dir, p)))
                    .digest("hex")
                : "dir"
            }`,
        );
    const before = snapshot(root);
    const s = setup(root);
    for (const f of findingsOf(await s.call("scan", { all: true })))
      await s.call("plan_fix", { findingId: f.findingId });
    await s.call("status");
    expect(snapshot(root)).toEqual(before);
  });
});

describe("plan_fix (paid engine)", () => {
  const plan = async (path: string, p: ReturnType<typeof paidEngine>) => {
    const s = setupH(repo(), p.over, p.n);
    const finding = findingsOf(await s.call("scan")).find((f) => f.path === path);
    return s.call("plan_fix", { findingId: finding?.findingId });
  };

  it("signed in on a paid plan: the verified engine's exact edits, fenced as repository text, nothing written", async () => {
    const calls: string[] = [];
    const p = paidEngine(greedyEngine(calls));
    const s = setupH(
      repo({
        "src/ai.ts": `const x = 1;\nconst y = 2;\nclient.create({ model: "acme-1" }); // ${INJECTION}\n`,
      }),
      p.over,
      p.n,
    );
    const finding = findingsOf(await s.call("scan")).find((f) => f.path === "src/ai.ts");
    const r = await s.call("plan_fix", { findingId: finding?.findingId });
    expect(r.structured.tier).toBe("paid");
    expect(r.structured.engine).toEqual({ sha256: p.sha });
    expect(r.structured.recipeId).toBe("test-swap");
    expect(r.structured.edits).toEqual([
      {
        path: "src/ai.ts",
        line: 3,
        before: `client.create({ model: "acme-1" }); // ${INJECTION}`,
        after: `client.create({ model: "acme-2" }); // ${INJECTION}`,
      },
    ]);
    expect(onlyFenced(r.text, INJECTION)).toBe(true);
    expect(calls).toEqual([`plan ${EVENTS.swap}`]);
    expect(JSON.stringify(r.structured)).not.toContain("person@example.com");
    expect(p.n.urls.sort()).toEqual(
      [`${CLI_API}/whoami`, CLI_ENGINE_URL, ENGINE_RELEASE_URL, `${ENGINE_RELEASE_URL}.sig`].sort(),
    );
  });

  it("defence in depth: an engine that plans edits in alert-only files gets them dropped by the open guard", async () => {
    const p = paidEngine(greedyEngine());
    const r = await setupH(repo(), p.over, p.n).call("plan_fix", { eventId: EVENTS.swap });
    expect(r.structured.tier).toBe("paid");
    expect((r.structured.edits as Array<{ path: string }>).map((e) => e.path)).toEqual([
      "src/ai.ts",
    ]);
  });

  it("a reviewed migration in the engine's knowledge makes the plan a recipe, with no edits", async () => {
    const engine = {
      ...greedyEngine(),
      plan: () => ({
        mode: "recipe",
        recipeId: `migration:${EVENTS.swap}`,
        edits: [],
        skipped: [],
        reason: "run migrate",
        context: null,
      }),
    };
    const r = await plan("src/ai.ts", paidEngine(engine));
    expect(r.structured).toMatchObject({
      tier: "paid",
      mode: "recipe",
      recipeId: `migration:${EVENTS.swap}`,
      edits: [],
    });
  });

  it("an engine that does not verify never runs: the free plan stands", async () => {
    const calls: string[] = [];
    const r = await plan("src/ai.ts", paidEngine(greedyEngine(calls), { tamper: true }));
    expect(r.structured).toMatchObject({
      tier: "free",
      engine: null,
      edits: [],
      context: null,
      recipeId: null,
    });
    expect(r.structured.engineNote).toMatch(/not available/);
    expect(calls).toEqual([]);
  });

  it("an engine without the v2 members degrades to free and says to update the CLI", async () => {
    const r = await plan("src/ai.ts", paidEngine(oldEngine()));
    expect(r.structured).toMatchObject({ tier: "free", engine: null, edits: [] });
    expect(r.structured.engineNote).toMatch(/update the CLI/);
  });

  it("a plan without fixes, or an alert-only finding, never fetches the engine", async () => {
    const free = paidEngine(greedyEngine(), {
      whoami: { email: "x@example.com", plan: "free", fixes: false },
    });
    expect((await plan("src/ai.ts", free)).structured.tier).toBe("free");
    expect(free.n.urls).toEqual([`${CLI_API}/whoami`]);
    const alert = paidEngine(greedyEngine());
    const r = await plan("src/payments/charge.ts", alert);
    expect(r.structured.mode).toBe("alert-only");
    expect(r.structured.engine).toBeNull();
    expect(alert.n.urls).toEqual([]);
  });
});

describe("status", () => {
  it("not signed in: no request, no telemetry, the feed's age", async () => {
    const s = setup(repo());
    const r = await s.call("status");
    expect(r.structured).toMatchObject({
      signedIn: false,
      plan: null,
      fixes: false,
      engine: { loaded: false, sha256: null },
      telemetry: false,
      root: { ok: true },
    });
    expect((r.structured.feed as { generatedAt: string | null }).generatedAt).not.toBeNull();
    expect(s.net.urls).toEqual([]);
  });

  it("signed in: asks whoami only, and returns the plan without the email or the token", async () => {
    const n = net({ whoami: { email: "person@example.com", plan: "team", fixes: true } });
    const s = setup(repo(), { configDir: signedInDir() }, n);
    const r = await s.call("status");
    expect(r.structured).toMatchObject({ signedIn: true, plan: "team", fixes: true });
    const out = JSON.stringify(r.structured) + r.text;
    expect(out).not.toContain("person@example.com");
    expect(out).not.toContain("hbn_cli_");
    expect(n.urls).toEqual([`${CLI_API}/whoami`]);
  });
});

describe("network allowlist", () => {
  it("the signed remote feed is the only download a free session makes", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pub = publicKeyBase64(publicKey);
    const bytes = buildIndex(loadFeed(feedDir()), NOW);
    const envelope = signFeed(
      bytes,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const n = net({
      downloads: {
        [DEFAULT_FEED_URL]: bytes,
        [`${DEFAULT_FEED_URL}.sig`]: new TextEncoder().encode(JSON.stringify(envelope)),
      },
    });
    const s = setup(
      repo(),
      { feedDir: undefined as unknown as string, feedKeys: { [keyIdOf(pub)]: pub } },
      n,
    );
    const r = await s.call("scan");
    expect(r.isError).not.toBe(true);
    for (const f of findingsOf(r)) await s.call("plan_fix", { findingId: f.findingId });
    await s.call("explain", { eventId: EVENTS.swap });
    await s.call("status");
    expect([...new Set(n.urls)].sort()).toEqual(
      [DEFAULT_FEED_URL, `${DEFAULT_FEED_URL}.sig`].sort(),
    );
  });
});

describe("paths and root", () => {
  it("refuses traversal, absolute paths, NUL, .git and node_modules, and paths that do not exist", () => {
    const root = checkRoot(repo({ "node_modules/x/index.js": "", "src/a.ts": "" }));
    if (!root.ok) throw new Error(root.reason);
    for (const bad of [
      "../x",
      "src/../../x",
      "/etc/passwd",
      "C:\\Windows",
      "\\\\server\\share",
      "a\0b",
      ".git/HEAD",
      "node_modules/x",
      "src/missing.ts",
      "",
    ]) {
      expect(() => resolveInside(root.root, bad), JSON.stringify(bad)).toThrow(PathRefused);
    }
    for (const bad of [
      ".GIT/HEAD",
      ".Git",
      ".git./HEAD",
      ".git /HEAD",
      "NODE_MODULES/x",
      "Node_Modules",
      "GIT~1/HEAD",
      "NODE_M~1/x",
      "src/LONGNA~1.TS",
    ]) {
      expect(() => resolveInside(root.root, bad), bad).toThrow(PathRefused);
    }
    expect(resolveInside(root.root, "src/a.ts").rel).toBe("src/a.ts");
    expect(resolveInside(root.root, "./src//a.ts").rel).toBe("src/a.ts");
  });

  it("abuse: NTFS stream names cannot reach .git, and reserved characters are refused everywhere", () => {
    const root = checkRoot(repo({ "src/a.ts": "" }));
    if (!root.ok) throw new Error(root.reason);
    const streams = [
      ".git::$INDEX_ALLOCATION/config",
      ".git::$INDEX_ALLOCATION",
      ".GIT::$index_allocation/HEAD",
      "node_modules::$INDEX_ALLOCATION/x",
      ".git:$I30:$INDEX_ALLOCATION/config",
      "src/a.ts::$DATA",
      "src/a.ts:hidden",
    ];
    const reserved = ["src/a?.ts", "src/*.ts", "src/<a>.ts", 'src/"a".ts', "src/a|b.ts"];
    for (const bad of [...streams, ...reserved]) {
      expect(() => resolveInside(root.root, bad), bad).toThrow(/character Windows reserves/);
    }
    expect(readInside(root.root, ".git::$INDEX_ALLOCATION/config")).toBeUndefined();
  });

  it("refuses a symbolic link (or junction) in any component", async () => {
    const outside = write(mkdtempSync(join(tmpdir(), "outside-")), {
      "leak.ts": 'model: "acme-1"\n',
    });
    const dir = repo();
    symlinkSync(outside, join(dir, "linked"), "junction");
    const root = checkRoot(dir);
    if (!root.ok) throw new Error(root.reason);
    expect(() => resolveInside(root.root, "linked")).toThrow(/symbolic link/);
    expect(() => resolveInside(root.root, "linked/leak.ts")).toThrow(/symbolic link/);
    const r = await setup(dir).call("scan", { path: "linked" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/path refused/);
    expect(JSON.stringify(findingsOf(await setup(dir).call("scan")))).not.toContain("leak.ts");
  });

  it("never reads a secret file, even when asked for its path", () => {
    const root = checkRoot(repo());
    if (!root.ok) throw new Error(root.reason);
    expect(readInside(root.root, ".env")).toBeUndefined();
    expect(readInside(root.root, "src/ai.ts")).toContain("acme-1");
  });

  it("the root must be a git work tree, and not the home directory or a filesystem root", async () => {
    expect(checkRoot(mkdtempSync(join(tmpdir(), "not-git-"))).ok).toBe(false);
    expect(checkRoot(homedir()).ok).toBe(false);
    expect(checkRoot(parse(process.cwd()).root).ok).toBe(false);
    const nested = join(repo(), "src");
    expect(checkRoot(nested)).toMatchObject({ ok: true });
    const fake = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(fake, ".git"));
    expect(checkRoot(fake, fake).ok).toBe(false);
    const r = await setup(mkdtempSync(join(tmpdir(), "not-git-"))).call("scan");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/git work tree/);
  });
});

describe("the alert-only guard is open scanner code", () => {
  it("matches payments, auth, crypto and CI by path and by content", () => {
    expect(isSensitive("src/ai/summarise.ts", 'model: "gpt-4.1"')).toBe(false);
    for (const path of [
      "src/paymentService.ts",
      "app/OAuthCallback.tsx",
      "src/authMiddleware.ts",
      "lib/billingHelpers.ts",
      ".github/workflows/ai.yml",
    ]) {
      expect(isSensitive(path, ""), path).toBe(true);
    }
    for (const content of [
      "import Stripe from 'stripe'",
      "import { createHash } from 'node:crypto'",
      "MessageDigest.getInstance(x)",
    ]) {
      expect(isSensitive("src/ai/summarise.ts", content), content).toBe(true);
    }
  });
});
