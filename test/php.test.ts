import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FeedIndex, feedIndex } from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import { declaredPhp, phpFloor, scan, toJson, toText } from "../src/index.ts";
import { toAnnotations } from "../src/github.ts";

const BRANCHES = ["5.6", "7.4", "8.0", "8.1", "8.2", "8.3", "8.4", "8.5"];
const php2shell = {
  schemaVersion: 1,
  id: "php/2026-10-21-cve-2026-109618-cve-2026-109619",
  vendor: "php",
  product: "php",
  kind: "security",
  severity: "critical",
  status: "in-effect",
  title:
    "PHP core: RCE via OOM corruption; RCE via stale global state (CVE-2026-109618, CVE-2026-109619)",
  summary: "Critical vulnerabilities in PHP itself.",
  announcedAt: "2026-10-21",
  addedAt: "2026-10-22",
  affects: [{ type: "symbol", values: BRANCHES.map((b) => `php${b}`) }],
  replacement: {
    note: "Upgrade to the fixed release of your branch.",
    targets: [{ type: "symbol", values: ["php8.2.35", "php8.3.36", "php8.4.27", "php8.5.12"] }],
  },
  sources: [
    {
      url: "https://api.github.com/repos/php/php-src/security-advisories",
      kind: "changelog",
      fetchedAt: "2026-10-22T03:00:00Z",
      sha256: "a".repeat(64),
    },
  ],
  link: "https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w",
  review: { state: "human-reviewed", extractedBy: "deterministic" },
};
const vendor = (id: string) => ({
  schemaVersion: 1,
  id,
  name: id === "php" ? "PHP" : id,
  homepage: "https://www.php.net/",
  category: "devtools",
  allowedDomains: ["php.net", "github.com"],
  sources: [
    {
      url: "https://api.github.com/repos/php/php-src/security-advisories",
      format: "json",
      purpose: "changelog",
    },
  ],
  detection: {},
});
const makeFeed = (events: unknown[]): FeedIndex =>
  feedIndex.parse({
    schemaVersion: 1,
    generatedAt: "2026-10-22T00:00:00Z",
    expiresAt: "2026-10-26T00:00:00Z",
    vendors: ["php", "acme"].map(vendor),
    events,
  });
const feed = makeFeed([php2shell]);

const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "harbyn-php-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

