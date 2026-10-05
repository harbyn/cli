import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  declaredFloor,
  type FeedIndex,
  feedIndex,
  parseRange,
  parseVersion,
  satisfies,
} from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import { actionable, findToken, IgnoreRules, matchSegment, scan, toText } from "../src/index.ts";

const source = {
  url: "https://acme.example/changelog",
  kind: "changelog",
  fetchedAt: "2026-01-01T00:00:00Z",
  sha256: "d".repeat(64),
};
const base = {
  schemaVersion: 1,
  vendor: "acme",
  kind: "breaking",
  severity: "medium",
  status: "announced",
  title: "change",
  summary: "something changes.",
  announcedAt: "2026-01-01",
  addedAt: "2026-01-01",
  effectiveAt: "2026-06-01",
  sources: [source],
  review: { state: "automated", extractedBy: "deterministic" },
};
const models = ["acme-a", "acme-b", "acme-c", "acme-d", "acme-e", "acme-f", "acme-g"];
const feed: FeedIndex = feedIndex.parse({
  schemaVersion: 1,
  generatedAt: "2026-02-01T00:00:00Z",
  expiresAt: "2026-02-15T00:00:00Z",
  vendors: [
    {
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
        versionHeaders: ["acme-version"],
        modelIdPrefixes: ["acme-"],
        modelIdVariantSuffixes: [":nitro"],
        envVars: ["ACME_API_KEY"],
      },
    },
  ],
  events: [
    { ...base, id: "acme/2026-01-01-models", affects: [{ type: "model-id", values: models }] },
    {
      ...base,
      id: "acme/2026-01-01-version",
      affects: [{ type: "api-version", header: "acme-version", values: ["2023-06-01"] }],
    },
    {
      ...base,
      id: "acme/2026-01-01-sdk",
      affects: [{ type: "package", ecosystem: "npm", name: "acme-sdk", range: "<4.0.0" }],
    },
    {
      ...base,
      id: "acme/2026-01-01-pysdk",
      affects: [{ type: "package", ecosystem: "pypi", name: "acme_sdk", range: ">=1.0.0 <2.0.0" }],
    },
    {
      ...base,
      id: "acme/2026-01-01-endpoint",
      affects: [{ type: "endpoint", method: "POST", path: "/v1/assistants/{id}" }],
    },
  ],
});

const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "repo-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
};
const ids = (root: string, options = {}) =>
  scan(root, feed, options)
    .findings.map((f) => `${f.path}:${f.line}:${f.via}:${f.token}:${f.context}`)
    .sort();

describe("semver range grammar", () => {
  it("parses and evaluates the supported grammar", () => {
    const v = (s: string) => parseVersion(s) as [number, number, number];
    expect(satisfies(v("3.9.9"), parseRange("<4.0.0") ?? [])).toBe(true);
    expect(satisfies(v("4.0.0"), parseRange("<4.0.0") ?? [])).toBe(false);
    expect(satisfies(v("1.5"), parseRange(">= 1.0.0 <2.0.0 || =3.1.0") ?? [])).toBe(true);
    expect(satisfies(v("3.1.0"), parseRange(">=1.0.0 <2.0.0 || =3.1.0") ?? [])).toBe(true);
    expect(satisfies(v("2.5.0"), parseRange(">=1.0.0 <2.0.0 || =3.1.0") ?? [])).toBe(false);
  });
  it.each(["^1.0.0", "~1.2", "*", "latest", "<", "1.0.0 ||", "a".repeat(80), ">=1.0.0 && <2"])(
    "rejects unsupported range %s",
    (r) => {
      expect(parseRange(r)).toBeUndefined();
    },
  );
  it("derives the floor of a declared spec and refuses non-registry specs", () => {
    expect(declaredFloor("^4.2.0")).toEqual([4, 2, 0]);
    expect(declaredFloor(">=1.0,<2")).toEqual([1, 0, 0]);
    expect(declaredFloor("workspace:*")).toBeUndefined();
    expect(declaredFloor("git+https://github.com/x/y#v1.2.3")).toBeUndefined();
    expect(declaredFloor("latest")).toBeUndefined();
  });
});

