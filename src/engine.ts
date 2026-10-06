import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkEnginePayload,
  FeedVerificationError,
  type TrustedKeys,
  verifyEngineRelease,
} from "./feed/index.ts";
import { type EngineKnowledge, engineKnowledge, type FeedIndex } from "./schema/index.ts";
import type { ScanResult } from "./report.ts";
import { type Download, httpsDownload } from "./remote-feed.ts";
import type { Fetch } from "./upload.ts";

export const ENGINE_ABI = 1;

export const ENGINE_KEYS: TrustedKeys = {
  "2813f379542269f5": "MCowBQYDK2VwAyEAvAc5oM0tUCruFHByBrDd0xPhndNvMI4xgTCgZZzS/mg=",
};

export const ENGINE_URL = "https://api.harbyn.com/ingest/engine";
export const CLI_ENGINE_URL = "https://api.harbyn.com/cli/engine";
export const ENGINE_CACHE_DIR = "harbyn-engine-cache";
export const ENGINE_RELEASE_URL = "https://feed.harbyn.com/v1/engine-release.json";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RELEASE_BYTES = 4096;
const MAX_MESSAGE_CHARS = 300;

export interface EngineActionInput {
  result: ScanResult;
  feed: FeedIndex;
  knowledge: EngineKnowledge;
  target: string;
  githubToken: string;
  llm: { provider: string; model: string; apiKey: string };
  workflowCommand: (kind: "notice" | "warning", title: string, message: string) => string;
  writeOutput: (name: string, value: string) => void;
}

export interface FixReport {
  pullRequests: "allowed" | "blocked" | "unknown";
  opened: number;
}

export interface EngineFixInput {
  result: ScanResult;
  feed: FeedIndex;
  knowledge: EngineKnowledge;
  target: string;
  write: boolean;
  print: (text: string) => void;
}

export interface EngineModule {
  ENGINE_ABI: number;
  runAction(input: EngineActionInput): Promise<FixReport | void>;
  runMigrate(
    positional: readonly string[],
    values: (name: string) => string[],
    knowledge: EngineKnowledge,
  ): Promise<number>;
  runFix?(input: EngineFixInput): Promise<number>;
}

export type EngineLoad =
  | {
      ok: true;
      engine: EngineModule;
      knowledge: EngineKnowledge;
      engineSha256: string;
      fresh: boolean;
    }
  | { ok: false; message: string };

export interface LoadEngineOptions {
  auth: { kind: "ci"; connection: string; token: string } | { kind: "cli"; token: string };
  dir: string;
  fetch: Fetch;
  download?: Download;
  trustedKeys?: TrustedKeys;
  now?: Date;
  importer?: (url: string) => Promise<unknown>;
  cacheDir?: string;
}

const CACHE_ENGINE = "harbyn-engine.mjs";
const CACHE_KNOWLEDGE = "engine-knowledge.json";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const readCache = (dir: string): { engine: Buffer; knowledge: Buffer } | undefined => {
  try {
    const files = [join(dir, CACHE_ENGINE), join(dir, CACHE_KNOWLEDGE)];
    if (!files.every((f) => lstatSync(f).isFile() && lstatSync(f).size <= MAX_RESPONSE_BYTES))
      return undefined;
    return {
      engine: readFileSync(files[0] as string),
      knowledge: readFileSync(files[1] as string),
    };
  } catch {
    return undefined;
  }
};

const displayText = (text: unknown): string =>
  typeof text === "string"
    ? [...text]
        .filter((ch) => {
          const code = ch.codePointAt(0) ?? 0;
          return code >= 0x20 && code <= 0x7e;
        })
        .join("")
        .slice(0, MAX_MESSAGE_CHARS)
    : "";

const readCapped = async (res: Response, max: number): Promise<Uint8Array> => {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new Error("the engine response is over its size limit");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > max) throw new Error("the engine response is over its size limit");
  return bytes;
};

