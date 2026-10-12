import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustedKeys } from "../feed/index.ts";
import type { EngineKnowledge, FeedIndex } from "../schema/index.ts";
import { type EngineEdit, type EngineModule, loadEngine } from "../engine.ts";
import { CLI_NAME } from "../product.ts";
import { Confirmations } from "./confirm.ts";
import { getFeed } from "../feed-source.ts";
import { scan } from "../index.ts";
import { configDir, readToken, whoami } from "../login.ts";
import { type Download, defaultCacheDir, loadRemoteFeed } from "../remote-feed.ts";
import type { ScanResult } from "../report.ts";
import type { Fetch } from "../upload.ts";
import { checkRoot } from "./paths.ts";

const FEED_TTL_MS = 15 * 60_000;
const SCAN_REUSE_MS = 60_000;
const ACCOUNT_TTL_MS = 5 * 60_000;
const ROOT_WAIT_MS = 15_000;
export const PLAN_TTL_MS = 30 * 60_000;
const MAX_PLANS = 100;

export interface McpOptions {
  feedDir?: string;
  offline?: boolean;
  fetch: Fetch;
  download?: Download;
  configDir?: string;
  cacheDir?: string;
  feedKeys?: TrustedKeys;
  engineKeys?: TrustedKeys;
  importer?: (url: string) => Promise<unknown>;
  now?: () => Date;
  home?: string;
  fallbackRoot?: string;
  onWarning?: (message: string) => void;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  execPath?: string;
  checksTimeoutMs?: number;
}

export interface StoredPlan {
  planId: string;
  at: number;
  eventId: string;
  tier: "free" | "paid";
  mode: "recipe" | "swap" | "model-needed" | "alert-only" | "not-reviewed";
  free: {
    locations: Array<{
      path: string;
      line: number;
      token: string;
      editable: boolean;
      alertOnly: boolean;
    }>;
    replacement: string[];
    guidance: string;
  };
  edits: EngineEdit[];
  files: Record<string, string>;
  recipeId: string | null;
  engineSha256: string | null;
  evidence: { source: string; reviewState: string; feedGeneratedAt: string; harbynUrl: string };
  applied: boolean;
}

export type PaidEngine =
  | {
      ok: true;
      engine: EngineModule & Required<Pick<EngineModule, "plan" | "apply" | "validateEdits">>;
      knowledge: EngineKnowledge;
      sha256: string;
    }
  | { ok: false; note: string };

export type RootState = { ok: true; root: string } | { ok: false; reason: string };

export interface Account {
  signedIn: boolean;
  plan: string | null;
  fixes: boolean;
}

export type EngineState =
  | { ok: true; engine: EngineModule; knowledge: EngineKnowledge; sha256: string }
  | { ok: false; message: string };

export class McpContext {
  readonly options: McpOptions;
  private rootState: Promise<RootState>;
  private settleRoot: (state: RootState) => void = () => undefined;
  private rootSettled = false;
  private rootTimer: ReturnType<typeof setTimeout> | undefined;
  private feedCache:
    { feed: FeedIndex; at: number; origin: "network" | "cache" | "local" } | undefined;
  private lastScan: { result: ScanResult; at: number; feed: FeedIndex } | undefined;
  private accountCache: { account: Account; at: number } | undefined;
  private engineState: EngineState | undefined;
  private readonly plans = new Map<string, StoredPlan>();
  readonly confirmations: Confirmations;
  readonly written = new Map<string, string>();

  constructor(options: McpOptions) {
    this.options = options;
    this.rootState = new Promise((resolve) => {
      this.settleRoot = resolve;
    });
    this.confirmations = new Confirmations(() => this.now().getTime());
  }

  env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  cacheDir(): string {
    return this.options.cacheDir ?? defaultCacheDir();
  }

  remember(plan: Omit<StoredPlan, "at" | "applied">): StoredPlan {
    const at = this.now().getTime();
    for (const [id, p] of this.plans) if (at - p.at > PLAN_TTL_MS) this.plans.delete(id);
    while (this.plans.size >= MAX_PLANS)
      this.plans.delete(this.plans.keys().next().value as string);
    const stored = { ...plan, at, applied: false };
    this.plans.set(plan.planId, stored);
    return stored;
  }

  plan(planId: string): StoredPlan | undefined {
    const p = this.plans.get(planId);
    if (p && this.now().getTime() - p.at > PLAN_TTL_MS) {
      this.plans.delete(planId);
      return undefined;
    }
    return p;
  }

