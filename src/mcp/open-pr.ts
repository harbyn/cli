import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defineTool } from "../mcp-protocol/index.ts";
import { type ChangeEvent, deadlineOf, type FeedIndex } from "../schema/index.ts";
import { z } from "zod";
import { configDir } from "../login.ts";
import { safe } from "../report.ts";
import { isSensitive } from "../sensitive.ts";
import { readSettings } from "./checks.ts";
import { bindingOf, elicit, elicitationOf } from "./confirm.ts";
import type { AppliedRecord, CheckRecord, McpContext } from "./context.ts";
import { unifiedDiff } from "./diff.ts";
import { blobId, resolveProgram, runArgv } from "./exec.ts";
import {
  createBranch,
  currentBranch,
  DEFAULT_SCHEMES,
  defaultBranchOf,
  emptyHooksDir,
  isAncestor,
  lsRemote,
  NETWORK_TIMEOUT_MS,
  parseRemoteUrl,
  plumbingCommit,
  pushBranch,
  pushUrlOf,
  refExists,
  revParse,
  safeGitEnv,
  unsafeLocalConfig,
  validBranch,
  validRemoteName,
} from "./git.ts";
import { appendLedger } from "./ledger.ts";
import { fileForWrite, LOCKFILE, MAX_LOCKFILE_BYTES, PathRefused } from "./paths.ts";
import { clean, DATA_RULE, fence, MAX_SUMMARY_CHARS, NO_ELICITATION } from "./text.ts";

const MAX_BODY = 60_000;
const MAX_PATCH = 1024 * 1024;
const MAX_LOCK_IN_PATCH = 256 * 1024;

const eventIdSchema = z
  .string()
  .max(160)
  .regex(
    /^[a-z0-9-]+\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be an event id such as openai/2026-01-01-gpt-x-retired (from scan)",
  );

