import type { ChangeEvent, Vendor } from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import type { FixPlan } from "../src/fix.ts";
import {
  branchFor,
  editedText,
  GITHUB_API,
  openPullRequests,
  pullRequestFor,
} from "../src/pulls.ts";

const event = (
  id = "openai/2026-01-01-gpt-4-0613-retirement",
  over: Partial<ChangeEvent> = {},
): ChangeEvent =>
  ({
    id,
    vendor: "openai",
    title: "OpenAI: gpt-4-0613 retirement",
    summary: "gpt-4-0613 stops responding.",
    effectiveAt: "2026-06-01",
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
const vendors = new Map<string, Vendor>([["openai", { id: "openai", name: "OpenAI" } as Vendor]]);
const plan = (id?: string, over: Partial<ChangeEvent> = {}): FixPlan => ({
  event: event(id, over),
  from: "gpt-4-0613",
  to: "gpt-4.1",
  edits: [
    { path: "src/ai.ts", line: 2, before: '  model: "gpt-4-0613",', after: '  model: "gpt-4.1",' },
  ],
  skipped: [{ path: "test/ai.test.ts", line: 4, reason: "test file" }],
});
const FILE = 'create({\n  model: "gpt-4-0613",\r\n});\n';
const SHA = "b".repeat(40);

const fakeGithub = (
  o: {
    pulls?: Array<{ state: string; html_url: string }>;
    listStatus?: number;
    branchAt?: string;
    file?: Buffer;
  } = {},
) => {
  const calls: Array<{
    method: string;
    url: string;
    body?: Record<string, unknown>;
    auth: string | null;
  }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({
      method,
      url,
      ...(body ? { body } : {}),
      auth: new Headers(init.headers).get("authorization"),
    });
    const path = url.replace(`${GITHUB_API}/repos/acme/shop`, "");
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && path === "") return json(200, { default_branch: "main" });
    if (method === "GET" && path.startsWith("/pulls?"))
      return json(
        o.listStatus ?? 200,
        o.listStatus && o.listStatus !== 200 ? { message: "rate limited" } : (o.pulls ?? []),
      );
    if (method === "GET" && path.startsWith("/contents/src/ai.ts?ref="))
      return json(200, {
        sha: "c".repeat(40),
        encoding: "base64",
        content: (o.file ?? Buffer.from(FILE)).toString("base64"),
      });
    if (method === "POST" && path === "/git/refs") return json(o.branchAt ? 422 : 201, {});
    if (method === "GET" && path.startsWith("/git/ref/heads/"))
      return json(200, { object: { sha: o.branchAt } });
    if (method === "PUT" && path.startsWith("/contents/")) return json(200, {});
    if (method === "POST" && path === "/pulls")
      return json(201, { html_url: "https://github.com/acme/shop/pull/8" });
    return json(404, {});
  };
  return { fetch, calls };
};
const ctx = (
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  over: Record<string, unknown> = {},
) => ({
  repository: "acme/shop",
  sha: SHA,
  ref: "refs/heads/main",
  token: "ghs_job_token",
  vendors,
  fetch,
  ...over,
});

