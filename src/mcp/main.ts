import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ServerSpec, serveStdio, type StdioClient } from "../mcp-protocol/index.ts";
import { config } from "zod";
import { CLI_NAME, CLI_VERSION } from "../product.ts";
import { McpContext, type McpOptions } from "./context.ts";
import { DATA_RULE, mcpTools } from "./tools.ts";

export const MCP_USAGE = `usage: ${CLI_NAME} mcp [--root <dir>] [--offline]

Starts Harbyn's local MCP server on stdin and stdout, for your coding agent. Add it once:
  claude mcp add harbyn-local -- npx -y ${CLI_NAME} mcp

  --root <dir>      the repository to work in (default: your client's root, else the current directory)
  --offline         use the cached feed only, make no feed request
  --feed-dir <dir>  development: read an unsigned feed from a local directory

It scans, explains and plans fixes. apply_fix changes files in the working tree (with Harbyn Pro or Team),
run_checks runs your project's own typecheck or test command, and open_pr opens a draft pull request with your own
git and gh, each only after you confirm. Nothing about your code reaches Harbyn.`;

export const INSTRUCTIONS = `Harbyn finds where the code in this repository will break when a vendor retires or changes a model, an API version, an endpoint, an SDK or a runtime, from Harbyn's signed change feed. It runs on this machine and sends no code to Harbyn. Use scan for the findings (file, line, deadline, replacement), explain for one change, plan_fix for what to change and how, apply_fix to apply a plan, run_checks to run the project's own typecheck or tests, open_pr to open a draft pull request with what apply_fix wrote, status for the sign-in and the feed. scan, explain, plan_fix and status only read. apply_fix, run_checks and open_pr act only after the person confirms: never confirm for them, never invent or reuse a confirmation token, and never ask them to auto-approve these three tools. On the free plan apply_fix writes nothing: make the edit with your own tools after the person agrees, and they commit it. Never edit payments, authentication, cryptography or CI code: plan_fix marks it alert-only. After a change, run the checks and call scan again. ${DATA_RULE}`;

export const localServer = (ctx: McpContext): ServerSpec => ({
  name: "com.harbyn/cli",
  title: "Harbyn (local)",
  version: CLI_VERSION,
  websiteUrl: "https://harbyn.com/docs#local-mcp",
  instructions: INSTRUCTIONS,
  tools: mcpTools(ctx),
});

export const clientRoot = async (client: StdioClient): Promise<string | undefined> => {
  if (typeof client.capabilities.roots !== "object" || client.capabilities.roots === null)
    return undefined;
  const answer = (await client.request("roots/list")) as { roots?: unknown } | null;
  const roots = Array.isArray(answer?.roots) ? answer.roots : [];
  const files = roots.flatMap((r) => {
    const uri = (r as { uri?: unknown } | null)?.uri;
    return typeof uri === "string" && uri.startsWith("file://") && uri.length <= 4096 ? [uri] : [];
  });
  if (files.length !== 1) return undefined;
  try {
    return fileURLToPath(files[0] as string);
  } catch {
    return undefined;
  }
};

export interface McpIo {
  input: AsyncIterable<string | Uint8Array>;
  write: (line: string) => void;
  error: (line: string) => void;
  cwd: string;
}

export const runMcp = async (
  argv: readonly string[],
  io?: Partial<McpIo>,
  overrides: Partial<McpOptions> = {},
): Promise<number> => {
  config({ jitless: true });
  const stdio: McpIo = {
    input: io?.input ?? process.stdin,
    write: io?.write ?? ((line) => void process.stdout.write(`${line}\n`)),
    error: io?.error ?? ((line) => void process.stderr.write(`${line}\n`)),
    cwd: io?.cwd ?? process.cwd(),
  };
  const known = new Set(["--root", "--offline", "--feed-dir", "--help", "-h"]);
  const valueOf = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const unknown = argv.filter(
    (a, i) => !known.has(a) && argv[i - 1] !== "--root" && argv[i - 1] !== "--feed-dir",
  );
  if (argv.includes("--help") || argv.includes("-h")) {
    stdio.error(MCP_USAGE);
    return 0;
  }
  if (
    unknown.length > 0 ||
    (argv.includes("--root") && !valueOf("--root")) ||
    (argv.includes("--feed-dir") && !valueOf("--feed-dir"))
  ) {
    stdio.error(MCP_USAGE);
    return 2;
  }
  const rootArg = valueOf("--root");
  const feedDir = valueOf("--feed-dir");
  const ctx = new McpContext({
    fetch: (url, init) => fetch(url, init),
    offline: argv.includes("--offline"),
    fallbackRoot: stdio.cwd,
    ...(feedDir ? { feedDir: resolve(stdio.cwd, feedDir), unsignedFeed: true } : {}),
    onWarning: (message) => stdio.error(`warning: ${message}`),
    ...overrides,
  });
  if (rootArg) ctx.setRoot(resolve(stdio.cwd, rootArg));
  await serveStdio({
    spec: localServer(ctx),
    input: stdio.input,
    write: stdio.write,
    onError: () => stdio.error(`${CLI_NAME} mcp: internal error`),
    onInitialized: (client) => {
      if (rootArg) return;
      clientRoot(client)
        .catch(() => undefined)
        .then((root) => ctx.setRoot(root ?? stdio.cwd));
    },
  });
  ctx.setRoot(stdio.cwd);
  return 0;
};
