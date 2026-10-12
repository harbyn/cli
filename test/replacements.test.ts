import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FeedIndex, feedIndex } from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import { NO_REPLACEMENT, replacementLine, scan, toJson, toText } from "../src/index.ts";

const fetched = { kind: "changelog", fetchedAt: "2026-10-11T00:00:00Z", sha256: "c".repeat(64) };
const review = { state: "human-reviewed", extractedBy: "deterministic" };
const advisoryEvent = (ghsa: string, affects: string[], fixed: string[], severity = "high") => ({
  schemaVersion: 1,
  id: `vercel/2026-10-07-${ghsa.toLowerCase()}`,
  vendor: "vercel",
  product: "next",
  kind: "security",
  severity,
  status: "in-effect",
  title: `Vercel: Next.js advisory ${ghsa}`,
  summary: "An advisory.",
  announcedAt: "2026-10-07",
  addedAt: "2026-10-11",
  affects: affects.map((range) => ({ type: "package", ecosystem: "npm", name: "next", range })),
  replacement: {
    note: `Upgrade next to ${fixed.map((r) => r.slice(2)).join(" or ")} or later (fixes ${ghsa}).`,
    targets: fixed.map((range) => ({ type: "package", ecosystem: "npm", name: "next", range })),
  },
  sources: [
    {
      url: "https://api.github.com/advisories?affects=vercel,@vercel/sdk,next&per_page=20&sort=published&direction=desc",
      ...fetched,
    },
  ],
  link: `https://github.com/advisories/${ghsa}`,
  review,
});

