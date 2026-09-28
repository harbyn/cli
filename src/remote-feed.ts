import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FeedVerificationError, type TrustedKeys, verifyFeed } from "./feed/index.ts";
import type { FeedIndex } from "./schema/index.ts";
import { CLI_NAME } from "./product.ts";

export const PRODUCTION_KEYS: TrustedKeys = {
  "78e488880f4fca98": "MCowBQYDK2VwAyEAae5XSWv2jl/tO6akP1MXv1FdrCpGhWa3x3D9y1aktsM=",
};
export const DEFAULT_FEED_URL = "https://feed.harbyn.com/v1/feed.json";

const MAX_FEED_BYTES = 20 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
const TIMEOUT_MS = 20_000;

export type Download = (url: string, maxBytes: number) => Promise<Uint8Array>;

export const httpsDownload: Download = async (url, maxBytes) => {
  if (!url.startsWith("https://"))
    throw new FeedVerificationError("the feed is only ever downloaded over https");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok || !response.body)
    throw new FeedVerificationError(`feed download failed with status ${response.status}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new FeedVerificationError("feed download exceeds the size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export const defaultCacheDir = (): string =>
  join(
    process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    CLI_NAME,
  );

export interface FeedOptions {
  url?: string;
  trustedKeys?: TrustedKeys;
  cacheDir?: string;
  offline?: boolean;
  now?: Date;
  download?: Download;
}

export interface LoadedRemoteFeed {
  feed: FeedIndex;
  origin: "network" | "cache";
  warning?: string;
}

const readCache = (dir: string): { bytes: Uint8Array; envelope: unknown } | undefined => {
  try {
    return {
      bytes: readFileSync(join(dir, "feed.json")),
      envelope: JSON.parse(readFileSync(join(dir, "feed.json.sig"), "utf8")),
    };
  } catch {
    return undefined;
  }
};

const writeCache = (dir: string, bytes: Uint8Array, signature: Uint8Array): void => {
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of [
    ["feed.json", bytes],
    ["feed.json.sig", signature],
  ] as const) {
    writeFileSync(join(dir, `${name}.tmp`), data);
    renameSync(join(dir, `${name}.tmp`), join(dir, name));
  }
};

export const loadRemoteFeed = async (options: FeedOptions = {}): Promise<LoadedRemoteFeed> => {
  const trustedKeys = options.trustedKeys ?? PRODUCTION_KEYS;
  if (Object.keys(trustedKeys).length === 0) {
    throw new FeedVerificationError(
      "no trusted feed keys are pinned in this build; use --feed-dir for local development",
    );
  }
  const url = options.url ?? DEFAULT_FEED_URL;
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const now = options.now ?? new Date();
  const download = options.download ?? httpsDownload;

  let cached: FeedIndex | undefined;
  const onDisk = existsSync(cacheDir) ? readCache(cacheDir) : undefined;
  if (onDisk) {
    try {
      cached = verifyFeed(onDisk.bytes, onDisk.envelope, trustedKeys, { now });
    } catch {
      cached = undefined;
    }
  }

  if (options.offline) {
    if (!cached)
      throw new FeedVerificationError(
        "offline mode needs a valid cached feed; run once online first (cached feeds expire)",
      );
    return { feed: cached, origin: "cache" };
  }

  try {
    const bytes = await download(url, MAX_FEED_BYTES);
    const signature = await download(`${url}.sig`, MAX_SIGNATURE_BYTES);
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder().decode(signature));
    } catch {
      throw new FeedVerificationError("malformed signature envelope");
    }
    const feed = verifyFeed(
      bytes,
      envelope,
      trustedKeys,
      cached ? { now, notOlderThan: cached.generatedAt } : { now },
    );
    writeCache(cacheDir, bytes, signature);
    return { feed, origin: "network" };
  } catch (error) {
    if (error instanceof FeedVerificationError && !/download failed|size limit/.test(error.message))
      throw error;
    if (!cached)
      throw new FeedVerificationError(
        `could not download the feed and no valid cache exists (${(error as Error).message})`,
      );
    return {
      feed: cached,
      origin: "cache",
      warning: `could not reach the feed (${(error as Error).message}); using the cached copy from ${cached.generatedAt}`,
    };
  }
};