export const branchFor = (eventId: string): string =>
  `harbyn/${eventId.replace("/", "-")}`.replace(/[^A-Za-z0-9._/-]/g, "-").slice(0, 200);

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const md = (s: string): string =>
  safe(s)
    .replace(/[\\`*_{}[\]<>()#+!|~]/g, "\\$&")
    .replaceAll("@", "&#64;")
    .replaceAll("://", ":&#47;&#47;");

const codeBlock = (text: string, lang = ""): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

const SOURCE = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%/-]*)?$/;

const RISK_NOTE: Record<AppliedRecord["risk"], string> = {
  low: "low: a reviewed one-for-one replacement; a newer model or API version can still behave differently, so run your tests.",
  medium:
    "medium: more than a name swap (or a dependency upgrade); review every line and run your tests.",
  high: "high: a breaking or critical change; review every line, run your tests, and read the vendor's notes before merging.",
};

export interface CommittedFile {
  path: string;
  sha256After: string;
  before: string;
  after: string;
  machine: boolean;
}

export const committedFiles = (records: readonly AppliedRecord[]): CommittedFile[] => {
  const byPath = new Map<string, CommittedFile>();
  for (const r of records) {
    for (const f of r.files) {
      const earlier = byPath.get(f.path);
      byPath.set(f.path, {
        path: f.path,
        sha256After: f.sha256After,
        before: earlier?.before ?? f.before,
        after: f.after,
        machine: f.machine,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
};

export const checksOnExactly = (
  checks: readonly CheckRecord[],
  files: readonly CommittedFile[],
): CheckRecord[] =>
  checks.filter((c) =>
    files.every((f) => c.files.some((x) => x.path === f.path && x.sha256 === f.sha256After)),
  );

export const prTitle = (event: ChangeEvent, vendorName: string): string => {
  const deadline = deadlineOf(event);
  return `Harbyn: ${safe(event.title)} (${safe(vendorName)}${deadline ? `, ${deadline.date}` : ""})`
    .replaceAll("@", "")
    .slice(0, 200);
};

export const prBody = (o: {
  event: ChangeEvent;
  vendorName: string;
  records: readonly AppliedRecord[];
  files: readonly CommittedFile[];
  checks: readonly CheckRecord[];
  branch: string;
}): string => {
  const e = o.event;
  const deadline = deadlineOf(e);
  const source = o.records[0]?.evidence.source ?? "";
  const risk = o.records.map((r) => r.risk).includes("high")
    ? "high"
    : o.records.map((r) => r.risk).includes("medium")
      ? "medium"
      : "low";
  const upgrades = o.records.flatMap((r) => r.upgrades);
  const lines: string[] = [
    `${md(o.vendorName)} announced: **${md(e.title)}**${deadline ? ` (effective ${md(deadline.date)})` : ""}.`,
    "",
    md(e.summary),
    "",
    `Source: ${SOURCE.test(source) ? source : md(source)}`,
    "",
    upgrades.length > 0
      ? `This pull request applies Harbyn's reviewed migration: ${upgrades.map((u) => `\`${md(u.package)}\` ${md(u.installed)} to ${md(u.to)}`).join(", ")}, with the code changes it needs. Nothing else changes.`
      : `This pull request changes ${o.files.length === 1 ? "one file" : `${o.files.length} files`}, exactly as shown below. Nothing else changes.`,
    "",
    "### Changes",
    "",
  ];
  for (const f of o.files) {
    if (f.machine) {
      lines.push(
        `\`${md(f.path)}\`: regenerated by npm for the new versions (https only, from hosts the previous lockfile used, with integrity).`,
        "",
      );
      continue;
    }
    const diff = unifiedDiff(f.path, f.before, f.after)
      .split("\n")
      .filter((l) => !l.startsWith("diff --git") && !l.startsWith("--- ") && !l.startsWith("+++ "))
      .map((l) => safe(l))
      .join("\n")
      .trimEnd();
    lines.push(`\`${md(f.path)}\``, "", codeBlock(diff, "diff"), "");
  }
  const left = o.records.flatMap((r) => r.leftAlone);
  if (left.length > 0)
    lines.push(
      "### Not changed",
      "",
      ...left.slice(0, 50).map((l) => `- \`${md(l.path)}:${l.line}\`: ${md(l.reason)}`),
      ...(left.length > 50 ? [`- and ${left.length - 50} more`] : []),
      "",
    );
  lines.push("### Risk", "", RISK_NOTE[risk], "");
  lines.push("### Checks", "");
  if (o.checks.length === 0)
    lines.push("No checks were run on exactly these files. Run your tests before merging.", "");
  else
    lines.push(
      "Run on the developer's machine on exactly the files in this commit (same sha256):",
      "",
      ...o.checks.map(
        (c) =>
          `- ${md(c.check)}: \`${md(c.command)}\` (${md(c.origin)}): ${c.timedOut ? "stopped at the time limit" : c.exitCode === 0 ? "passed" : `failed (exit code ${c.exitCode ?? "none"})`}`,
      ),
      "",
    );
  lines.push(
    "### How to undo",
    "",
    `- Before merging: close this pull request and delete the branch \`${md(o.branch)}\`. Harbyn will not open it again.`,
    "- After merging: revert the commit.",
    "",
    `<sub>Opened as a draft by \`harbyn mcp\` on a developer's machine, from change event \`${md(e.id)}\` (${md(o.records[0]?.evidence.reviewState ?? "")}; engine sha256 ${md((o.records[0]?.engineSha256 ?? "").slice(0, 16))}, ${md(
      o.records
        .map((r) => r.recipeId ?? "")
        .filter(Boolean)
        .join(", "),
    )}). Harbyn never merges, approves or reopens a pull request, and never writes to your default branch.</sub>`,
  );
  const body = lines.join("\n");
  return body.length > MAX_BODY
    ? `${body.slice(0, MAX_BODY - 60)}\n\n(shortened: the commit has every change)`
    : body;
};

const quoted = (s: string): string => `"${s.replace(/["$`\\!]/g, "")}"`;