describe("remediation pull requests", () => {
  it("reads the file at the scanned commit, commits only the swap, and opens one pull request", async () => {
    const gh = fakeGithub();
    const out = await openPullRequests([plan()], ctx(gh.fetch));
    expect(out).toEqual([
      {
        eventId: "openai/2026-01-01-gpt-4-0613-retirement",
        status: "opened",
        url: "https://github.com/acme/shop/pull/8",
      },
    ]);
    expect(gh.calls.find((c) => c.url.includes("/contents/src/ai.ts?ref="))?.url).toContain(
      `ref=${SHA}`,
    );
    const ref = gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/git/refs"));
    expect(ref?.body).toEqual({
      ref: `refs/heads/${branchFor("openai/2026-01-01-gpt-4-0613-retirement")}`,
      sha: SHA,
    });
    const put = gh.calls.find((c) => c.method === "PUT");
    expect(Buffer.from(String(put?.body?.content), "base64").toString("utf8")).toBe(
      'create({\n  model: "gpt-4.1",\r\n});\n',
    );
    expect(
      gh.calls.every(
        (c) =>
          c.url.startsWith(`${GITHUB_API}/repos/acme/shop`) && c.auth === "Bearer ghs_job_token",
      ),
    ).toBe(true);
    expect(
      gh.calls.some(
        (c) =>
          c.method === "PATCH" ||
          c.url.includes("/merge") ||
          JSON.stringify(c.body ?? {}).includes('"force"'),
      ),
    ).toBe(false);
  });

  it("leaves an open pull request alone and never reopens a closed one", async () => {
    const open = await openPullRequests(
      [plan()],
      ctx(
        fakeGithub({ pulls: [{ state: "open", html_url: "https://github.com/acme/shop/pull/7" }] })
          .fetch,
      ),
    );
    expect(open[0]).toMatchObject({ status: "exists", url: "https://github.com/acme/shop/pull/7" });
    const gh = fakeGithub({
      pulls: [{ state: "closed", html_url: "https://github.com/acme/shop/pull/6" }],
    });
    expect((await openPullRequests([plan()], ctx(gh.fetch)))[0]?.status).toBe("declined");
    expect(gh.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("abuse: a failed pull request listing, a foreign leftover branch, a non-UTF-8 file or a changed file create nothing", async () => {
    for (const [options, message] of [
      [{ listStatus: 403 }, /could not list pull requests/],
      [
        { file: Buffer.from('create({\n  model: "gpt-4-0613", // caf\xe9\n});\n', "latin1") },
        /not UTF-8 or does not match/,
      ],
      [{ file: Buffer.from('create({\n  model: "gpt-4o",\n});\n') }, /not UTF-8 or does not match/],
    ] as const) {
      const gh = fakeGithub(options);
      const out = await openPullRequests([plan()], ctx(gh.fetch));
      expect(out[0]?.status).toBe("failed");
      expect(out[0]?.message).toMatch(message);
      expect(gh.calls.some((c) => c.method === "POST" || c.method === "PUT")).toBe(false);
    }
    const foreign = fakeGithub({ branchAt: "d".repeat(40) });
    expect((await openPullRequests([plan()], ctx(foreign.fetch)))[0]?.message).toMatch(
      /already exists: delete it/,
    );
    expect(foreign.calls.some((c) => c.method === "PUT")).toBe(false);
    const leftover = fakeGithub({ branchAt: SHA });
    expect((await openPullRequests([plan()], ctx(leftover.fetch)))[0]?.status).toBe("opened");
  });

  it("abuse: refuses to run off the default branch or with a bad repository or sha", async () => {
    await expect(
      openPullRequests([plan()], ctx(fakeGithub().fetch, { ref: "refs/heads/feature" })),
    ).rejects.toThrow(/only on the default branch/);
    await expect(
      openPullRequests([plan()], ctx(fakeGithub().fetch, { repository: "acme/shop/../../other" })),
    ).rejects.toThrow(/unexpected/);
    await expect(
      openPullRequests([plan()], ctx(fakeGithub().fetch, { sha: "HEAD" })),
    ).rejects.toThrow(/unexpected/);
  });

  it("opens at most three per run", async () => {
    const out = await openPullRequests(
      ["a", "b", "c", "d"].map((x) => plan(`openai/2026-01-01-${x}`)),
      ctx(fakeGithub().fetch),
    );
    expect(out.filter((o) => o.status === "opened")).toHaveLength(3);
  });
});

describe("pull request text", () => {
  it("cites the vendor, lists every change and what was left alone, and cannot be broken by code with backticks", () => {
    const p = plan();
    p.edits[0] = {
      ...p.edits[0],
      before: "const m = `gpt-4-0613` ``` </details>",
      after: "const m = `gpt-4.1` ``` </details>",
    } as FixPlan["edits"][number];
    const { title, body } = pullRequestFor(p, vendors);
    expect(title).toBe("Harbyn: replace gpt-4-0613 with gpt-4.1 (OpenAI, 2026-06-01)");
    expect(body).toContain("https://platform.openai.com/docs/deprecations");
    expect(body).toContain("````\n- const m = `gpt-4-0613` ``` </details>");
    expect(body).toContain("test file");
    expect(body).toContain("Harbyn will not open it again");
  });

  it("abuse: feed text cannot mention people, autolink, or smuggle a markdown link through the source URL", () => {
    const hostile = plan(undefined, {
      title: "OpenAI: ping @acme/security-team now",
      summary: "See https://evil.example/login for details",
      sources: [
        {
          url: "https://platform.openai.com/x/[Fix_now](https://evil.example/p)",
          kind: "docs",
          fetchedAt: "2026-01-02T00:00:00Z",
          sha256: "a".repeat(64),
        },
      ],
    });
    const { body } = pullRequestFor(hostile, vendors);
    expect(body).not.toMatch(/@acme/);
    expect(body).not.toContain("https://evil.example");
    expect(body).not.toContain("[Fix_now]");
  });

  it("editedText keeps line endings and refuses a file that no longer matches the plan", () => {
    expect(editedText(FILE, plan(), "src/ai.ts")).toBe('create({\n  model: "gpt-4.1",\r\n});\n');
    expect(editedText("other\ncontent\n", plan(), "src/ai.ts")).toBeUndefined();
  });
});