describe("ignore rules (gitignore semantics, no regex, no git)", () => {
  it("matches segments with *, ? and classes", () => {
    expect(matchSegment("*.log", "app.log")).toBe(true);
    expect(matchSegment("*.log", "app.log.txt")).toBe(false);
    expect(matchSegment("file?.t[sx]", "file1.ts")).toBe(true);
    expect(matchSegment("file?.t[!sx]", "file1.ts")).toBe(false);
    expect(matchSegment("a*b*c", "aXXbYYc")).toBe(true);
  });
  it("handles anchoring, dir-only, ** and negation (last rule wins)", () => {
    const rules = new IgnoreRules();
    rules.add(
      ["reference/", "/only-root.ts", "**/gen/*.ts", "*.snap", "!keep.snap", "# comment", ""].join(
        "\n",
      ),
      "",
    );
    rules.add("local.ts", "pkg");
    expect(rules.ignores("reference", true)).toBe(true);
    expect(rules.ignores("reference", false)).toBe(false);
    expect(rules.ignores("only-root.ts", false)).toBe(true);
    expect(rules.ignores("sub/only-root.ts", false)).toBe(false);
    expect(rules.ignores("a/b/gen/x.ts", false)).toBe(true);
    expect(rules.ignores("a/x.snap", false)).toBe(true);
    expect(rules.ignores("a/keep.snap", false)).toBe(false);
    expect(rules.ignores("pkg/deep/local.ts", false)).toBe(true);
    expect(rules.ignores("other/local.ts", false)).toBe(false);
  });
  it("stays fast on hostile patterns", () => {
    const rules = new IgnoreRules();
    rules.add(`${"*a".repeat(60)}b\n${"**/".repeat(40)}x`, "");
    const started = Date.now();
    rules.ignores(`${"a".repeat(200)}/${"a/".repeat(60)}y`, false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("noise control", () => {
  it("honours .gitignore, the project ignore file, --ignore, and skips nested repos", () => {
    const root = repo({
      ".gitignore": "generated/\n",
      ".harbynignore": "legacy/\n",
      "src/a.ts": '"acme-a"',
      "generated/b.ts": '"acme-a"',
      "legacy/c.ts": '"acme-a"',
      "tmp/d.ts": '"acme-a"',
      "reference/other/.git/HEAD": "ref: refs/heads/main",
      "reference/other/e.ts": '"acme-a"',
    });
    expect(ids(root, { ignore: ["tmp/"] })).toEqual(["src/a.ts:1:model-id:acme-a:code"]);
    const result = scan(root, feed, { ignore: ["tmp/"] });
    expect(result.stats.skippedNestedRepos).toEqual(["reference/other"]);
    expect(
      ids(root, { ignore: ["tmp/"], includeNestedRepos: true, noGitignore: true }),
    ).toHaveLength(3);
  });

  it("classifies tests, docs and model catalogs as low confidence", () => {
    const root = repo({
      "src/call.ts": 'model: "acme-a"',
      "src/call.test.ts": 'model: "acme-a"',
      "docs/guide.md": "use acme-a",
      "data/models.json": JSON.stringify(models),
    });
    const result = scan(root, feed);
    expect(actionable(result).map((f) => f.path)).toEqual(["src/call.ts"]);
    expect(
      new Set(result.findings.filter((f) => f.path === "data/models.json").map((f) => f.context)),
    ).toEqual(new Set(["catalog"]));
    expect(toText(result, "2026-02-01")).toContain("more in tests, docs and model catalogs");
    expect(toText(result, "2026-02-01")).not.toContain("guide.md");
    expect(toText(result, "2026-02-01", true)).toContain("guide.md");
  });
});

describe("detectors", () => {
  it("matches gateway variant suffixes but not other variants", () => {
    expect(findToken('"acme-a:nitro"', "acme-a", [":nitro"])).toBe("acme-a:nitro");
    expect(findToken('"acme-a:free"', "acme-a", [":nitro"])).toBeUndefined();
    expect(findToken('"acme-a:nitrous"', "acme-a", [":nitro"])).toBeUndefined();
  });

  it("finds header-pinned API versions only next to the header", () => {
    const root = repo({
      "src/http.ts": 'headers: { "Acme-Version": "2023-06-01" }\nconst released = "2023-06-01";\n',
    });
    expect(ids(root)).toEqual(["src/http.ts:1:api-version:2023-06-01:code"]);
  });

  it("finds a pinned version inside a URL path only when the file shows the vendor", () => {
    const root = repo({
      "src/shop.ts": 'const url = "https://api.acme.example/admin/api/2023-06-01/graphql.json";',
      "src/dates.ts": 'const archive = "/backups/2023-06-01/db.sql";',
      "src/cfg.ts":
        'const client = acme({ key: process.env.ACME_API_KEY, apiVersion: "2023-06-01" });',
    });
    expect(ids(root)).toEqual([
      "src/cfg.ts:1:api-version:2023-06-01:code",
      "src/shop.ts:1:api-version:2023-06-01:code",
    ]);
  });

  it("finds affected declared package versions (npm and pypi, with name normalisation)", () => {
    const root = repo({
      "package.json": JSON.stringify(
        { dependencies: { "acme-sdk": "^3.2.0", other: "1.0.0" } },
        null,
        2,
      ),
      "requirements.txt": "Acme.SDK>=1.4,<2\nrequests==2.0\n",
      "svc/package.json": JSON.stringify({ dependencies: { "acme-sdk": "^4.1.0" } }),
    });
    expect(ids(root)).toEqual([
      "package.json:3:package:acme-sdk@3.2.0:code",
      "requirements.txt:1:package:acme_sdk@1.4.0:code",
    ]);
  });

  it("survives malformed manifests", () => {
    expect(
      ids(repo({ "package.json": "{ not json", "svc/package.json": '{"dependencies": 5}' })),
    ).toEqual([]);
  });

  it("matches endpoints only in files that show the vendor", () => {
    const root = repo({
      "src/api.ts":
        'const base = "https://api.acme.example";\nawait post(`${base}/v1/assistants/${id}`);\n',
      "src/unrelated.ts": 'router.post("/v1/assistants/:id")',
    });
    expect(ids(root)).toEqual(["src/api.ts:2:endpoint:/v1/assistants/{id}:code"]);
  });
});