const feed: FeedIndex = feedIndex.parse({
  schemaVersion: 1,
  generatedAt: "2026-10-11T00:00:00Z",
  expiresAt: "2026-10-25T00:00:00Z",
  vendors: [
    {
      schemaVersion: 1,
      id: "vercel",
      name: "Vercel",
      homepage: "https://vercel.com/",
      category: "cloud",
      allowedDomains: ["github.com", "vercel.com"],
      sources: [{ url: "https://vercel.com/atom", format: "atom", purpose: "changelog" }],
      detection: { packages: [{ ecosystem: "npm", name: "next" }] },
    },
    {
      schemaVersion: 1,
      id: "netlify",
      name: "Netlify",
      homepage: "https://www.netlify.com/",
      category: "cloud",
      allowedDomains: ["netlify.com"],
      sources: [
        { url: "https://www.netlify.com/changelog/feed.xml", format: "rss", purpose: "changelog" },
      ],
      detection: { packages: [{ ecosystem: "npm", name: "netlify-cli" }] },
    },
    {
      schemaVersion: 1,
      id: "nodejs",
      name: "Node.js",
      homepage: "https://nodejs.org/",
      category: "devtools",
      allowedDomains: ["nodejs.org", "raw.githubusercontent.com"],
      sources: [
        {
          url: "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json",
          format: "json",
          purpose: "deprecations",
        },
      ],
      detection: { packages: [] },
    },
  ],
  events: [
    advisoryEvent("GHSA-cjq9-62q9-8jv4", [">=16.0.0 <16.3.8"], [">=16.3.8"]),
    advisoryEvent(
      "GHSA-4jqv-mc3x-m676",
      [">=15.0.0 <15.5.27", ">=16.0.0 <16.3.8"],
      [">=15.5.27", ">=16.3.8"],
      "medium",
    ),
    advisoryEvent(
      "GHSA-2xp9-vwfh-vxw4",
      [">=10.0.0 <15.5.24", ">=16.0.0 <16.3.3"],
      [">=15.5.24", ">=16.3.3"],
      "critical",
    ),
    {
      schemaVersion: 1,
      id: "netlify/2026-09-30-security-update-multiple-vulnerabilities-in-next-js",
      vendor: "netlify",
      kind: "security",
      severity: "medium",
      status: "in-effect",
      title: "Netlify: Seven Next.js vulnerabilities patched in 15.5.27 and 16.3.8",
      summary: "Seven Next.js vulnerabilities are patched in 15.5.27 and 16.3.8.",
      announcedAt: "2026-09-30",
      addedAt: "2026-10-09",
      affects: [
        { type: "package", ecosystem: "npm", name: "next", range: "<15.5.27 || >=16.0.0 <16.3.8" },
        { type: "package", ecosystem: "npm", name: "@netlify/plugin-nextjs", range: "<5.16.1" },
      ],
      replacement: {
        note: "Upgrade next to 15.5.27 (15.x) or 16.3.8 (16.x), and @netlify/plugin-nextjs to 5.16.1 if pinned, then redeploy.",
        targets: [],
      },
      sources: [{ url: "https://www.netlify.com/changelog/feed.xml", ...fetched }],
      link: "https://www.netlify.com/changelog/2026-09-30-nextjs-react-security-vulnerabilities/",
      review: { state: "human-reviewed", extractedBy: "llm" },
    },
    {
      schemaVersion: 1,
      id: "nodejs/2026-10-09-nodejs-22-end-of-life",
      vendor: "nodejs",
      product: "api",
      kind: "deprecation",
      severity: "medium",
      status: "announced",
      title: "Node.js: Node.js 22 reaches end of life on 2027-04-30",
      summary: "Node.js 22 stops receiving security fixes on 2027-04-30.",
      announcedAt: "2026-10-09",
      addedAt: "2026-10-09",
      effectiveAt: "2027-04-30",
      affects: [{ type: "symbol", values: ["node22"] }],
      replacement: {
        note: "Node.js 24 (LTS, supported until 2028-04-30)",
        targets: [{ type: "symbol", values: ["node24"] }],
      },
      sources: [
        { url: "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json", ...fetched },
      ],
      review,
    },
    {
      schemaVersion: 1,
      id: "nodejs/2026-10-09-nodejs-20-end-of-life",
      vendor: "nodejs",
      product: "api",
      kind: "deprecation",
      severity: "medium",
      status: "announced",
      title: "Node.js: Node.js 20 reaches end of life",
      summary: "Node.js 20 stops receiving security fixes.",
      announcedAt: "2026-10-09",
      addedAt: "2026-10-09",
      effectiveAt: "2027-04-30",
      affects: [{ type: "symbol", values: ["node20"] }],
      sources: [
        { url: "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json", ...fetched },
      ],
      review,
    },
  ],
});

const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "repl-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
};
const pkg = (deps: Record<string, string>, engines?: string) =>
  JSON.stringify(
    { name: "app", dependencies: deps, ...(engines ? { engines: { node: engines } } : {}) },
    null,
    2,
  );
const TODAY = "2026-10-12";

