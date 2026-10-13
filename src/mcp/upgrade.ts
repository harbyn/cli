import { createHash } from "node:crypto";
import {
  copyFileSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolSession } from "../mcp-protocol/index.ts";
import { z } from "zod";
import type { EngineMigrationComputed, EngineModule, EngineUpgrade } from "../engine.ts";
import { configDir } from "../login.ts";
import { CLI_NAME } from "../product.ts";
import { safe } from "../report.ts";
import { isSensitive } from "../sensitive.ts";
import { isSecretFile } from "../walk.ts";
import { findNpmCli, readSettings, scrubEnv } from "./checks.ts";
import { bindingOf, elicit, elicitationOf } from "./confirm.ts";
import type { McpContext, PaidEngine, PendingMigration, StoredPlan } from "./context.ts";
import { changedLines } from "./diff.ts";
import { CHECK_TIMEOUT_MS, gitClean, runArgv } from "./exec.ts";
import { appendLedger, ledgerFile } from "./ledger.ts";
import {
  fileForWrite,
  LOCKFILE,
  MAX_LOCKFILE_BYTES,
  PathRefused,
  sha256Text,
  writeInside,
} from "./paths.ts";
import { clean, DATA_RULE, fence, MAX_SUMMARY_CHARS, NO_ELICITATION } from "./text.ts";
import type { ApplyOut } from "./tools.ts";

const MAX_COPY_FILES = 50_000;
const MAX_COPY_BYTES = 300 * 1024 * 1024;
const MAX_COPY_FILE = 5 * 1024 * 1024;
const PENDING_TTL_MS = 30 * 60_000;
const NPM_FLAGS = ["--ignore-scripts", "--allow-git=none", "--no-audit", "--no-fund"];
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

const isolationFlags = (userRc: string, globalRc: string): string[] => [
  `--userconfig=${userRc}`,
  `--globalconfig=${globalRc}`,
  `--registry=${PUBLIC_REGISTRY}`,
  "--replace-registry-host=never",
  "--strict-ssl=true",
  "--git=git",
];

const NPM_NOTE =
  "No package script runs (--ignore-scripts) and no git dependency is fetched (--allow-git=none). npm reads no user or global .npmrc: it uses the public registry (registry.npmjs.org) and fetches exactly the URLs in the lockfiles, so a project on a private registry is migrated from a terminal instead.";
const PROJECT_NPMRC_NOTE =
  "npm still reads this project's .npmrc in the repository (npm cannot skip it); its registry, registry-host, TLS, git and script settings are overridden on the command line, and the lockfile it installs was checked above.";

export const npmSupport = (npmCli: string): { version: string; allowGit: boolean } => {
  const npmRoot = dirname(dirname(npmCli));
  let version = "unknown";
  try {
    const v = (
      JSON.parse(readFileSync(join(npmRoot, "package.json"), "utf8")) as { version?: unknown }
    ).version;
    if (typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) version = v.slice(0, 32);
  } catch {
    version = "unknown";
  }
  const definitions = [
    join(npmRoot, "node_modules", "@npmcli", "config", "lib", "definitions", "definitions.js"),
    join(npmRoot, "workspaces", "config", "lib", "definitions", "definitions.js"),
  ];
  const allowGit = definitions.some((file) => {
    try {
      return readFileSync(file, "utf8").includes("'allow-git'");
    } catch {
      return false;
    }
  });
  return { version, allowGit };
};

const npmRunner = (
  ctx: McpContext,
  root: string,
  env: Record<string, string>,
):
  | { npm: string[]; isolation: string[]; npmEnv: Record<string, string>; version: string }
  | { error: string } => {
  if (inside(root, resolve(ctx.cacheDir())))
    return { error: "the cache directory is inside the repository: nothing is prepared there" };
  const execPath = ctx.options.execPath ?? process.execPath;
  const npmCli = findNpmCli(execPath, ctx.env());
  if (!npmCli)
    return {
      error:
        "npm's CLI was not found next to Node: the person runs the CLI's migrate command in a terminal",
    };
  const support = npmSupport(npmCli);
  if (!support.allowGit)
    return {
      error: `npm ${support.version} cannot refuse git dependencies (--allow-git): update npm, or the person runs the CLI's migrate command in a terminal`,
    };
  const cache = ctx.cacheDir();
  mkdirSync(cache, { recursive: true });
  const userRc = join(cache, "mcp-empty-user-npmrc");
  const globalRc = join(cache, "mcp-empty-global-npmrc");
  for (const f of [userRc, globalRc]) writeFileSync(f, "", { mode: 0o600 });
  const npmEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !/^npm_config_/i.test(k)));
  return {
    npm: [execPath, npmCli],
    isolation: isolationFlags(userRc, globalRc),
    npmEnv,
    version: support.version,
  };
};

