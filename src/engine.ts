import { mkdtempSync, writeFileSync } from "node:fs";
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

export interface EngineModule {
  ENGINE_ABI: number;
  runAction(input: EngineActionInput): Promise<void>;
  runMigrate(
    positional: readonly string[],
    values: (name: string) => string[],
    knowledge: EngineKnowledge,
  ): Promise<number>;
}

export type EngineLoad =
  { ok: true; engine: EngineModule; knowledge: EngineKnowledge } | { ok: false; message: string };

export interface LoadEngineOptions {
  connection: string;
  token: string;
  dir: string;
  fetch: Fetch;
  download?: Download;
  trustedKeys?: TrustedKeys;
  now?: Date;
  importer?: (url: string) => Promise<unknown>;
}

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
  try {
    const res = await options.fetch(ENGINE_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ connection: options.connection }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await readCapped(res, MAX_RESPONSE_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      json = undefined;
    }
    const payload = json as { engine?: unknown; knowledge?: unknown; error?: unknown } | undefined;
    if (!res.ok)
      return {
        ok: false,
        message: displayText(payload?.error) || `the engine request failed (HTTP ${res.status})`,
      };
    if (typeof payload?.engine !== "string" || typeof payload.knowledge !== "string")
      return { ok: false, message: "the engine response is malformed" };
    const engineBytes = Buffer.from(payload.engine, "base64");
    const knowledgeBytes = Buffer.from(payload.knowledge, "base64");

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
    const engine = await (options.importer ?? ((url: string) => import(url)))(
      pathToFileURL(file).href,
    );
    if (!isEngine(engine))
      return {
        ok: false,
        message: "the engine does not match this Action (update the Action to its latest release)",
      };
    return { ok: true, engine, knowledge: knowledge.data };
  } catch (error) {
    const message =
      error instanceof FeedVerificationError
        ? `the engine could not be verified (${error.message})`
        : `the engine could not be loaded (${displayText((error as Error).message)})`;
    return { ok: false, message };
  }
};