describe("replacements in the scan output", () => {
  it("an advisory finding names the fixed release of the line the repository is on", () => {
    const result = scan(repo({ "package.json": pkg({ next: "^16.3.6" }) }), feed);
    const ids = result.findings.map((f) => f.event.id).sort();
    expect(ids).toEqual([
      "vercel/2026-10-07-ghsa-4jqv-mc3x-m676",
      "vercel/2026-10-07-ghsa-cjq9-62q9-8jv4",
    ]);
    const branches = result.findings.find((f) => f.event.id.endsWith("4jqv-mc3x-m676"));
    expect(replacementLine(branches!.event, branches)).toBe("Upgrade to: next >=16.3.8");

    const json = toJson(result).findings.find((f) => f.eventId.endsWith("4jqv-mc3x-m676"));
    expect(json).toMatchObject({
      replacement: ["next >=16.3.8"],
      nextStep: "Upgrade to: next >=16.3.8",
      replacementNote: "Upgrade next to 15.5.27 or 16.3.8 or later (fixes GHSA-4jqv-mc3x-m676).",
    });

    const text = toText(result, TODAY);
    expect(text).toContain("  Upgrade to: next >=16.3.8");
    expect(text).toContain("now (security advisory, no deadline)");
  });

  it("an older line gets its own fixed release, and a version outside every range is not reported", () => {
    const old = scan(repo({ "package.json": pkg({ next: "15.5.20" }) }), feed);
    const f = old.findings.find((x) => x.event.id.endsWith("2xp9-vwfh-vxw4"));
    expect(f && replacementLine(f.event, f)).toBe("Upgrade to: next >=15.5.24");
    expect(scan(repo({ "package.json": pkg({ next: "^16.3.8" }) }), feed).findings).toEqual([]);
  });

  it("an advisory hides the changelog notice about the same package on the same line, not what only the notice covers", () => {
    const both = scan(
      repo({ "package.json": pkg({ next: "16.3.6", "@netlify/plugin-nextjs": "5.15.0" }) }),
      feed,
    );
    const netlify = both.findings.filter((f) => f.event.vendor === "netlify");
    expect(netlify.map((f) => f.token)).toEqual(["@netlify/plugin-nextjs@5.15.0"]);
    expect(
      both.findings.some((f) => f.event.vendor === "vercel" && f.token === "next@16.3.6"),
    ).toBe(true);
    const noAdvisory = scan(repo({ "package.json": pkg({ next: "9.0.0" }) }), feed);
    expect(noAdvisory.findings.map((f) => f.event.vendor)).toEqual(["netlify"]);
    expect(replacementLine(noAdvisory.findings[0]!.event, noAdvisory.findings[0])).toMatch(
      /^What to do: Upgrade next to 15.5.27/,
    );
  });

  it("a runtime end of life names the supported line to move to, in words", () => {
    const result = scan(repo({ "package.json": pkg({}, ">=22"), ".nvmrc": "20\n" }), feed);
    const text = toText(result, TODAY);
    expect(text).toContain("  Migrate to: Node.js 24 (LTS, supported until 2028-04-30)");
    const json = toJson(result).findings;
    expect(json.find((f) => f.eventId.endsWith("nodejs-22-end-of-life"))).toMatchObject({
      replacement: ["node24"],
      nextStep: "Migrate to: Node.js 24 (LTS, supported until 2028-04-30)",
    });
    expect(json.find((f) => f.eventId.endsWith("nodejs-20-end-of-life"))).toMatchObject({
      replacement: [],
      nextStep: NO_REPLACEMENT,
      replacementNote: null,
    });
    expect(text).toContain(`  ${NO_REPLACEMENT}`);
  });
});

describe("nested repositories", () => {
  it("names each skipped nested repository and how to scan it, in text and JSON", () => {
    const root = repo({
      "README.md": "workspace\n",
      "cdaher-v1-d4sign/package.json": pkg({ next: "16.3.6" }),
      "cdaher-v1-d4sign/.git/HEAD": "ref: refs/heads/main\n",
    });
    const result = scan(root, feed);
    expect(result.findings).toEqual([]);
    const text = toText(result, TODAY);
    expect(text).toContain(
      "Skipped 1 nested repository: cdaher-v1-d4sign (it is its own git repository; run `npx harbyn scan` inside it, or add --include-nested)",
    );
    expect(text.indexOf("Skipped 1 nested")).toBeLessThan(text.indexOf("finding(s)"));
    expect(toJson(result).skippedNestedRepos).toEqual(["cdaher-v1-d4sign"]);
    expect(scan(root, feed, { includeNestedRepos: true }).findings.length).toBeGreaterThan(0);
  });

  it("several, capped", () => {
    const files: Record<string, string> = {};
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) files[`${name}/.git/HEAD`] = "x";
    const text = toText(scan(repo(files), feed), TODAY);
    expect(text).toContain(
      "Skipped 7 nested repositories: a, b, c, d, e, and 2 more (each is its own git repository; run `npx harbyn scan` inside each, or add --include-nested)",
    );
  });
});
