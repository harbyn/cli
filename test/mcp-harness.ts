import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEngineRelease,
  keyIdOf,
  publicKeyBase64,
  signEngineRelease,
} from "../src/feed/index.ts";
import type { ToolSession } from "../src/mcp-protocol/index.ts";
import { CLI_ENGINE_URL, ENGINE_RELEASE_URL } from "../src/engine.ts";
import { CLI_API } from "../src/login.ts";
import { McpContext, type McpOptions } from "../src/mcp/context.ts";
import { localServer } from "../src/mcp/main.ts";
import { feedDir, repo } from "./mcp-fixtures.ts";

export const TODAY = "2026-10-11";
export const NOW = new Date("2026-10-11T12:00:00Z");
const ALLOWED_HOSTS = new Set(["feed.harbyn.com", "api.harbyn.com"]);

export interface Net {
  urls: string[];
  fetch: McpOptions["fetch"];
  download: NonNullable<McpOptions["download"]>;
}

export const net = (
  answers: {
    whoami?: unknown;
    engine?: () => Response;
    downloads?: Record<string, Uint8Array>;
  } = {},
): Net => {
  const urls: string[] = [];
  const allow = (url: string) => {
    urls.push(url);
    if (!ALLOWED_HOSTS.has(new URL(url).hostname)) throw new Error(`blocked host ${url}`);
  };
  return {
    urls,
    fetch: async (url) => {
      allow(url);
      if (url === `${CLI_API}/whoami`)
        return new Response(JSON.stringify(answers.whoami ?? {}), {
          status: answers.whoami ? 200 : 401,
        });
      if (url === CLI_ENGINE_URL && answers.engine) return answers.engine();
      return new Response("{}", { status: 404 });
    },
    download: async (url) => {
      allow(url);
      const bytes = answers.downloads?.[url];
      if (!bytes) throw new Error(`download failed for ${url}`);
      return bytes;
    },
  };
};

export const signedInDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-"));
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({ token: `hbn_cli_${"a".repeat(43)}`, expiresAt: "2099-01-01T00:00:00Z" }),
  );
  return dir;
};

export const allowTokens = (configDir: string): string => {
  const file = join(configDir, "mcp-settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  if (!("tokenConfirmation" in settings))
    writeFileSync(file, JSON.stringify({ ...settings, tokenConfirmation: true }));
  return configDir;
};

export const setup = (root: string, over: Partial<McpOptions> = {}, n: Net = net()) => {
  const configDir = allowTokens(over.configDir ?? mkdtempSync(join(tmpdir(), "mcp-config-")));
  const ctx = new McpContext({
    feedDir: feedDir(),
    fetch: n.fetch,
    download: n.download,
    configDir,
    cacheDir: mkdtempSync(join(tmpdir(), "mcp-cache-")),
    now: () => NOW,
    ...over,
  });
  ctx.setRoot(root);
  const spec = localServer(ctx);
  const call = async (name: string, args: Record<string, unknown> = {}, session?: ToolSession) => {
    const tool = spec.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.call(args, TODAY, session);
  };
  return { ctx, spec, call, net: n };
};

export const paidEngine = (
  module: unknown,
  opts: {
    whoami?: unknown;
    api?: () => Response;
    tamper?: boolean;
    knowledge?: unknown;
    engineBytes?: Uint8Array;
  } = {},
) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyBase64(publicKey);
  const engine = opts.engineBytes ?? new TextEncoder().encode(`// test engine ${Math.random()}\n`);
  const knowledge = new TextEncoder().encode(
    JSON.stringify(opts.knowledge ?? { schemaVersion: 1, migrations: [] }),
  );
  const release = buildEngineRelease({
    commit: "c".repeat(40),
    engine: opts.tamper ? new TextEncoder().encode("other") : engine,
    knowledge,
    now: NOW,
  });
  const n = net({
    whoami: opts.whoami ?? { email: "person@example.com", plan: "pro", fixes: true },
    engine:
      opts.api ??
      (() =>
        new Response(
          JSON.stringify({
            engine: Buffer.from(engine).toString("base64"),
            knowledge: Buffer.from(knowledge).toString("base64"),
          }),
        )),
    downloads: {
      [ENGINE_RELEASE_URL]: release,
      [`${ENGINE_RELEASE_URL}.sig`]: new TextEncoder().encode(
        JSON.stringify(
          signEngineRelease(
            release,
            privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          ),
        ),
      ),
    },
  });
  return {
    n,
    over: {
      configDir: signedInDir(),
      engineKeys: { [keyIdOf(pub)]: pub },
      importer: async () => module,
    } satisfies Partial<McpOptions>,
    sha: createHash("sha256").update(engine).digest("hex"),
    engine,
    knowledge,
  };
};

const git = (dir: string, ...args: string[]): string => {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

export const gitRepo = (extra: Record<string, string> = {}): string => {
  const dir = repo(extra);
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
};

export const commitAll = (dir: string): void => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "more");
};

export const elicitingSession = (
  answer: unknown,
  capability: Record<string, unknown> = { form: {} },
) => {
  const asked: Array<{ method: string; params: unknown }> = [];
  const session: ToolSession = {
    capabilities: { elicitation: capability },
    request: async (method, params) => {
      asked.push({ method, params });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { session, asked };
};

export const mkdir = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  return dir;
};
