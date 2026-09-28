import { describe, expect, it } from "vitest";
import { type ChangeEvent, MANIFEST_LIMITS } from "../src/schema/index.ts";
import type { ScanResult } from "../src/report.ts";
import {
  INGEST_URL,
  OIDC_AUDIENCE,
  requestOidcToken,
  toManifest,
  uploadBody,
  uploadManifest,
} from "../src/upload.ts";

const event = (id: string, vendor: string, values: string[]) =>
  ({ id, vendor, affects: [{ type: "model-id", values }] }) as unknown as ChangeEvent;
const retire = event("openai/2026-04-22-gpt-4-retirement", "openai", ["gpt-4", "gpt-4-0613"]);
const version = event("shopify/2026-01-01-api-2025-10-unsupported", "shopify", ["2025-10"]);

const result = {
  findings: [
    {
      event: retire,
      via: "model-id",
      token: "gpt-4",
      path: "src/secret-project/ai.ts",
      line: 12,
      context: "code",
    },
    {
      event: retire,
      via: "model-id",
      token: "gpt-4",
      path: "src/billing/charge.ts",
      line: 3,
      context: "code",
    },
    {
      event: retire,
      via: "model-id",
      token: "gpt-4-turbo-preview-x",
      path: "docs/notes.md",
      line: 1,
      context: "docs",
    },
    {
      event: version,
      via: "api-version",
      token: "2025-10",
      path: "src/shop.ts",
      line: 9,
      context: "test",
    },
  ],
  usage: [{ vendor: { id: "anthropic" }, evidence: new Set(["npm:@anthropic-ai/sdk"]) }],
  stats: { scanned: 57 },
} as unknown as ScanResult;

describe("manifest built by the Action", () => {
  it("groups findings into feed terms and counts, and carries no path, line or matched text beyond feed ids", () => {
    const manifest = toManifest(result, "0.1.0");
    expect(manifest).toEqual({
      version: 1,
      scanner: "0.1.0",
      filesScanned: 57,
      vendors: ["anthropic", "openai", "shopify"],
      findings: [
        {
          eventId: "openai/2026-04-22-gpt-4-retirement",
          via: "model-id",
          context: "docs",
          count: 1,
        },
        {
          eventId: "openai/2026-04-22-gpt-4-retirement",
          identifier: "gpt-4",
          via: "model-id",
          context: "code",
          count: 2,
        },
        {
          eventId: "shopify/2026-01-01-api-2025-10-unsupported",
          identifier: "2025-10",
          via: "api-version",
          context: "test",
          count: 1,
        },
      ],
    });
    const sent = uploadBody("11111111-2222-4333-8444-555555555555", manifest);
    for (const leak of [
      "secret-project",
      "charge.ts",
      "src/",
      "notes.md",
      "turbo-preview",
      '"line"',
      '"path"',
    ])
      expect(sent).not.toContain(leak);
  });

  it("abuse: a repository that overflows the limits gets a clamped manifest, not an error", () => {
    const many = MANIFEST_LIMITS.count + 1;
    const flood = {
      ...result,
      findings: [
        ...Array.from({ length: many }, (_, i) => ({
          event: retire,
          via: "model-id",
          token: "gpt-4",
          path: "a.ts",
          line: i + 1,
          context: "code",
        })),
        ...Array.from({ length: MANIFEST_LIMITS.findings + 5 }, (_, i) => ({
          event: event(`acme/2026-01-01-change-${i}`, "acme", []),
          via: "model-id",
          token: "x",
          path: "b.ts",
          line: i + 1,
          context: "code",
        })),
      ],
    } as unknown as ScanResult;
    const manifest = toManifest(flood, "0.1.0");
    expect(manifest.findings).toHaveLength(MANIFEST_LIMITS.findings);
    const gpt4 = manifest.findings.find((f) => f.identifier === "gpt-4");
    expect(gpt4?.count ?? MANIFEST_LIMITS.count).toBe(MANIFEST_LIMITS.count);
  });
});

describe("upload", () => {
  it("asks the runner for a token with our audience, and explains a missing id-token permission", async () => {
    const seen: string[] = [];
    const token = await requestOidcToken(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/req?api-version=2.0",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-bearer",
      },
      (async (url: string, init: RequestInit) => {
        seen.push(url, String(new Headers(init.headers).get("authorization")));
        return Response.json({ value: "x".repeat(40) });
      }) as never,
    );
    expect(token).toBe("x".repeat(40));
    expect(seen).toEqual([
      `https://token.example/req?api-version=2.0&audience=${encodeURIComponent(OIDC_AUDIENCE)}`,
      "bearer runner-bearer",
    ]);
    await expect(requestOidcToken({}, (async () => Response.json({})) as never)).rejects.toThrow(
      /id-token: write/,
    );
    await expect(
      requestOidcToken(
        {
          ACTIONS_ID_TOKEN_REQUEST_URL: "http://evil.example/?",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
        },
        (async () => Response.json({})) as never,
      ),
    ).rejects.toThrow(/https/);
  });

  it("sends to the fixed endpoint only, and turns refusals and network errors into messages", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const ok = await uploadManifest("{}", "tok", (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get("authorization") });
      return new Response(null, { status: 202 });
    }) as never);
    expect(ok.ok).toBe(true);
    expect(calls).toEqual([{ url: INGEST_URL, auth: "Bearer tok" }]);
    const refused = await uploadManifest("{}", "tok", (async () =>
      Response.json(
        { error: "this token is not for the repository of that connection" },
        { status: 403 },
      )) as never);
    expect(refused).toEqual({
      ok: false,
      message:
        "Harbyn refused the upload (HTTP 403): this token is not for the repository of that connection",
    });
    const down = await uploadManifest("{}", "tok", (async () => {
      throw new Error("ECONNREFUSED");
    }) as never);
    expect(down.ok).toBe(false);
    expect(down.message).toMatch(/could not reach Harbyn/);
  });
});
