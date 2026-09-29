import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangeEvent, Vendor } from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import { applyFixes, isSensitive, planFixes, replaceLiteral } from "../src/fix.ts";
import type { Finding } from "../src/match.ts";
import type { ScanResult } from "../src/report.ts";

const event = (over: Partial<ChangeEvent> = {}): ChangeEvent =>
  ({
    schemaVersion: 1,
    id: "openai/2026-01-01-gpt-4-0613-retirement",
    vendor: "openai",
    kind: "retirement",
    severity: "high",
    status: "announced",
    title: "OpenAI: gpt-4-0613 retirement",
    summary: "Retired.",
    announcedAt: "2026-01-01",
    addedAt: "2026-01-02",
    effectiveAt: "2026-06-01",
    affects: [{ type: "model-id", values: ["gpt-4-0613"] }],
    replacement: { targets: [{ type: "model-id", values: ["gpt-4.1"] }] },
    sources: [
      {
        url: "https://platform.openai.com/docs/deprecations",
        kind: "deprecations",
        fetchedAt: "2026-01-02T00:00:00Z",
        sha256: "a".repeat(64),
      },
    ],
    review: { state: "human-reviewed", extractedBy: "llm" },
    ...over,
  }) as ChangeEvent;

const vendors = new Map<string, Vendor>([
  ["openai", { id: "openai", name: "OpenAI", alertOnly: false } as Vendor],
  ["stripe", { id: "stripe", name: "Stripe", alertOnly: true } as Vendor],
]);

const finding = (
  e: ChangeEvent,
  path: string,
  line: number,
  over: Partial<Finding> = {},
): Finding =>
  ({
    event: e,
    via: "model-id",
    token: "gpt-4-0613",
    path,
    line,
    context: "code",
    ...over,
  }) as Finding;

const plan = (findings: Finding[], files: Record<string, string>) =>
  planFixes(
    {
      findings,
      usage: [],
      stats: {
        scanned: 0,
        skippedSecret: 0,
        skippedIgnored: 0,
        skippedNestedRepos: [],
        truncated: false,
      },
    } as ScanResult,
    {
      root: "/nowhere",
      vendors,
      read: (p) => files[p],
    },
  );

describe("replaceLiteral", () => {
  it("replaces only whole string literals", () => {
    expect(replaceLiteral('  model: "gpt-4-0613",', "gpt-4-0613", "gpt-4.1")).toBe(
      '  model: "gpt-4.1",',
    );
    expect(
      replaceLiteral("const m = 'gpt-4-0613'; const n = `gpt-4-0613`", "gpt-4-0613", "gpt-4.1"),
    ).toBe("const m = 'gpt-4.1'; const n = `gpt-4.1`");
    expect(replaceLiteral('model: "gpt-4-0613-preview"', "gpt-4-0613", "gpt-4.1")).toBeUndefined();
    expect(replaceLiteral("model: \"gpt-4-0613'", "gpt-4-0613", "gpt-4.1")).toBeUndefined();
    expect(replaceLiteral('// was "gpt-4-0613"', "gpt-4-0613", "gpt-4.1")).toBeUndefined();
    expect(replaceLiteral('# model = "gpt-4-0613"', "gpt-4-0613", "gpt-4.1")).toBeUndefined();
    expect(replaceLiteral("model = gpt_4_0613", "gpt-4-0613", "gpt-4.1")).toBeUndefined();
    expect(replaceLiteral('call(); // "gpt-4-0613"', "gpt-4-0613", "gpt-4.1")).toBeUndefined();
    expect(replaceLiteral('m = "gpt-4-0613"  # was "gpt-4-0613"', "gpt-4-0613", "gpt-4.1")).toBe(
      'm = "gpt-4.1"  # was "gpt-4-0613"',
    );
    expect(
      replaceLiteral('url = "https://x.example/#a"; m = "gpt-4-0613"', "gpt-4-0613", "gpt-4.1"),
    ).toBe('url = "https://x.example/#a"; m = "gpt-4.1"');
  });
});