const isEngine = (value: unknown): value is EngineModule => {
  const m = value as Partial<EngineModule> | null;
  return (
    typeof m === "object" &&
    m !== null &&
    m.ENGINE_ABI === ENGINE_ABI &&
    typeof m.runAction === "function" &&
    typeof m.runMigrate === "function"
  );
};

export const loadEngine = async (options: LoadEngineOptions): Promise<EngineLoad> => {
  const trustedKeys = options.trustedKeys ?? ENGINE_KEYS;
  if (Object.keys(trustedKeys).length === 0)
    return {
      ok: false,
      message: "automatic fixes are not available in this release of the Action yet",
    };
  const download = options.download ?? httpsDownload;
  const cache = options.cacheDir ? readCache(options.cacheDir) : undefined;
  const have = cache
    ? { engine: sha256(cache.engine), knowledge: sha256(cache.knowledge) }
    : undefined;
  try {
    const ci = options.auth.kind === "ci";
    const res = await options.fetch(ci ? ENGINE_URL : CLI_ENGINE_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.auth.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        ...(options.auth.kind === "ci" ? { connection: options.auth.connection } : {}),
        ...(have ? { have } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await readCapped(res, MAX_RESPONSE_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      json = undefined;
    }
    const payload = json as
      { engine?: unknown; knowledge?: unknown; cached?: unknown; error?: unknown } | undefined;
    if (!res.ok)
      return {
        ok: false,
        message: displayText(payload?.error) || `the engine request failed (HTTP ${res.status})`,
      };
    const fromCache = payload?.cached === true && cache !== undefined;
    if (
      !fromCache &&
      (typeof payload?.engine !== "string" || typeof payload.knowledge !== "string")
    )
      return { ok: false, message: "the engine response is malformed" };
    const engineBytes = fromCache ? cache.engine : Buffer.from(payload?.engine as string, "base64");
    const knowledgeBytes = fromCache
      ? cache.knowledge
      : Buffer.from(payload?.knowledge as string, "base64");

    const releaseBytes = await download(ENGINE_RELEASE_URL, MAX_RELEASE_BYTES);
    const signature = await download(`${ENGINE_RELEASE_URL}.sig`, MAX_RELEASE_BYTES);
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder().decode(signature));
    } catch {
      throw new FeedVerificationError("malformed engine release signature");
    }
    const release = verifyEngineRelease(releaseBytes, envelope, trustedKeys, {
      now: options.now ?? new Date(),
    });
    checkEnginePayload(release, engineBytes, knowledgeBytes);

    const knowledge = engineKnowledge.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(knowledgeBytes)),
    );
    if (!knowledge.success)
      return { ok: false, message: "the engine knowledge does not match the schema" };

    const file = join(mkdtempSync(join(options.dir, "harbyn-engine-")), "harbyn-engine.mjs");
    writeFileSync(file, engineBytes, { flag: "wx" });
    let engine: unknown;
    try {
      engine = await (options.importer ?? ((url: string) => import(url)))(pathToFileURL(file).href);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
    if (!isEngine(engine))
      return {
        ok: false,
        message: "the engine does not match this Action (update the Action to its latest release)",
      };
    if (!fromCache && options.cacheDir) {
      try {
        mkdirSync(options.cacheDir, { recursive: true });
        for (const [name, bytes] of [
          [CACHE_ENGINE, engineBytes],
          [CACHE_KNOWLEDGE, knowledgeBytes],
        ] as const) {
          const temp = join(options.cacheDir, `.${randomBytes(6).toString("hex")}.tmp`);
          writeFileSync(temp, bytes, { flag: "wx" });
          renameSync(temp, join(options.cacheDir, name));
        }
      } catch {}
    }
    return {
      ok: true,
      engine,
      knowledge: knowledge.data,
      engineSha256: sha256(engineBytes),
      fresh: !fromCache,
    };
  } catch (error) {
    const message =
      error instanceof FeedVerificationError
        ? `the engine could not be verified (${error.message})`
        : `the engine could not be loaded (${displayText((error as Error).message)})`;
    return { ok: false, message };
  }
};