describe("declared PHP versions", () => {
  it("reads Dockerfile FROM lines, exact, floating and digest-pinned", () => {
    const text = [
      "# syntax=docker/dockerfile:1",
      "FROM php:8.3.35-fpm-alpine AS base",
      "FROM --platform=linux/amd64 docker.io/library/php:8.4-apache",
      "from php:8.2.20@sha256:" + "b".repeat(64),
      "FROM composer:2 AS deps",
      "FROM bitnami/php-fpm:8.3.1",
      "FROM php:latest",
      "FROM php:8",
    ].join("\n");
    expect(declaredPhp("Dockerfile", text)).toEqual([
      { version: "8.3.35", pin: "exact", line: 2, shown: "php:8.3.35-fpm-alpine", span: [9, 15] },
      { version: "8.4", pin: "floating", line: 3, shown: "php:8.4-apache" },
      {
        version: "8.2.20",
        pin: "exact",
        line: 4,
        shown: "php:8.2.20",
        span: [9, 15],
        digest: true,
      },
    ]);
    expect(declaredPhp("docker/app.Dockerfile", "FROM php:7.4.33-cli")).toHaveLength(1);
    expect(declaredPhp("Containerfile.prod", "FROM php:8.1-fpm")).toHaveLength(1);
    expect(declaredPhp("Dockerfile.txt.bak", "FROM php:8.1-fpm")).toEqual([]);
  });

  it("reads ARG PHP_VERSION only when a FROM uses it", () => {
    const text = ["ARG PHP_VERSION=8.3.35", "FROM php:${PHP_VERSION}-fpm"].join("\n");
    expect(declaredPhp("Dockerfile", text)).toEqual([
      { version: "8.3.35", pin: "exact", line: 1, shown: "PHP_VERSION=8.3.35", span: [16, 22] },
    ]);
    expect(declaredPhp("Dockerfile", "ARG PHP_VERSION=8.3.35\nFROM node:22")).toEqual([]);
  });

  it("reads compose images, .php-version and .tool-versions", () => {
    expect(
      declaredPhp(
        "docker-compose.yml",
        'services:\n  app:\n    image: "php:8.4.10-fpm"\n  db:\n    image: postgres:18',
      ),
    ).toEqual([
      { version: "8.4.10", pin: "exact", line: 3, shown: "php:8.4.10-fpm", span: [16, 22] },
    ]);
    expect(declaredPhp("compose.yaml", "services:\n  web:\n    image: php:8.1-apache")).toEqual([
      { version: "8.1", pin: "floating", line: 3, shown: "php:8.1-apache" },
    ]);
    expect(declaredPhp(".php-version", "\n8.3.35\n")).toEqual([
      { version: "8.3.35", pin: "exact", line: 2, shown: "8.3.35", span: [0, 6] },
    ]);
    expect(declaredPhp(".php-version", "8.3\n")).toEqual([
      { version: "8.3", pin: "floating", line: 1, shown: "8.3" },
    ]);
    expect(declaredPhp(".tool-versions", "nodejs 22.1.0\nphp 8.3.35 8.2.1\n")).toEqual([
      { version: "8.3.35", pin: "exact", line: 2, shown: "8.3.35", span: [4, 10] },
    ]);
  });

  it("reads composer.json require.php as a range and config.platform.php as exact", () => {
    const text = JSON.stringify(
      {
        require: { php: "^8.1 || ^8.2", "laravel/framework": "^11.0" },
        "require-dev": { php: "^7.0" },
        config: { platform: { php: "8.3.35" } },
      },
      null,
      4,
    );
    expect(declaredPhp("composer.json", text)).toEqual([
      { version: "8.1.0", pin: "range", line: 3, shown: "^8.1 || ^8.2" },
      { version: "8.3.35", pin: "exact", line: 11, shown: "8.3.35", span: [20, 26] },
    ]);
    expect(declaredPhp("composer.json", '{"config":{"platform":{"php":"8.3.35"}}}')).toEqual([
      { version: "8.3.35", pin: "exact", line: 1, shown: "8.3.35" },
    ]);
    expect(declaredPhp("composer.json", "{ not json")).toEqual([]);
  });

  it("reads setup-php versions in workflows: scalars, inline and block lists", () => {
    const text = [
      "jobs:",
      "  test:",
      "    strategy:",
      "      matrix:",
      "        php: ['8.1', \"8.3.35\", 8.4]",
      "        php-versions:",
      "          - '8.2'",
      "          - 8.5.11",
      "        os: [ubuntu-latest]",
      "    steps:",
      "      - uses: shivammathur/setup-php@v2",
      "        with:",
      "          php-version: '8.3.35'",
      "      - uses: shivammathur/setup-php@v2",
      "        with:",
      "          php-version: ${{ matrix.php }}",
    ].join("\n");
    const found = declaredPhp(".github/workflows/ci.yml", text);
    expect(found).toEqual([
      { version: "8.1", pin: "floating", line: 5, shown: "8.1" },
      { version: "8.3.35", pin: "exact", line: 5, shown: "8.3.35", span: [22, 28] },
      { version: "8.4", pin: "floating", line: 5, shown: "8.4" },
      { version: "8.2", pin: "floating", line: 7, shown: "8.2" },
      { version: "8.5.11", pin: "exact", line: 8, shown: "8.5.11", span: [12, 18] },
      { version: "8.3.35", pin: "exact", line: 13, shown: "8.3.35", span: [24, 30] },
    ]);
    for (const d of found)
      if (d.span) expect(text.split("\n")[d.line - 1]?.slice(...d.span)).toBe(d.version);
    expect(declaredPhp(".github/workflows/ci.yml", "        php: ['8.3.35']")).toEqual([]);
    expect(
      declaredPhp("ci/workflows/ci.yml", "uses: shivammathur/setup-php@v2\nphp-version: '8.3.35'"),
    ).toEqual([]);
  });

  it("finds the lowest version a Composer constraint allows", () => {
    expect(phpFloor("^8.2")).toBe("8.2.0");
    expect(phpFloor(">=8.1 <8.4")).toBe("8.1.0");
    expect(phpFloor("~8.3.30")).toBe("8.3.30");
    expect(phpFloor("8.3.*")).toBe("8.3.0");
    expect(phpFloor("^7.4|^8.0")).toBe("7.4.0");
    expect(phpFloor(">=8.3.36")).toBe("8.3.36");
    expect(phpFloor("*")).toBeUndefined();
    expect(phpFloor("<9")).toBeUndefined();
    expect(phpFloor("dev-master")).toBeUndefined();
    expect(phpFloor("^8.2 ".repeat(40))).toBeUndefined();
  });

  it("treats hostile input as data: odd tags, huge lines, control bytes, no evaluation", () => {
    expect(declaredPhp("Dockerfile", "FROM php:8.3.36-evil")).toEqual([
      { version: "8.3.36", pin: "exact", line: 1, shown: "php:8.3.36-evil", span: [9, 15] },
    ]);
    expect(declaredPhp("Dockerfile", "FROM php:8.3.35;rm -rf /")).toEqual([]);
    expect(declaredPhp("Dockerfile", "FROM php:8.3.35 && curl evil")).toEqual([]);
    expect(declaredPhp("Dockerfile", "FROM php:$(id)")).toEqual([]);
    expect(declaredPhp("Dockerfile", "FROM php:99.3.35")).toEqual([]);
    expect(declaredPhp("Dockerfile", "FROM php:8.3.035")).toEqual([]);
    expect(declaredPhp("Dockerfile", `FROM php:8.3.35-${"a".repeat(2000)}`)).toEqual([]);
    expect(declaredPhp("Dockerfile", `${"FROM php:8.3.35\n".repeat(500)}`)).toHaveLength(100);
    expect(declaredPhp(".php-version", `8.3.35${String.fromCodePoint(0)}`)).toEqual([]);
    expect(declaredPhp(".php-version", "8.3.35; echo pwned")).toEqual([]);
    expect(
      declaredPhp(
        "composer.json",
        JSON.stringify({ require: { php: { $gt: 1 } }, config: { platform: { php: ["8.3.35"] } } }),
      ),
    ).toEqual([]);
    expect(
      declaredPhp(
        "composer.json",
        JSON.stringify({ config: { platform: { php: "8.3.35-evil" } } }),
      ),
    ).toEqual([]);
    const start = Date.now();
    declaredPhp(
      ".github/workflows/x.yml",
      `shivammathur/setup-php\n php-version: [${"'8.3',".repeat(5000)}`,
    );
    declaredPhp("Dockerfile", `FROM php:${"8.".repeat(400)}`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("PHP2Shell findings", () => {
  const fixture = {
    Dockerfile: "FROM php:8.3.35-fpm\nRUN docker-php-ext-install pdo_mysql\n",
    "docker/legacy/Dockerfile": "FROM php:8.1-apache\n",
    "docker-compose.yml":
      "services:\n  worker:\n    image: php:8.4\n  fixed:\n    image: php:8.4.27-cli\n",
    "composer.json": JSON.stringify(
      { name: "acme/shop", require: { php: "^8.2" }, config: { platform: { php: "8.3.35" } } },
      null,
      2,
    ),
    ".tool-versions": "php 8.3.36\n",
    ".php-version": "8.0.30\n",
    ".github/workflows/ci.yml":
      "jobs:\n  t:\n    steps:\n      - uses: shivammathur/setup-php@v2\n        with:\n          php-version: '8.3.35'\n",
    "tests/docker/Dockerfile": "FROM php:8.2.1\n",
    "README.md": "FROM php:8.3.35-fpm\n",
  };

  it("finds every affected declaration at patch level, and nothing fixed", () => {
    const result = scan(repo(fixture), feed);
    const rows = result.findings
      .map(
        (f) => `${f.path}:${f.line} ${f.token} ${f.php?.pin} ${f.php?.fixed ?? "-"} ${f.context}`,
      )
      .sort();
    expect(rows).toEqual([
      ".github/workflows/ci.yml:6 php 8.3.35 exact 8.3.36 code",
      ".php-version:1 php 8.0.30 exact - code",
      "Dockerfile:1 php:8.3.35-fpm exact 8.3.36 code",
      "composer.json:4 php ^8.2 range 8.2.35 code",
      "composer.json:8 php 8.3.35 exact 8.3.36 code",
      "docker-compose.yml:3 php:8.4 floating 8.4.27 code",
      "docker/legacy/Dockerfile:1 php:8.1-apache floating - code",
      "tests/docker/Dockerfile:1 php:8.2.1 exact 8.2.35 test",
    ]);
  });

  it("says the exact next step for each kind of pin", () => {
    const json = toJson(scan(repo(fixture), feed));
    const step = (path: string) => json.findings.find((f) => f.path === path)?.nextStep;
    expect(step("Dockerfile")).toBe("Upgrade to: PHP 8.3.36 (same 8.3 branch)");
    expect(step("docker-compose.yml")).toMatch(
      /^What to do: this follows the newest PHP 8.4 patch: rebuild or re-pull, then check that the running PHP reports 8.4.27 or later/,
    );
    expect(step("docker/legacy/Dockerfile")).toBe(
      "What to do: PHP 8.1 gets no fixed release: move to a supported branch (PHP 8.2.35 or later)",
    );
    expect(step(".php-version")).toContain("PHP 8.0 gets no fixed release");
    expect(json.findings.find((f) => f.path === "Dockerfile")?.replacement).toEqual(["php8.3.36"]);
    expect(
      json.findings.find((f) => f.path === "composer.json" && f.line === 4)?.nextStep,
    ).toContain("Composer does not choose the PHP that runs");
  });

  it("reports in text and as error annotations (critical security)", () => {
    const result = scan(repo(fixture), feed);
    const text = toText(result, "2026-10-22");
    expect(text).toContain("[CRITICAL] PHP core: RCE via OOM corruption");
    expect(text).toContain("Dockerfile:1  php:8.3.35-fpm  -> upgrade to 8.3.36");
    expect(text).toContain(
      "docker/legacy/Dockerfile:1  php:8.1-apache  -> no fix for 8.1: move to 8.2.35+",
    );
    expect(text).toContain("What to do: see each line");
    const annotations = toAnnotations(result, "2026-10-22");
    expect(annotations.find((a) => a.includes("file=Dockerfile,line=1"))).toMatch(/^::error /);
  });

  it("ignores other vendors' symbols, other runtimes' files and symlinks", () => {
    const other = makeFeed([{ ...php2shell, id: "acme/2026-10-21-x", vendor: "acme" }]);
    expect(scan(repo(fixture), other).findings).toEqual([]);
    const root = repo({ "real/Dockerfile": "FROM php:8.3.35\n" });
    try {
      symlinkSync(join(root, "real"), join(root, "linked"), "junction");
    } catch {}
    expect(scan(root, feed).findings.map((f) => f.path)).toEqual(["real/Dockerfile"]);
  });

  it("is quiet once every pin is on a fixed release", () => {
    const fixed = repo({
      Dockerfile: "FROM php:8.3.36-fpm\n",
      ".php-version": "8.5.12\n",
      "composer.json": JSON.stringify({ require: { php: ">=8.3.36" } }),
    });
    expect(scan(fixed, feed).findings).toEqual([]);
  });
});