type Answer = { data: ApplyOut; text: string } | { error: string };

const computedSchema = z.object({
  ok: z.literal(true),
  upgrades: z
    .array(
      z.object({
        package: z.string().max(214),
        installed: z.string().max(64),
        to: z.string().max(64),
        eventId: z.string().max(200),
      }),
    )
    .min(1)
    .max(20),
  files: z
    .array(z.object({ path: z.string().min(1).max(1024), text: z.string().max(2 * 1024 * 1024) }))
    .max(500),
  manifest: z.string().max(1024 * 1024),
  lockfile: z.string().max(MAX_LOCKFILE_BYTES),
  edits: z.number().int().nonnegative(),
  left: z
    .array(
      z.object({
        path: z.string().max(1024),
        line: z.number().int().min(1),
        message: z.string().max(300),
        alertOnly: z.boolean(),
      }),
    )
    .max(200),
});

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

const copyTracked = async (
  root: string,
  dest: string,
  env: Record<string, string>,
): Promise<Map<string, string> | { error: string }> => {
  const listed = await runArgv(
    ["git", "--literal-pathspecs", "-c", "core.fsmonitor=false", "ls-files", "-z"],
    { cwd: root, env, timeoutMs: 60_000, tailBytes: 64 * 1024 * 1024 },
  );
  if (listed.failedToStart || listed.timedOut || listed.exitCode !== 0 || listed.truncated)
    return { error: "git could not list the tracked files" };
  const paths = listed.output.split(String.fromCharCode(0)).filter((p) => p !== "");
  if (paths.length > MAX_COPY_FILES)
    return { error: `the repository has more than ${MAX_COPY_FILES} tracked files` };
  const hashes = new Map<string, string>();
  let total = 0;
  for (const rel of paths) {
    const parts = rel.split("/");
    if (
      parts.some(
        (p) =>
          p === "" ||
          p === "." ||
          p === ".." ||
          p.toLowerCase() === ".git" ||
          p.toLowerCase() === "node_modules",
      ) ||
      isAbsolute(rel)
    )
      continue;
    if (isSecretFile(parts[parts.length - 1] ?? "")) continue;
    const from = join(root, ...parts);
    let stat;
    try {
      stat = lstatSync(from);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_COPY_FILE) continue;
    try {
      if (realpathSync(from) !== from) continue;
    } catch {
      continue;
    }
    total += stat.size;
    if (total > MAX_COPY_BYTES)
      return { error: `the tracked files are over ${MAX_COPY_BYTES / 1024 / 1024} MB` };
    const to = join(dest, ...parts);
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    hashes.set(rel, sha256(readFileSync(to)));
  }
  return hashes;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const manifestChangedOnlyIn = (
  before: string,
  after: string,
  upgrades: readonly EngineUpgrade[],
): boolean => {
  try {
    const a = JSON.parse(before) as Record<string, Record<string, unknown> | undefined>;
    const b = JSON.parse(after) as Record<string, Record<string, unknown> | undefined>;
    for (const u of upgrades) {
      let found = false;
      const range = new RegExp(`^[~^]?${escapeRegExp(u.to)}$`);
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const was = a[section]?.[u.package];
        if (was === undefined) continue;
        const now = b[section]?.[u.package];
        if (typeof now !== "string" || !range.test(now)) return false;
        found = true;
        delete (a[section] as Record<string, unknown>)[u.package];
        delete (b[section] as Record<string, unknown>)[u.package];
      }
      if (!found) return false;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

type LockEntry = {
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  link?: unknown;
  name?: unknown;
};

const parseLock = (text: string): Record<string, LockEntry> | null => {
  try {
    const lock = JSON.parse(text) as { lockfileVersion?: unknown; packages?: unknown };
    if (
      (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) ||
      typeof lock.packages !== "object" ||
      lock.packages === null
    )
      return null;
    return lock.packages as Record<string, LockEntry>;
  } catch {
    return null;
  }
};

const linkInside = (resolved: unknown): boolean => {
  if (typeof resolved !== "string" || resolved === "" || resolved.length > 1024) return false;
  if (
    resolved.startsWith("/") ||
    resolved.startsWith("\\") ||
    /^[A-Za-z]:/.test(resolved) ||
    resolved.includes(":")
  )
    return false;
  return !resolved.split(/[\\/]+/).includes("..");
};

export const currentLockfileProblem = (text: string): string | null => {
  const entries = parseLock(text);
  if (!entries) return "package-lock.json is not an npm lockfile of version 2 or 3";
  for (const [key, e] of Object.entries(entries)) {
    if (e.link === true) {
      if (!linkInside(e.resolved)) return `${clean(key, 200)} links outside the repository`;
      continue;
    }
    if (e.resolved === undefined) continue;
    if (typeof e.resolved !== "string" || !e.resolved.startsWith("https://"))
      return `${clean(key, 200)} is not resolved over https (git, file, ssh and http dependencies are not installed from here)`;
  }
  return null;
};

export const lockfileProblem = (
  next: string,
  current: string,
  upgrades: readonly EngineUpgrade[],
): string | null => {
  const after = parseLock(next);
  const before = parseLock(current);
  if (!after || !before) return "package-lock.json is not a lockfile of version 2 or 3";
  const hosts = new Set(["registry.npmjs.org"]);
  for (const e of Object.values(before)) {
    if (typeof e.resolved !== "string") continue;
    try {
      const url = new URL(e.resolved);
      if (url.protocol === "https:") hosts.add(url.host);
    } catch {}
  }
  for (const [key, e] of Object.entries(after)) {
    const old = before[key];
    if (e.link === true) {
      if ((old?.link !== true || old.resolved !== e.resolved) && !linkInside(e.resolved))
        return `${clean(key, 200)} links outside the repository`;
      continue;
    }
    if (e.resolved === undefined) {
      if (key !== "" && old === undefined)
        return `${clean(key, 200)} is a new entry without a resolved URL`;
      continue;
    }
    if (old?.resolved === e.resolved && old.link !== true) continue;
    if (typeof e.resolved !== "string") return `${clean(key, 200)} has an invalid resolved value`;
    let url: URL;
    try {
      url = new URL(e.resolved);
    } catch {
      return `${clean(key, 200)} does not resolve to a URL`;
    }
    if (url.protocol !== "https:" || !hosts.has(url.host))
      return `${clean(key, 200)} resolves from ${clean(url.host, 100)}, a host the current lockfile does not use`;
    if (typeof e.integrity !== "string" || e.integrity === "")
      return `${clean(key, 200)} has no integrity hash`;
  }
  for (const u of upgrades) {
    const e = after[`node_modules/${u.package}`];
    const what = `${clean(u.package, 214)} ${clean(u.to, 64)}`;
    if (e?.version !== u.to) return `the lockfile does not install ${what}`;
    if (e.name !== undefined && e.name !== u.package)
      return `the lockfile installs ${what} under another name (an alias)`;
    if (typeof e.resolved !== "string" || !e.resolved.includes(`/${u.package}/-/`))
      return `the lockfile does not take ${what} from the registry`;
  }
  return null;
};

const lockfileChanges = (next: string, current: string): number => {
  try {
    const a =
      (JSON.parse(current) as { packages?: Record<string, { version?: unknown }> }).packages ?? {};
    const b =
      (JSON.parse(next) as { packages?: Record<string, { version?: unknown }> }).packages ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => a[k]?.version !== b[k]?.version).length;
  } catch {
    return 0;
  }
};

const confirmAnswer = (
  ctx: McpContext,
  plan: StoredPlan,
  stage: "prepare" | "write",
  summary: string,
  binding: string,
  migration: NonNullable<ApplyOut["migration"]>,
): Answer => {
  const issued = ctx.confirmations.issue(binding);
  const data: ApplyOut = {
    status: "needs-confirmation",
    tier: "paid",
    applied: false,
    planIds: [plan.planId],
    note:
      stage === "prepare"
        ? "Nothing was run yet. Show the person this summary exactly. Only if they say yes, call apply_fix again with the same planIds and this confirmationToken. It works once, for 10 minutes."
        : "The migration is prepared; nothing in the repository changed yet. Show the person every line below exactly. Only if they say yes, call apply_fix again with the same planIds and this confirmationToken. It works once, for 10 minutes.",
    confirmation: { token: issued.token, expiresAt: issued.expiresAt, summary },
    files: [],
    freePlans: [],
    undo: null,
    ledger: "nothing to record",
    migration,
  };
  return {
    data,
    text: [
      data.note,
      ...fence("summary for the person", summary.split("\n")),
      `confirmationToken: ${issued.token}`,
      DATA_RULE,
    ].join("\n"),
  };
};

const declined = (plan: StoredPlan, what: string): Answer => {
  const data: ApplyOut = {
    status: "declined",
    tier: "paid",
    applied: false,
    planIds: [plan.planId],
    note: `The person did not confirm: ${what}`,
    confirmation: null,
    files: [],
    freePlans: [],
    undo: null,
    ledger: "nothing to record",
    migration: null,
  };
  return { data, text: data.note };
};

export interface MigrationRequest {
  root: string;
  plan: StoredPlan;
  paid: Extract<PaidEngine, { ok: true }>;
  token?: string;
  session?: ToolSession;
}

const running = new WeakMap<McpContext, Set<string>>();

export const applyMigration = async (ctx: McpContext, r: MigrationRequest): Promise<Answer> => {
  const busy = running.get(ctx) ?? new Set<string>();
  running.set(ctx, busy);
  if (busy.has(r.plan.planId))
    return {
      error: "this migration is already being prepared or written: wait for that call to answer",
    };
  busy.add(r.plan.planId);
  try {
    return await migrationStep(ctx, r);
  } finally {
    busy.delete(r.plan.planId);
  }
};

const migrationStep = async (ctx: McpContext, r: MigrationRequest): Promise<Answer> => {
  const { root, plan, paid } = r;
  const engine = paid.engine as EngineModule;
  if (
    typeof engine.prepareMigration !== "function" ||
    typeof engine.computeMigration !== "function"
  ) {
    return {
      error: `this engine cannot apply SDK migrations from here: update the CLI (npx ${CLI_NAME}@latest), or the person runs the CLI's migrate command in a terminal`,
    };
  }
  const known = paid.knowledge.migrations.find((m) => m.eventId === plan.eventId);
  if (!known || known.migration.package.ecosystem !== "npm")
    return { error: "no reviewed npm migration for this change in the engine's knowledge" };
  const settings = readSettings(ctx.options.configDir ?? configDir());
  const asked = elicitationOf(r.session);
  if (!asked && !settings.tokenConfirmation) return { error: NO_ELICITATION };
  const scrubbed = scrubEnv(ctx.env(), settings.allowEnv);
  const timeoutMs = ctx.options.checksTimeoutMs ?? CHECK_TIMEOUT_MS;

  const pending = ctx.migrations.get(plan.planId);
  if (pending && ctx.now().getTime() - pending.at > PENDING_TTL_MS)
    ctx.migrations.delete(plan.planId);
  const live = ctx.migrations.get(plan.planId);
  if (live) {
    if (!asked && !r.token)
      return confirmAnswer(ctx, plan, "write", live.summary, live.binding, {
        stage: "write",
        upgrades: live.upgrades,
        edits: live.edits,
        left: live.left,
      });
    if (!asked && r.token && !ctx.confirmations.consume(r.token, live.binding)) {
      return {
        error:
          "the confirmation token is unknown, already used, expired, or for different changes: nothing was written. Call apply_fix again without it and ask the person again.",
      };
    }
    if (
      asked &&
      r.session &&
      (await elicit(r.session, asked, live.summary, "Write this migration")) !== "yes"
    )
      return declined(plan, "nothing was written.");
    return writeMigration(ctx, root, plan, paid, live, scrubbed.env, timeoutMs);
  }

  const platform = ctx.options.platform ?? process.platform;
  const runner = npmRunner(ctx, root, scrubbed.env);
  if ("error" in runner) return { error: runner.error };
  const { npm, isolation, npmEnv } = runner;
  let manifest;
  let lock;
  try {
    manifest = fileForWrite(root, "package.json");
    lock = fileForWrite(root, LOCKFILE, MAX_LOCKFILE_BYTES);
  } catch (e) {
    return {
      error: `an SDK migration needs package.json and ${LOCKFILE} at the repository root (npm): ${e instanceof PathRefused ? e.message : "they cannot be read"}`,
    };
  }
  const lockIssue = currentLockfileProblem(lock.text);
  if (lockIssue)
    return {
      error: `${LOCKFILE} is refused before npm runs (${lockIssue}): the person runs the CLI's migrate command in a terminal`,
    };
  for (const f of [manifest.rel, lock.rel]) {
    const state = await gitClean(root, f, scrubbed.env);
    if (state !== "clean")
      return {
        error: `${f} ${state === "dirty" ? "has uncommitted changes" : state === "untracked" ? "is not tracked by git" : "could not be checked with git"}: commit or stash first`,
      };
  }
  const work = resolve(ctx.cacheDir(), "migrate", plan.planId);
  if (inside(root, work))
    return { error: "the cache directory is inside the repository: nothing is prepared there" };
  let npmrc: { size: number; mtimeMs: number } | null = null;
  try {
    const stat = lstatSync(join(root, ".npmrc"));
    npmrc = { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    npmrc = null;
  }
  const show = (args: string[]) => `npm ${args.join(" ")}`;
  const p = known.migration.package;
  const summaryA = [
    `Harbyn will prepare the reviewed SDK migration for ${plan.eventId} outside this repository (nothing in it changes yet):`,
    `  ${clean(p.name, 214)} ${clean(p.from, 64)} -> ${clean(p.to, 64)}`,
    `In ${clean(work, 1024)}:`,
    "  1. copy the repository's tracked files (not .git, node_modules or secret files)",
    `  2. ${show(["ci", ...NPM_FLAGS])}   (your current lockfile)`,
    `  3. a second copy with ${clean(p.name, 214)} at ${clean(p.to, 64)} in package.json`,
    `  4. ${show(["install", ...NPM_FLAGS])}   (in the second copy: npm resolves the new versions)`,
    "  5. compute the edits with the reviewed recipes",
    NPM_NOTE,
    `npm ${runner.version}. No shell from Harbyn; ${scrubbed.removed.length} credential-like environment variable(s) and every npm_config_ variable removed; each step stops after ${Math.round(timeoutMs / 60_000)} minutes.${npmrc ? " The copies leave out this project's .npmrc (Harbyn never copies secret files)." : ""}`,
    "Then Harbyn shows you every changed line and asks again before writing anything.",
  ].join("\n");
  const bindingA = bindingOf({
    kind: "migration-prepare",
    root,
    planId: plan.planId,
    eventId: plan.eventId,
    npm,
    isolation,
    manifest: manifest.sha256,
    lock: lock.sha256,
    npmrc,
    allowEnv: settings.allowEnv,
  });
  const upgradesShown = [{ package: p.name, installed: p.from, to: p.to }];
  if (!asked) {
    if (!r.token)
      return confirmAnswer(ctx, plan, "prepare", summaryA, bindingA, {
        stage: "prepare",
        upgrades: upgradesShown,
        edits: 0,
        left: [],
      });
    if (!ctx.confirmations.consume(r.token, bindingA)) {
      return {
        error:
          "the confirmation token is unknown, already used, expired, or for a different command: nothing was run. Call apply_fix again without it and ask the person again.",
      };
    }
  } else if (
    r.session &&
    (await elicit(r.session, asked, summaryA, "Prepare this migration")) !== "yes"
  ) {
    return declined(plan, "nothing was run.");
  }

  const oldDir = join(work, "old");
  const newDir = join(work, "new");
  let computed: z.output<typeof computedSchema>;
  let copied: Map<string, string>;
  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(oldDir, { recursive: true, mode: 0o700 });
    const c = await copyTracked(root, oldDir, scrubbed.env);
    if ("error" in c) return { error: `nothing was prepared: ${c.error}` };
    copied = c;
    const step = async (dir: string, args: string[]): Promise<string | null> => {
      const ran = await runArgv([...npm, ...args, ...isolation], {
        cwd: dir,
        env: npmEnv,
        timeoutMs,
        platform,
      });
      if (ran.failedToStart) return `${show(args)} could not be started`;
      if (ran.timedOut) return `${show(args)} did not finish in time`;
      if (ran.exitCode !== 0)
        return `${show(args)} failed (exit code ${ran.exitCode}): ${clean(ran.output.slice(-600), 600)}`;
      return null;
    };
    const ci = await step(oldDir, ["ci", ...NPM_FLAGS]);
    if (ci) return { error: `nothing in the repository changed: ${ci}` };
    let prepared;
    try {
      prepared = engine.prepareMigration({
        oldDir,
        newDir,
        knowledge: paid.knowledge,
        eventId: plan.eventId,
      });
    } catch {
      prepared = { ok: false as const, reason: "the engine failed" };
    }
    if (!prepared || prepared.ok !== true)
      return {
        error: `nothing in the repository changed: ${clean(prepared?.ok === false ? prepared.reason : "the engine failed")}`,
      };
    if (inside(root, newDir)) return { error: "the cache directory is inside the repository" };
    const install = await step(newDir, ["install", ...NPM_FLAGS]);
    if (install) return { error: `nothing in the repository changed: ${install}` };
    let raw: EngineMigrationComputed | undefined;
    try {
      raw = engine.computeMigration({ oldDir, newDir });
    } catch {
      raw = undefined;
    }
    if (raw && raw.ok === false)
      return { error: `nothing in the repository changed: ${clean(raw.reason)}` };
    const parsed = computedSchema.safeParse(raw);
    if (!parsed.success)
      return {
        error: "nothing in the repository changed: the engine's migration result was malformed",
      };
    computed = parsed.data;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const writes: PendingMigration["writes"] = [];
  for (const f of computed.files) {
    let file;
    try {
      file = fileForWrite(root, f.path);
    } catch (e) {
      return {
        error: `${clean(f.path)} refused: ${e instanceof PathRefused ? e.message : "it cannot be read"}. Nothing was written.`,
      };
    }
    if (copied.get(file.rel) !== sha256(Buffer.from(file.text, "utf8")))
      return {
        error: `${clean(file.rel)} changed while the migration was prepared, or was not copied: nothing was written`,
      };
    if (isSensitive(file.rel, file.text) || isSensitive(file.rel, f.text))
      return {
        error: `${clean(file.rel)} is payments, authentication, cryptography or CI code: never edited. Nothing was written.`,
      };
    if (file.rel === "package.json" || file.rel === LOCKFILE)
      return {
        error:
          "the engine returned package.json or the lockfile as a source file: nothing was written",
      };
    writes.push({
      path: file.rel,
      sha256Before: file.sha256,
      before: file.text,
      after: f.text,
      machine: false,
    });
  }
  if (!manifestChangedOnlyIn(manifest.text, computed.manifest, computed.upgrades))
    return {
      error:
        "the new package.json changes more than the upgraded dependencies: nothing was written",
    };
  const lockProblem = lockfileProblem(computed.lockfile, lock.text, computed.upgrades);
  if (lockProblem)
    return { error: `the new ${LOCKFILE} is refused (${lockProblem}): nothing was written` };
  writes.push({
    path: "package.json",
    sha256Before: manifest.sha256,
    before: manifest.text,
    after: computed.manifest,
    machine: false,
  });
  writes.push({
    path: LOCKFILE,
    sha256Before: lock.sha256,
    before: lock.text,
    after: computed.lockfile,
    machine: true,
  });
  for (const w of writes) {
    const state = await gitClean(root, w.path, scrubbed.env);
    if (state !== "clean")
      return {
        error: `${clean(w.path)} ${state === "dirty" ? "has uncommitted changes" : state === "untracked" ? "is not tracked by git" : "could not be checked with git"}: nothing was written`,
      };
  }

  const left = computed.left.map((l) => ({
    path: clean(l.path, 1024),
    line: l.line,
    message: clean(l.message),
    alertOnly: l.alertOnly,
  }));
  const summaryB = [
    `Harbyn will write the ${clean(p.name, 214)} migration (${computed.edits} edit(s)) to ${writes.length} file(s) in the working tree (nothing is staged, committed or pushed):`,
    ...computed.upgrades.map(
      (u) => `  ${clean(u.package, 214)} ${clean(u.installed, 64)} -> ${clean(u.to, 64)}`,
    ),
    ...writes
      .filter((w) => !w.machine)
      .flatMap((w) => changedLines(clean(w.path, 1024), w.before, w.after).map((l) => safe(l))),
    `${LOCKFILE}: regenerated by npm in the copy (${lockfileChanges(computed.lockfile, lock.text)} package entries change; https only, from hosts your lockfile already uses, with integrity).`,
    ...(left.length > 0
      ? [
          `Left for a person (${left.length}): ${left
            .slice(0, 5)
            .map((l) => `${l.path}:${l.line}`)
            .join(", ")}${left.length > 5 ? ", ..." : ""}`,
        ]
      : []),
    `Then: ${show(["ci", ...NPM_FLAGS])} in this repository, with the same settings, so the checks run on the new versions (it replaces node_modules).${npmrc ? ` ${PROJECT_NPMRC_NOTE}` : ""}`,
    `Change ${plan.eventId}, source ${plan.evidence.source}, ${plan.evidence.reviewState}.`,
    `Undo: git checkout -- ${writes.map((w) => clean(w.path, 1024)).join(" ")}, then ${show(["ci", ...NPM_FLAGS])}`,
  ].join("\n");
  if (summaryB.length > MAX_SUMMARY_CHARS) {
    return {
      error: `this migration is too long to show the person in full (${summaryB.length} characters, the limit is ${MAX_SUMMARY_CHARS}): nothing was written. The person runs the CLI's migrate command in a terminal.`,
    };
  }
  const bindingB = bindingOf({
    kind: "migration-write",
    root,
    planId: plan.planId,
    writes: writes.map((w) => [w.path, w.sha256Before, sha256Text(w.after)]),
    npm,
    isolation,
    npmrc,
  });
  const ready: PendingMigration = {
    planId: plan.planId,
    binding: bindingB,
    summary: summaryB,
    at: ctx.now().getTime(),
    writes,
    upgrades: computed.upgrades,
    edits: computed.edits,
    left,
  };
  ctx.migrations.set(plan.planId, ready);
  if (!asked)
    return confirmAnswer(ctx, plan, "write", summaryB, bindingB, {
      stage: "write",
      upgrades: computed.upgrades,
      edits: computed.edits,
      left,
    });
  if (r.session && (await elicit(r.session, asked, summaryB, "Write this migration")) !== "yes")
    return declined(plan, "the migration was prepared, nothing was written.");
  return writeMigration(ctx, root, plan, paid, ready, scrubbed.env, timeoutMs);
};

const writeMigration = async (
  ctx: McpContext,
  root: string,
  plan: StoredPlan,
  paid: Extract<PaidEngine, { ok: true }>,
  m: PendingMigration,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Answer> => {
  ctx.migrations.delete(plan.planId);
  const still = await ctx.paid({ fresh: true });
  if (!still.ok || still.sha256 !== paid.sha256)
    return { error: `${still.ok ? "the paid engine changed" : still.note} Nothing was written.` };
  const ledgerAt = ledgerFile(ctx.cacheDir(), root);
  if ("error" in ledgerAt) return { error: `nothing was written: ${ledgerAt.error}` };
  for (const w of m.writes) {
    const state = await gitClean(root, w.path, env);
    if (state !== "clean")
      return {
        error: `${clean(w.path)} changed since the migration was prepared: nothing was written`,
      };
  }
  const written: ApplyOut["files"] = [];
  for (const w of m.writes) {
    try {
      const done = writeInside(
        root,
        w.path,
        w.sha256Before,
        w.after,
        w.machine ? MAX_LOCKFILE_BYTES : undefined,
      );
      written.push({
        path: clean(w.path, 1024),
        sha256Before: w.sha256Before,
        sha256After: done.sha256,
        lines: [],
      });
      ctx.written.set(w.path, done.sha256);
    } catch (e) {
      const done = written.map((x) => x.path);
      return {
        error: `stopped at ${clean(w.path)} (${e instanceof PathRefused ? e.message : "the write failed"}). ${done.length ? `Already written: ${done.join(", ")} (undo: git checkout -- ${done.join(" ")}).` : "Nothing was written."}`,
      };
    }
  }
  plan.applied = true;
  const platform = ctx.options.platform ?? process.platform;
  const runner = npmRunner(ctx, root, env);
  const installed =
    "error" in runner
      ? undefined
      : await runArgv([...runner.npm, "ci", ...NPM_FLAGS, ...runner.isolation], {
          cwd: root,
          env: runner.npmEnv,
          timeoutMs,
          platform,
        });
  const installNote =
    installed && !installed.failedToStart && !installed.timedOut && installed.exitCode === 0
      ? "node_modules was reinstalled from the new lockfile (no package script ran, no git dependency was fetched)."
      : `npm ci ${NPM_FLAGS.join(" ")} did not finish in the repository (${!installed ? "npm unavailable" : installed.timedOut ? "time limit" : `exit code ${installed.exitCode ?? "none"}`}): the person runs it before the checks.`;
  const files = m.writes.map((w) => ({
    path: w.path,
    sha256Before: w.sha256Before,
    sha256After: sha256Text(w.after),
    before: w.before,
    after: w.after,
    lines: [],
    machine: w.machine,
  }));
  ctx.applied.push({
    at: ctx.now().toISOString(),
    eventId: plan.eventId,
    planId: plan.planId,
    mode: plan.mode,
    recipeId: plan.recipeId,
    engineSha256: paid.sha256,
    evidence: plan.evidence,
    risk: plan.risk,
    files,
    leftAlone: m.left.map((l) => ({
      path: l.path,
      line: l.line,
      reason: l.alertOnly
        ? "payments, authentication, cryptography or CI code: alert only, never edited"
        : `left for a person: ${l.message}`,
    })),
    upgrades: m.upgrades,
  });
  const r = appendLedger(ctx.cacheDir(), root, {
    at: ctx.now().toISOString(),
    tool: "apply_fix",
    plans: [
      {
        planId: plan.planId,
        eventId: plan.eventId,
        mode: plan.mode,
        recipeId: plan.recipeId,
        ...plan.evidence,
      },
    ],
    engineSha256: paid.sha256,
    upgrades: m.upgrades,
    files: written,
  });
  const ledger =
    "error" in r ? `Evidence not recorded: ${r.error}.` : "Evidence recorded in the local ledger.";
  const undo = `git checkout -- ${written.map((w) => w.path).join(" ")} && npm ci ${NPM_FLAGS.join(" ")}`;
  const data: ApplyOut = {
    status: "applied",
    tier: "paid",
    applied: true,
    planIds: [plan.planId],
    note: `Written to the working tree only. ${installNote} Next: run_checks, then scan to verify the findings are gone.`,
    confirmation: null,
    files: written,
    freePlans: [],
    undo,
    ledger,
    migration: { stage: "done", upgrades: m.upgrades, edits: m.edits, left: m.left },
  };
  return {
    data,
    text: [
      `Migrated ${m.upgrades.map((u) => `${u.package} ${u.installed} -> ${u.to}`).join(", ")}: ${written.length} file(s) written.`,
      installNote,
      `Undo: ${undo}`,
      ledger,
    ].join("\n"),
  };
};
