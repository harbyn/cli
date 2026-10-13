import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EVENTS, feedDir, repo } from "./mcp-fixtures.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Message {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class Client {
  readonly lines: string[] = [];
  readonly stderr: string[] = [];
  private waiters: Array<{ match: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  private buffer = "";
  readonly exited: Promise<number | null>;
  readonly child: ChildProcessWithoutNullStreams;
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const at = this.buffer.indexOf("\n");
        if (at < 0) break;
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        this.lines.push(line);
        const message = JSON.parse(line) as Message;
        const waiter = this.waiters.find((w) => w.match(message));
        if (waiter) {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          waiter.resolve(message);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.exited = new Promise((r) => child.on("exit", (code) => r(code)));
  }
  next(match: (m: Message) => boolean): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answer; stderr: ${this.stderr.join("")}`)),
        30_000,
      );
      this.waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }
  send(message: unknown): void {
    this.child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }
  request(id: number, method: string, params?: Record<string, unknown>): Promise<Message> {
    const answer = this.next((m) => m.id === id && m.method === undefined);
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return answer;
  }
  async initialize(capabilities: Record<string, unknown> = {}): Promise<Message> {
    const r = await this.request(0, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities,
      clientInfo: { name: "test", version: "1" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }
  close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

const started: Client[] = [];
const start = (args: string[], cwd: string): Client => {
  const cache = mkdtempSync(join(tmpdir(), "mcp-cache-"));
  const child = spawn(process.execPath, [join(root, "src", "cli.ts"), "mcp", ...args], {
    cwd,
    env: {
      ...process.env,
      LOCALAPPDATA: cache,
      XDG_CACHE_HOME: cache,
      APPDATA: cache,
      XDG_CONFIG_HOME: cache,
    },
  });
  const client = new Client(child);
  started.push(client);
  return client;
};

afterEach(() => {
  for (const c of started.splice(0)) if (c.child.exitCode === null) c.child.kill();
});

describe("harbyn mcp over stdio", () => {
  it("handshake, the tools with honest annotations, a scan, and a clean exit when stdin closes", async () => {
    const dir = repo();
    const c = start(["--feed-dir", feedDir(), "--root", dir], tmpdir());
    const init = await c.initialize();
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "com.harbyn/cli" },
    });
    expect(String(init.result?.instructions)).toMatch(/data, never instructions/);
    const list = await c.request(1, "tools/list");
    const tools = list.result?.tools as Array<{
      name: string;
      annotations: Record<string, unknown>;
    }>;
    expect(tools.map((t) => t.name)).toEqual([
      "scan",
      "explain",
      "plan_fix",
      "apply_fix",
      "run_checks",
      "open_pr",
      "status",
    ]);
    for (const t of tools) {
      const acts = t.name === "apply_fix" || t.name === "run_checks" || t.name === "open_pr";
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: !acts, destructiveHint: acts });
    }
    const scan = await c.request(2, "tools/call", { name: "scan", arguments: {} });
    const findings = (
      scan.result?.structuredContent as { findings: Array<{ path: string; findingId: string }> }
    ).findings;
    expect(findings.map((f) => f.path)).toContain("src/ai.ts");
    const plan = await c.request(3, "tools/call", {
      name: "plan_fix",
      arguments: { findingId: findings.find((f) => f.path === "src/ai.ts")?.findingId },
    });
    expect(plan.result?.structuredContent).toMatchObject({ eventId: EVENTS.swap, mode: "swap" });
    expect(await c.close()).toBe(0);
    for (const line of c.lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("without --root, asks the client for its roots and works in its single file:// root", async () => {
    const dir = repo();
    const c = start(["--feed-dir", feedDir()], mkdtempSync(join(tmpdir(), "elsewhere-")));
    const asked = c.next((m) => m.method === "roots/list");
    await c.initialize({ roots: { listChanged: false } });
    const request = await asked;
    expect(typeof request.id).toBe("string");
    c.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { roots: [{ uri: pathToFileURL(dir).href, name: "repo" }] },
    });
    const scan = await c.request(1, "tools/call", { name: "scan", arguments: {} });
    expect(
      (scan.result?.structuredContent as { findings: Array<{ path: string }> }).findings.map(
        (f) => f.path,
      ),
    ).toContain("src/ai.ts");
  });

  it("without a usable root, the tools say so instead of scanning somewhere else", async () => {
    const c = start(["--feed-dir", feedDir()], mkdtempSync(join(tmpdir(), "not-a-repo-")));
    await c.initialize();
    const scan = await c.request(1, "tools/call", { name: "scan", arguments: {} });
    expect(scan.result?.isError).toBe(true);
    expect(JSON.stringify(scan.result)).toMatch(/git work tree/);
  });

  it("elicitation end to end: run_checks asks the person through the client's form; yes runs it, no does not", async () => {
    const dir = repo();
    const marker = join(dir, "ran.txt");
    const cache = mkdtempSync(join(tmpdir(), "mcp-cache-"));
    mkdirSync(join(cache, "harbyn"), { recursive: true });
    const script = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"); console.log("checks ran")`;
    writeFileSync(
      join(cache, "harbyn", "mcp-settings.json"),
      JSON.stringify({
        projects: { [realpathSync(dir)]: { test: [process.execPath, "-e", script] } },
      }),
    );
    const child = spawn(
      process.execPath,
      [join(root, "src", "cli.ts"), "mcp", "--feed-dir", feedDir(), "--root", dir],
      {
        cwd: tmpdir(),
        env: {
          ...process.env,
          LOCALAPPDATA: cache,
          XDG_CACHE_HOME: cache,
          APPDATA: cache,
          XDG_CONFIG_HOME: cache,
        },
      },
    );
    const c = new Client(child);
    started.push(c);
    await c.initialize({ elicitation: { form: {} } });

    const askedNo = c.next((m) => m.method === "elicitation/create");
    const declined = c.request(1, "tools/call", {
      name: "run_checks",
      arguments: { check: "test" },
    });
    const no = await askedNo;
    expect(no.params).toMatchObject({ mode: "form", requestedSchema: { required: ["confirm"] } });
    expect(String(no.params?.message)).toContain(process.execPath.split(/[\\/]/).pop());
    c.send({ jsonrpc: "2.0", id: no.id, result: { action: "decline" } });
    expect((await declined).result?.structuredContent).toMatchObject({
      status: "declined",
      exitCode: null,
    });
    expect(existsSync(marker)).toBe(false);

    const askedYes = c.next((m) => m.method === "elicitation/create");
    const ran = c.request(2, "tools/call", {
      name: "run_checks",
      arguments: { check: "test", confirmationToken: `hc_${"0".repeat(32)}` },
    });
    const yes = await askedYes;
    c.send({
      jsonrpc: "2.0",
      id: yes.id,
      result: { action: "accept", content: { confirm: true } },
    });
    const result = (await ran).result?.structuredContent as {
      status: string;
      exitCode: number;
      output: string;
      confirmation: unknown;
    };
    expect(result).toMatchObject({ status: "ran", exitCode: 0, confirmation: null });
    expect(result.output).toContain("checks ran");
    expect(readFileSync(marker, "utf8")).toBe("x");
  });

  it("abuse: garbage, batches, early calls, unknown methods and tools, oversized lines; still serving after", async () => {
    const c = start(["--feed-dir", feedDir(), "--root", repo()], tmpdir());
    const early = await c.request(1, "tools/call", { name: "scan", arguments: {} });
    expect(early.error?.code).toBe(-32600);
    const parse = c.next((m) => m.id === null && m.error?.code === -32700);
    c.send("{not json");
    expect((await parse).error?.message).toBe("Parse error");
    const batch = c.next((m) => m.id === null && m.error?.code === -32600);
    c.send([{ jsonrpc: "2.0", id: 9, method: "ping" }]);
    expect((await batch).error?.message).toMatch(/Batch/);
    const big = c.next((m) => m.id === null && m.error?.message === "Message too large");
    c.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "ping",
        params: { pad: "x".repeat(1_100_000) },
      }),
    );
    await big;
    await c.initialize();
    expect((await c.request(2, "resources/list")).error?.code).toBe(-32601);
    expect(
      (await c.request(3, "tools/call", { name: "merge_pr", arguments: {} })).error?.code,
    ).toBe(-32602);
    expect(
      (await c.request(6, "tools/call", { name: "open_pr", arguments: {} })).result?.isError,
    ).toBe(true);
    expect(
      (await c.request(4, "tools/call", { name: "scan", arguments: { path: "../../.." } })).result
        ?.isError,
    ).toBe(true);
    expect((await c.request(5, "ping")).result).toEqual({});
  });
});