  async paid(options: { fresh?: boolean } = {}): Promise<PaidEngine> {
    const account = await this.account(options);
    if (!account.signedIn)
      return {
        ok: false,
        note: "Free plan: not signed in. With Harbyn Pro or Team, the person runs harbyn login in a terminal.",
      };
    if (!account.fixes)
      return {
        ok: false,
        note: "Free plan: this sign-in's plan does not include fixes (Harbyn Pro or Team).",
      };
    const loaded = await this.engine();
    if (!loaded.ok)
      return {
        ok: false,
        note: `Free plan: the paid engine is not available (${loaded.message}).`,
      };
    const e = loaded.engine;
    if (
      typeof e.plan !== "function" ||
      typeof e.apply !== "function" ||
      typeof e.validateEdits !== "function"
    ) {
      return {
        ok: false,
        note: `Free plan: this engine cannot plan or apply fixes from here: update the CLI (npx ${CLI_NAME}@latest).`,
      };
    }
    return {
      ok: true,
      engine: e as PaidEngine extends { ok: true; engine: infer E } ? E : never,
      knowledge: loaded.knowledge,
      sha256: loaded.sha256,
    };
  }

  now(): Date {
    return this.options.now?.() ?? new Date();
  }

  setRoot(candidate: string): void {
    if (this.rootSettled) return;
    this.rootSettled = true;
    if (this.rootTimer) clearTimeout(this.rootTimer);
    this.settleRoot(checkRoot(candidate, this.options.home));
  }

  root(): Promise<RootState> {
    if (!this.rootSettled && !this.rootTimer && this.options.fallbackRoot) {
      const fallback = this.options.fallbackRoot;
      this.rootTimer = setTimeout(() => this.setRoot(fallback), ROOT_WAIT_MS);
      this.rootTimer.unref?.();
    }
    return this.rootState;
  }

  async feed(): Promise<{ feed: FeedIndex; origin: "network" | "cache" | "local" }> {
    const at = this.now().getTime();
    if (
      this.feedCache &&
      at - this.feedCache.at < FEED_TTL_MS &&
      Date.parse(this.feedCache.feed.expiresAt) > at
    )
      return this.feedCache;
    const now = this.now();
    if (this.options.feedDir) {
      const feed = await getFeed({ now, feedDir: this.options.feedDir });
      this.feedCache = { feed, at, origin: "local" };
      return this.feedCache;
    }
    const remote = await loadRemoteFeed({
      now,
      offline: this.options.offline === true,
      ...(this.options.download ? { download: this.options.download } : {}),
      ...(this.options.cacheDir ? { cacheDir: this.options.cacheDir } : {}),
      ...(this.options.feedKeys ? { trustedKeys: this.options.feedKeys } : {}),
    });
    if (remote.warning) this.options.onWarning?.(remote.warning);
    this.feedCache = { feed: remote.feed, at, origin: remote.origin };
    return this.feedCache;
  }

  async scan(root: string): Promise<{ result: ScanResult; feed: FeedIndex }> {
    const { feed } = await this.feed();
    const result = scan(root, feed);
    this.lastScan = { result, at: this.now().getTime(), feed };
    return { result, feed };
  }

  async recentScan(root: string): Promise<{ result: ScanResult; feed: FeedIndex }> {
    if (this.lastScan && this.now().getTime() - this.lastScan.at < SCAN_REUSE_MS)
      return this.lastScan;
    return this.scan(root);
  }

  async account(options: { fresh?: boolean } = {}): Promise<Account> {
    const at = this.now().getTime();
    if (!options.fresh && this.accountCache && at - this.accountCache.at < ACCOUNT_TTL_MS)
      return this.accountCache.account;
    const token = readToken(this.options.configDir ?? configDir());
    let account: Account = { signedIn: false, plan: null, fixes: false };
    if (token) {
      const who = await whoami(this.options.fetch, token).catch(() => undefined);
      account = { signedIn: true, plan: who?.plan || null, fixes: who?.fixes === true };
    }
    this.accountCache = { account, at };
    return account;
  }

  async engine(): Promise<EngineState> {
    if (this.engineState?.ok) return this.engineState;
    const token = readToken(this.options.configDir ?? configDir());
    if (!token) return { ok: false, message: "not signed in" };
    const loaded = await loadEngine({
      auth: { kind: "cli", token },
      dir: tmpdir(),
      fetch: this.options.fetch,
      cacheDir: join(this.options.cacheDir ?? defaultCacheDir(), "engine"),
      now: this.now(),
      ...(this.options.download ? { download: this.options.download } : {}),
      ...(this.options.engineKeys ? { trustedKeys: this.options.engineKeys } : {}),
      ...(this.options.importer ? { importer: this.options.importer } : {}),
    });
    this.engineState = loaded.ok
      ? {
          ok: true,
          engine: loaded.engine,
          knowledge: loaded.knowledge,
          sha256: loaded.engineSha256,
        }
      : { ok: false, message: loaded.message };
    return this.engineState;
  }

  loadedEngine(): string | null {
    return this.engineState?.ok ? this.engineState.sha256 : null;
  }

  feedState(): { generatedAt: string; expiresAt: string; origin: string } | undefined {
    return this.feedCache
      ? {
          generatedAt: this.feedCache.feed.generatedAt,
          expiresAt: this.feedCache.feed.expiresAt,
          origin: this.feedCache.origin,
        }
      : undefined;
  }
}