const output = z.object({
  status: z.enum(["opened", "needs-confirmation", "declined", "patch", "nothing-to-commit"]),
  eventId: z.string(),
  branch: z.string().nullable(),
  remote: z
    .object({
      name: z.string(),
      url: z.string().describe("The push URL git resolved, user name and password hidden"),
    })
    .nullable(),
  base: z.string().nullable().describe("The default branch the pull request targets"),
  title: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
  checksOnExactlyTheseFiles: z.array(
    z.object({ check: z.string(), exitCode: z.number().int().nullable() }),
  ),
  confirmation: z
    .object({ token: z.string(), expiresAt: z.string(), summary: z.string() })
    .nullable(),
  commit: z.string().nullable(),
  pullRequest: z.object({ url: z.string(), draft: z.literal(true) }).nullable(),
  patch: z
    .string()
    .nullable()
    .describe("status patch: the changes as a unified diff (repository text)"),
  body: z
    .string()
    .nullable()
    .describe("The pull request text (status patch: for the person to paste)"),
  commands: z
    .array(z.string())
    .describe("status patch or nothing-to-commit: what the person can run themselves"),
  note: z.string(),
  ledger: z.string(),
});
type Out = z.output<typeof output>;

export const openPrTool = (ctx: McpContext) =>
  defineTool({
    name: "open_pr",
    title: "Open a draft pull request",
    description: `Commits exactly the files apply_fix wrote for one change (eventId), with exactly the hashes it recorded, to a new branch harbyn/<event>, pushes only that branch to the remote (origin by default) and opens a DRAFT pull request with the person's own gh, after the person confirms. Built with git plumbing: the checkout, the index and the current branch are not touched. It never uses the default branch, never forces, and never merges, approves or reopens anything; an existing branch or pull request for the change (even a closed one) stops it. If gh is missing or not signed in, it returns the patch, the pull request text and the commands for the person instead. On the free plan apply_fix writes nothing, so open_pr has nothing to commit: the person commits edits you made with your own tools. If the client cannot ask the person itself, the first call returns needsConfirmation with a summary and a single-use token: show it to the person, and call again with confirmationToken only after they say yes. Never invent or reuse a token. ${DATA_RULE}`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: z.object({
      eventId: eventIdSchema,
      remote: z.string().min(1).max(100).default("origin").describe("The git remote to push to"),
      confirmationToken: z
        .string()
        .regex(/^hc_[0-9a-f]{32}$/)
        .optional()
        .describe("Only the token open_pr returned, after the person said yes"),
    }),
    output,
    run: async (args, _today, session) => {
      const state = await ctx.root();
      if (!state.ok) return { error: state.reason };
      const root = state.root;
      if (!validRemoteName(args.remote)) return { error: "the remote name is not valid" };
      const done = ctx.pullRequests.get(args.eventId);
      if (done)
        return {
          error: `open_pr already ran for ${args.eventId} in this session (branch ${done.branch}${done.url ? `, ${done.url}` : ""}): one per change`,
        };
      const branch = branchFor(args.eventId);
      const empty: Out = {
        status: "nothing-to-commit",
        eventId: args.eventId,
        branch: null,
        remote: null,
        base: null,
        title: null,
        files: [],
        checksOnExactlyTheseFiles: [],
        confirmation: null,
        commit: null,
        pullRequest: null,
        patch: null,
        body: null,
        commands: [],
        note: "",
        ledger: "nothing to record",
      };

      const records = ctx.applied.filter((r) => r.eventId === args.eventId);
      if (records.length === 0) {
        const data: Out = {
          ...empty,
          note: "Nothing to commit: open_pr commits only files apply_fix wrote for this change in this session, with the hashes it recorded. On the free plan apply_fix writes nothing, so there is nothing for Harbyn to vouch for. If you changed files with your own tools and the person agreed, they commit and open the pull request themselves, for example with the commands below (they move the person's checkout to a new branch).",
          commands: [
            `git switch -c ${branch}`,
            "git add -- <the files you changed>",
            `git commit -m ${quoted(`Harbyn: ${args.eventId}`)}`,
            `git push -u ${args.remote} ${branch}`,
            "gh pr create --draft --fill",
          ],
        };
        return {
          data,
          text: [data.note, ...data.commands.map((c) => `  ${c}`), DATA_RULE].join("\n"),
        };
      }

      const files = committedFiles(records);
      for (const f of files) {
        let now;
        try {
          now = fileForWrite(root, f.path, f.path === LOCKFILE ? MAX_LOCKFILE_BYTES : undefined);
        } catch (e) {
          return {
            error: `${clean(f.path)} refused: ${e instanceof PathRefused ? e.message : "it cannot be read"}`,
          };
        }
        if (now.sha256 !== f.sha256After)
          return {
            error: `${clean(f.path)} changed since apply_fix wrote it: open_pr commits only exactly what apply_fix wrote. Call scan, plan_fix and apply_fix again.`,
          };
        if (!f.machine && f.path !== "package.json" && isSensitive(now.rel, now.text))
          return {
            error: `${clean(f.path)} is payments, authentication, cryptography or CI code: never committed by Harbyn`,
          };
      }

      const hooksBase = ctx.cacheDir();
      if (inside(root, resolve(hooksBase)))
        return {
          error: "the cache directory is inside the repository: open_pr does not run there",
        };
      const schemes = ctx.options.pushSchemes ?? DEFAULT_SCHEMES;
      const env = safeGitEnv(ctx.env(), { hooksDir: emptyHooksDir(hooksBase), schemes });
      const unsafe = await unsafeLocalConfig(root, env);
      if ("error" in unsafe) return { error: unsafe.error };
      if (unsafe.keys.length > 0) {
        return {
          error: `this repository's own git config has settings that could run a program or redirect the push, so open_pr does not run git here: ${unsafe.keys
            .slice(0, 20)
            .map((k) => clean(k, 120))
            .join(
              ", ",
            )}. Move them to your global config if you trust them, or commit the change yourself.`,
        };
      }
      const rawUrl = await pushUrlOf(root, env, args.remote);
      if (!rawUrl)
        return { error: `git has no push URL for the remote ${clean(args.remote, 100)}` };
      const parsed = parseRemoteUrl(rawUrl, schemes);
      if ("error" in parsed) return { error: parsed.error };
      const head = await revParse(root, env, "HEAD^{commit}");
      if (!head) return { error: "this repository has no commit at HEAD" };
      for (const f of files) {
        const atHead = await revParse(root, env, `HEAD:./${f.path}`);
        if (!atHead || atHead !== blobId(Buffer.from(f.before, "utf8"), atHead.length))
          return {
            error: `${clean(f.path)} at HEAD is not what apply_fix changed (a commit since?): open_pr bases its commit on HEAD only when HEAD still has the file as it was`,
          };
      }
      if (!validBranch(branch)) return { error: "this change's branch name is not valid" };
      const base = await defaultBranchOf(root, env, args.remote);
      if (!base)
        return {
          error: `the default branch of ${clean(args.remote, 100)} is not known locally: the person runs git remote set-head ${clean(args.remote, 100)} --auto, then asks again`,
        };
      if (base === branch) return { error: "the target branch is the default branch: refused" };
      const exists = await refExists(root, env, `refs/heads/${branch}`);
      if (exists !== false)
        return {
          error: `the branch ${branch} ${exists ? "already exists in this clone" : "could not be checked"}: open_pr creates a new branch only`,
        };
      const tracking = await revParse(root, env, `refs/remotes/${args.remote}/${base}`);
      if (!tracking || (await isAncestor(root, env, head, tracking)) !== true) {
        return {
          error: `HEAD has commits that are not on ${clean(args.remote, 100)}/${base} (or that branch is not fetched): the pull request must contain only Harbyn's commit. Push or rebase first, or fetch.`,
        };
      }
      const current = await currentBranch(root, env);
      let feed: FeedIndex;
      try {
        feed = (await ctx.feed()).feed;
      } catch {
        return { error: "the change feed could not be loaded" };
      }
      const event = feed.events.find((e) => e.id === args.eventId);
      if (!event) return { error: "this change is no longer in the feed: nothing is opened" };
      const vendorName = feed.vendors.find((v) => v.id === event.vendor)?.name ?? event.vendor;
      const title = prTitle(event, vendorName);
      const checks = checksOnExactly(ctx.checks, files);
      const body = prBody({ event, vendorName, records, files, checks, branch });
      const remote = { name: args.remote, url: parsed.display };
      const shownChecks = checks.map((c) => ({ check: c.check, exitCode: c.exitCode }));
      const fileList = files.map((f) => ({ path: clean(f.path, 1024), sha256: f.sha256After }));

      const ghEnv = {
        ...env,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_SPINNER_DISABLED: "1",
        NO_COLOR: "1",
        GH_PAGER: "cat",
        CLICOLOR: "0",
      };
      const platform = ctx.options.platform ?? process.platform;
      const gh = resolveProgram("gh", { cwd: root, env: ghEnv, platform });
      let ghReady = false;
      if (gh && parsed.repo) {
        const status = await runArgv([gh, "auth", "status", "--hostname", parsed.host], {
          cwd: root,
          env: ghEnv,
          timeoutMs: 60_000,
          platform,
        });
        ghReady = !status.failedToStart && !status.timedOut && status.exitCode === 0;
      }
      if (!ghReady) {
        let patch = files
          .filter((f) => !f.machine || Buffer.byteLength(f.after) <= MAX_LOCK_IN_PATCH)
          .map((f) => unifiedDiff(f.path, f.before, f.after))
          .join("");
        const lockLeftOut = files.some(
          (f) => f.machine && Buffer.byteLength(f.after) > MAX_LOCK_IN_PATCH,
        );
        if (patch.length > MAX_PATCH) patch = "";
        const why = !gh
          ? "gh (GitHub CLI) is not installed"
          : !parsed.repo
            ? "the remote is not an owner/repository on a GitHub host"
            : `gh is not signed in to ${parsed.host}`;
        const commands = [
          `git switch -c ${branch}`,
          `git add -- ${files.map((f) => f.path).join(" ")}`,
          `git commit -m ${quoted(title)}`,
          `git push -u ${args.remote} ${branch}`,
          `gh pr create --draft --base ${base} --head ${branch} --title ${quoted(title)} --body-file harbyn-pr.md`,
        ];
        const data: Out = {
          ...empty,
          status: "patch",
          branch,
          remote,
          base,
          title,
          files: fileList,
          checksOnExactlyTheseFiles: shownChecks,
          patch: patch === "" ? null : patch,
          body,
          commands,
          note: `Nothing was committed, pushed or opened: ${why}. The changes are already in the working tree. The person can open the pull request with the commands below (the body is in body; save it as harbyn-pr.md), or sign in with gh auth login and ask again.${lockLeftOut ? ` ${LOCKFILE} is too large for the patch: it is in the working tree.` : ""}${patch === "" ? " The patch is too large to return: the changes are in the working tree." : ""}`,
        };
        return {
          data,
          text: [
            data.note,
            ...fence("commands for the person", commands),
            ...(data.patch
              ? ["Patch (repository text):", ...fence("patch", data.patch.split("\n"))]
              : []),
            DATA_RULE,
          ].join("\n"),
        };
      }

      const summary = [
        "Harbyn will open a draft pull request:",
        `  branch: ${branch} (new; built with git plumbing: your checkout, index and current branch${current ? ` (${clean(current, 200)})` : ""} are not touched)`,
        `  on top of: ${head.slice(0, 12)}, which is on ${clean(args.remote, 100)}/${base}`,
        `  push: only this branch to ${clean(args.remote, 100)} = ${parsed.display} (no force)`,
        `  pull request: draft, into ${base} of ${parsed.host}/${parsed.repo}, with your own gh`,
        `  title: ${title}`,
        "  files (exactly what apply_fix wrote, sha256 after):",
        ...files.map((f) => `    ${clean(f.path, 1024)} ${f.sha256After.slice(0, 16)}`),
        checks.length > 0
          ? `  checks on exactly these files: ${checks.map((c) => `${c.check} ${c.timedOut ? "timed out" : c.exitCode === 0 ? "passed" : `failed (${c.exitCode})`}`).join(", ")}`
          : "  checks on exactly these files: none (the pull request says so)",
        "Harbyn never merges, approves or reopens a pull request.",
      ].join("\n");
      if (summary.length > MAX_SUMMARY_CHARS)
        return {
          error: "this pull request is too large to show the person in full: commit it yourself",
        };
      const bodyHash = createHash("sha256").update(body).digest("hex");
      const binding = bindingOf({
        kind: "open_pr",
        root,
        eventId: args.eventId,
        branch,
        remote: args.remote,
        url: rawUrl,
        base,
        head,
        files: files.map((f) => [f.path, f.sha256After]),
        title,
        bodyHash,
      });
      const asked = elicitationOf(session);
      const settings = readSettings(ctx.options.configDir ?? configDir());
      if (!asked && !settings.tokenConfirmation) return { error: NO_ELICITATION };
      const base0 = {
        ...empty,
        branch,
        remote,
        base,
        title,
        files: fileList,
        checksOnExactlyTheseFiles: shownChecks,
        body,
      };
      if (asked && session) {
        if ((await elicit(session, asked, summary, "Open this draft pull request")) !== "yes") {
          const data: Out = {
            ...base0,
            status: "declined",
            note: "The person did not confirm: nothing was committed, pushed or opened.",
          };
          return { data, text: data.note };
        }
      } else if (!args.confirmationToken) {
        const issued = ctx.confirmations.issue(binding);
        const data: Out = {
          ...base0,
          status: "needs-confirmation",
          confirmation: { token: issued.token, expiresAt: issued.expiresAt, summary },
          note: "Nothing was done yet. Show the person this summary exactly. Only if they say yes, call open_pr again with the same eventId and remote and this confirmationToken. It works once, for exactly this pull request, for 10 minutes.",
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
      } else if (!ctx.confirmations.consume(args.confirmationToken, binding)) {
        return {
          error:
            "the confirmation token is unknown, already used, expired, or for a different pull request: nothing was done. Call open_pr again without it and ask the person again.",
        };
      }

      const again = await unsafeLocalConfig(root, env);
      if ("error" in again || again.keys.length > 0)
        return { error: "this repository's git config changed: nothing was done" };
      if (
        (await pushUrlOf(root, env, args.remote)) !== rawUrl ||
        (await revParse(root, env, "HEAD^{commit}")) !== head
      )
        return { error: "the remote or HEAD changed since the summary: nothing was done" };
      const bytes: Array<{ rel: string; bytes: Buffer }> = [];
      for (const f of files) {
        try {
          const now = fileForWrite(
            root,
            f.path,
            f.path === LOCKFILE ? MAX_LOCKFILE_BYTES : undefined,
          );
          if (now.sha256 !== f.sha256After)
            return { error: `${clean(f.path)} changed since the summary: nothing was done` };
          bytes.push({ rel: now.rel, bytes: Buffer.from(now.text, "utf8") });
        } catch {
          return { error: `${clean(f.path)} cannot be read: nothing was done` };
        }
      }
      const work = join(ctx.cacheDir(), "pr", randomBytes(6).toString("hex"));
      mkdirSync(work, { recursive: true, mode: 0o700 });
      try {
        const message = `${title}\n\nChange event ${args.eventId}, opened with harbyn mcp (open_pr).\nSource: ${records[0]?.evidence.source ?? ""}\n`;
        const made = await plumbingCommit(root, env, work, { parent: head, files: bytes, message });
        if ("error" in made) return { error: `nothing was pushed: ${made.error}` };
        const remoteState = await lsRemote(root, env, rawUrl, branch);
        if ("error" in remoteState) return { error: `nothing was pushed: ${remoteState.error}` };
        if (remoteState.defaultBranch !== base)
          return {
            error: `nothing was pushed: the remote's default branch is ${clean(remoteState.defaultBranch ?? "unknown", 200)}, not ${base} (git fetch, git remote set-head ${clean(args.remote, 100)} --auto)`,
          };
        if (remoteState.branchExists)
          return { error: `nothing was pushed: the branch ${branch} already exists on the remote` };
        if (
          remoteState.defaultTip &&
          remoteState.defaultTip !== tracking &&
          (await isAncestor(root, env, head, remoteState.defaultTip)) !== true
        ) {
          return { error: `nothing was pushed: ${base} moved on the remote; fetch, and ask again` };
        }
        const repoArg = `${parsed.host}/${parsed.repo}`;
        const listed = await runArgv(
          [
            gh as string,
            "pr",
            "list",
            "--repo",
            repoArg,
            "--head",
            branch,
            "--state",
            "all",
            "--json",
            "number,state,url",
            "--limit",
            "20",
          ],
          {
            cwd: root,
            env: ghEnv,
            timeoutMs: NETWORK_TIMEOUT_MS,
            platform,
          },
        );
        let existing: unknown;
        try {
          existing = JSON.parse(listed.output);
        } catch {
          existing = undefined;
        }
        if (listed.exitCode !== 0 || !Array.isArray(existing))
          return {
            error: "nothing was pushed: gh could not list the pull requests for this branch",
          };
        if (existing.length > 0)
          return {
            error: `nothing was pushed: a pull request for ${branch} exists or was closed; Harbyn never reopens one (closing it is how a team says no)`,
          };
        if (!(await createBranch(root, env, branch, made.commit)))
          return {
            error: `nothing was pushed: the branch ${branch} could not be created (it may exist now)`,
          };
        const pushed = await pushBranch(root, env, rawUrl, branch);
        if (pushed.failedToStart || pushed.timedOut || pushed.exitCode !== 0) {
          const tail = clean(pushed.output.split(rawUrl).join(parsed.display).slice(-600), 600);
          return {
            error: `the push failed; the local branch ${branch} exists (git branch -D ${branch} removes it). git said: ${tail}`,
          };
        }
        const bodyFile = join(work, "body.md");
        writeFileSync(bodyFile, body, { encoding: "utf8", mode: 0o600 });
        const created = await runArgv(
          [
            gh as string,
            "pr",
            "create",
            "--draft",
            "--repo",
            repoArg,
            "--base",
            base,
            "--head",
            branch,
            "--title",
            title,
            "--body-file",
            bodyFile,
          ],
          {
            cwd: root,
            env: ghEnv,
            timeoutMs: NETWORK_TIMEOUT_MS,
            platform,
          },
        );
        const url =
          created.output.match(
            /https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+/,
          )?.[0] ?? null;
        ctx.pullRequests.set(args.eventId, { branch, url, commit: made.commit });
        const ledgerResult = appendLedger(ctx.cacheDir(), root, {
          at: ctx.now().toISOString(),
          tool: "open_pr",
          eventId: args.eventId,
          branch,
          commit: made.commit,
          parent: head,
          remote: parsed.display,
          base,
          pullRequest: url,
          files: fileList,
          checks: shownChecks,
        });
        const ledger =
          "error" in ledgerResult
            ? `Evidence not recorded: ${ledgerResult.error}.`
            : "Evidence recorded in the local ledger.";
        if (created.exitCode !== 0 || !url) {
          const data: Out = {
            ...base0,
            status: "patch",
            commit: made.commit,
            commands: [
              `gh pr create --draft --base ${base} --head ${branch} --title ${quoted(title)} --body-file harbyn-pr.md`,
            ],
            note: `The branch ${branch} was pushed, but gh could not open the pull request: the person opens it with the command below (the body is in body).`,
            ledger,
          };
          return {
            data,
            text: [data.note, ...fence("commands for the person", data.commands), ledger].join(
              "\n",
            ),
          };
        }
        const data: Out = {
          ...base0,
          status: "opened",
          commit: made.commit,
          pullRequest: { url, draft: true },
          note: `Draft pull request opened: ${url}. Nothing in the checkout changed. Undo: close it and delete the branch (git push ${args.remote} --delete ${branch}; git branch -D ${branch}).`,
          ledger,
        };
        return { data, text: [data.note, ledger].join("\n") };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  });