describe("planFixes", () => {
  it("plans the exact swap on code lines and lists tests and docs as not changed", () => {
    const e = event();
    const { plans, unfixable } = plan(
      [
        finding(e, "src/ai.ts", 2),
        finding(e, "test/ai.test.ts", 1, { context: "test" }),
        finding(e, "README.md", 3, { context: "docs" }),
      ],
      {
        "src/ai.ts":
          'import OpenAI from "openai";\nconst r = await client.chat.completions.create({ model: "gpt-4-0613" });\n',
      },
    );
    expect(unfixable).toEqual([]);
    expect(plans[0]?.edits).toEqual([
      {
        path: "src/ai.ts",
        line: 2,
        before: 'const r = await client.chat.completions.create({ model: "gpt-4-0613" });',
        after: 'const r = await client.chat.completions.create({ model: "gpt-4.1" });',
      },
    ]);
    expect(plans[0]?.skipped.map((s) => s.reason)).toEqual(["test file", "documentation"]);
  });

  it("abuse: unreviewed LLM events, alert-only vendors and ambiguous replacements are never fixed", () => {
    const files = { "src/ai.ts": 'x = "gpt-4-0613"' };
    const cases: Array<[ChangeEvent, RegExp]> = [
      [event({ review: { state: "automated", extractedBy: "llm" } }), /not reviewed/],
      [event({ vendor: "stripe", id: "stripe/2026-01-01-x" }), /alert-only vendor/],
      [
        event({ replacement: { targets: [{ type: "model-id", values: ["gpt-4.1", "gpt-4o"] }] } }),
        /several replacements/,
      ],
      [event({ replacement: undefined }), /no replacement/],
      [
        event({
          replacement: {
            targets: [{ type: "model-id", values: ['gpt-4.1" + require("child_process")'] }],
          },
        }),
        /not a plain identifier/,
      ],
      [
        event({
          replacement: { targets: [{ type: "model-id", values: ["https://evil.example/model"] }] },
        }),
        /not a plain identifier/,
      ],
      [
        event({ replacement: { targets: [{ type: "model-id", values: ["../../etc/passwd"] }] } }),
        /not a plain identifier/,
      ],
    ];
    for (const [e, reason] of cases) {
      const { plans, unfixable } = plan([finding(e, "src/ai.ts", 1)], files);
      expect(plans, e.id).toEqual([]);
      expect(unfixable[0]?.reason).toMatch(reason);
    }
  });

  it("abuse: payments, auth and crypto files stay alert-only, by path or by content", () => {
    const e = event();
    const files = {
      "src/payments/summary.ts": 'm = "gpt-4-0613"',
      "src/auth/describe.ts": 'm = "gpt-4-0613"',
      "src/util/sign.ts": 'import jwt from "jsonwebtoken";\nm = "gpt-4-0613"',
      "src/util/hash.py": 'import hashlib\nm = "gpt-4-0613"',
    };
    const { plans, unfixable } = plan(
      [
        finding(e, "src/payments/summary.ts", 1),
        finding(e, "src/auth/describe.ts", 1),
        finding(e, "src/util/sign.ts", 2),
        finding(e, "src/util/hash.py", 2),
      ],
      files,
    );
    expect(plans).toEqual([]);
    expect(unfixable[0]?.reason).toMatch(/payments, authentication, cryptography or CI/);
    expect(isSensitive("src/ai/summarise.ts", 'model: "gpt-4.1"')).toBe(false);
    for (const path of [
      "src/paymentService.ts",
      "src/stripeClient.ts",
      "app/OAuthCallback.tsx",
      "src/authMiddleware.ts",
      "src/PaymentProcessor.java",
      "lib/billingHelpers.ts",
      "web/checkoutFlow.ts",
      "src/signin.ts",
      "src/apiKeys.ts",
      ".github/workflows/ai.yml",
      ".gitlab-ci.yml",
    ]) {
      expect(isSensitive(path, ""), path).toBe(true);
    }
    for (const content of [
      "import Stripe from 'stripe'",
      "const s = new Stripe(key)",
      "import { createHash } from 'node:crypto'",
      'import "crypto/sha256"',
      "MessageDigest.getInstance(x)",
    ]) {
      expect(isSensitive("src/ai/summarise.ts", content), content).toBe(true);
    }
  });

  it("abuse: a finding whose token is not exactly the retired identifier is left alone", () => {
    const e = event();
    const { plans } = plan([finding(e, "src/ai.ts", 1, { token: "gpt-4-0613-preview" })], {
      "src/ai.ts": 'x = "gpt-4-0613-preview"',
    });
    expect(plans).toEqual([]);
  });
});

describe("applyFixes", () => {
  const repo = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "fix-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const edit = {
    path: "src/ai.ts",
    line: 2,
    before: '  model: "gpt-4-0613",',
    after: '  model: "gpt-4.1",',
  };
  const planFor = (edits: (typeof edit)[]) => [
    { event: event(), from: "gpt-4-0613", to: "gpt-4.1", edits, skipped: [] },
  ];

  it("writes only the planned lines and keeps line endings", () => {
    const root = repo({ "src/ai.ts": 'create({\r\n  model: "gpt-4-0613",\r\n});\r\n' });
    expect(applyFixes(root, planFor([edit]))).toEqual({ written: ["src/ai.ts"], conflicts: [] });
    expect(readFileSync(join(root, "src/ai.ts"), "utf8")).toBe(
      'create({\r\n  model: "gpt-4.1",\r\n});\r\n',
    );
    const mixed = repo({ "src/ai.ts": 'create({\n  model: "gpt-4-0613",\r\n});\n' });
    applyFixes(mixed, planFor([edit]));
    expect(readFileSync(join(mixed, "src/ai.ts"), "utf8")).toBe(
      'create({\n  model: "gpt-4.1",\r\n});\n',
    );
  });

  it("abuse: a file that is not UTF-8 is never rewritten", () => {
    const root = repo({});
    mkdirSync(join(root, "src"), { recursive: true });
    const latin1 = Buffer.concat([
      Buffer.from('create({\n  model: "gpt-4-0613",\n}); // caf'),
      Buffer.from([0xe9, 0x0a]),
    ]);
    writeFileSync(join(root, "src/ai.ts"), latin1);
    expect(applyFixes(root, planFor([edit])).conflicts).toEqual(["src/ai.ts"]);
    expect(readFileSync(join(root, "src/ai.ts")).equals(latin1)).toBe(true);
  });

  it("abuse: files changed since the scan, paths outside the root and symlinks are left alone", () => {
    const root = repo({
      "src/ai.ts": 'create({\n  model: "gpt-4-turbo",\n});\n',
      "outside/target.ts": 'x\n  model: "gpt-4-0613",\n',
    });
    expect(applyFixes(root, planFor([edit])).conflicts).toEqual(["src/ai.ts"]);
    expect(applyFixes(root, planFor([{ ...edit, path: "../../etc/passwd" }])).conflicts).toEqual([
      "../../etc/passwd",
    ]);
    let linked = true;
    try {
      symlinkSync(join(root, "outside", "target.ts"), join(root, "src", "link.ts"), "file");
    } catch {
      linked = false;
    }
    if (linked)
      expect(applyFixes(root, planFor([{ ...edit, path: "src/link.ts" }])).conflicts).toEqual([
        "src/link.ts",
      ]);
    expect(readFileSync(join(root, "outside/target.ts"), "utf8")).toContain("gpt-4-0613");
  });
});
