import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppliedRecord, CheckRecord, McpOptions } from "../src/mcp/context.ts";
import { resolveProgram } from "../src/mcp/exec.ts";
import {
  emptyHooksDir,
  parseRemoteUrl,
  pushBranch,
  safeConfigKey,
  safeGitEnv,
} from "../src/mcp/git.ts";
import { branchFor, checksOnExactly, committedFiles, prBody } from "../src/mcp/open-pr.ts";
import { greedyEngine } from "./mcp-fake-engine.ts";
import { EVENTS } from "./mcp-fixtures.ts";
import { elicitingSession, gitRepo, paidEngine, setup } from "./mcp-harness.ts";

const BRANCH = branchFor(EVENTS.swap);
const yes = () => elicitingSession({ action: "accept", content: { confirm: true } }).session;
const no = () => elicitingSession({ action: "decline" }).session;

const run = (
  cwd: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const git = (cwd: string, ...args: string[]): string =>
  run(cwd, "git", [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "-c",
    "core.autocrlf=false",
    ...args,
  ]);
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

const snapshot = (dir: string): string =>
  JSON.stringify(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((p) => !p.split(/[\\/]/).includes(".git"))
      .sort()
      .map((p) => [p, statSync(join(dir, p)).isFile() ? sha(join(dir, p)) : "dir"]),
  );

const checkout = (root: string) => ({
  head: git(root, "rev-parse", "HEAD").trim(),
  branch: git(root, "symbolic-ref", "--short", "HEAD").trim(),
  index: sha(join(root, ".git", "index")),
  branches: git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  tree: snapshot(root),
});

let fakeBin = "";
let gitOnly = "";

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const exe = join(fakeBin, process.platform === "win32" ? "gh.exe" : "gh");
  copyFileSync(process.execPath, exe);
  chmodSync(exe, 0o755);
  writeFileSync(
    join(fakeBin, "fake-gh.cjs"),
    [
      'const fs = require("fs"), path = require("path"), cp = require("child_process");',
      'const args = [path.basename(process.argv[1] || ""), ...process.argv.slice(2)];',
      'fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, gitConfigCount: process.env.GIT_CONFIG_COUNT || null, allow: process.env.GIT_ALLOW_PROTOCOL || null }) + "\\n");',
      'if (args[0] === "auth") process.exit(process.env.FAKE_GH_AUTH === "no" ? 1 : 0);',
      'if (args[0] === "pr" && args[1] === "list") { process.stdout.write(process.env.FAKE_GH_LIST || "[]"); process.exit(0); }',
      'if (args[0] === "pr" && args[1] === "create") {',
      "  // gh runs git itself (status, remote): those processes inherit the settings and must not run the repository's hooks either.",
      '  cp.spawnSync("git", ["status", "--porcelain"], { cwd: process.cwd(), env: process.env, stdio: "ignore" });',
      '  const bodyFile = args[args.indexOf("--body-file") + 1];',
      '  fs.writeFileSync(process.env.FAKE_GH_LOG + ".body", fs.readFileSync(bodyFile, "utf8"));',
      '  process.stdout.write("https://github.com/acme/app/pull/7\\n"); process.exit(0);',
      "}",
      "process.exit(2);",
    ].join("\n"),
  );
  const realGit = resolveProgram("git", {
    cwd: tmpdir(),
    env: process.env,
    platform: process.platform,
  });
  if (!realGit) throw new Error("git is needed for these tests");
  if (process.platform === "win32") {
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    gitOnly = (process.env[pathKey] ?? "")
      .split(delimiter)
      .filter((d) => d !== "" && !existsSync(join(d, "gh.exe")))
      .join(delimiter);
  } else {
    gitOnly = mkdtempSync(join(tmpdir(), "git-only-"));
    symlinkSync(realGit, join(gitOnly, "git"));
  }
}, 120_000);

const world = (
  o: {
    files?: Record<string, string>;
    gh?: "yes" | "missing" | "signed-out";
    list?: string;
    env?: Record<string, string>;
    schemes?: "server";
  } = {},
) => {
  const root = gitRepo(o.files ?? {});
  git(root, "branch", "-M", "main");
  const remote = join(mkdtempSync(join(tmpdir(), "remote-")), "app.git");
  git(dirname(remote), "init", "-q", "--bare", "app.git");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const url = pathToFileURL(remote).href;
  git(root, "remote", "add", "origin", url);
  git(root, "push", "-q", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
  const log = join(mkdtempSync(join(tmpdir(), "gh-log-")), "calls.jsonl");
  writeFileSync(log, "");
  const pathDirs = o.gh === "missing" ? [gitOnly] : [fakeBin, gitOnly];
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: pathDirs.join(delimiter),
    Path: undefined,
    NODE_OPTIONS: `--require "${join(fakeBin, "fake-gh.cjs").replaceAll("\\", "/")}"`,
    FAKE_GH_LOG: log,
    FAKE_GH_AUTH: o.gh === "signed-out" ? "no" : "yes",
    FAKE_GH_LIST: o.list ?? "[]",
    GIT_AUTHOR_NAME: "Person",
    GIT_AUTHOR_EMAIL: "person@example.com",
    GIT_COMMITTER_NAME: "Person",
    GIT_COMMITTER_EMAIL: "person@example.com",
    ...o.env,
  };
  const p = paidEngine(greedyEngine());
  const over: Partial<McpOptions> = {
    ...p.over,
    env,
    ...(o.schemes === "server" ? {} : { pushSchemes: ["https", "ssh", "file"] as const }),
  };
  const s = setup(root, over, p.n);
  const calls = (): Array<{
    args: string[];
    gitConfigCount: string | null;
    allow: string | null;
  }> =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { root, remote, url, s, log, calls, over, p };
};

type World = ReturnType<typeof world>;

const applySwap = async (w: World): Promise<void> => {
  const scan = await w.s.call("scan", { all: true });
  const f = (scan.structured.findings as Array<{ path: string; findingId: string }>).find(
    (x) => x.path === "src/ai.ts",
  );
  const plan = await w.s.call("plan_fix", { findingId: f?.findingId });
  const r = await w.s.call("apply_fix", { planIds: [plan.structured.planId] }, yes());
  expect(r.structured.status, r.text).toBe("applied");
};

const remoteBranches = (remote: string): string =>
  git(remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");

describe("open_pr: the commit is plumbing, the checkout never moves", { timeout: 120_000 }, () => {
  it("commits exactly what apply_fix wrote on a new branch, pushes only it, opens a draft; HEAD, the index, the tree and the branch stay", async () => {
    const w = world();
    await applySwap(w);
    const before = checkout(w.root);
    const remoteBefore = remoteBranches(w.remote);
    const r = await w.s.call("open_pr", { eventId: EVENTS.swap }, yes());
    expect(r.structured, r.text).toMatchObject({
      status: "opened",
      branch: BRANCH,
      base: "main",
      pullRequest: { url: "https://github.com/acme/app/pull/7", draft: true },
    });
    const after = checkout(w.root);
    expect({ ...after, branches: undefined }).toEqual({ ...before, branches: undefined });
    const lines = (s: string) => s.split("\n").filter(Boolean).sort();
    expect(lines(after.branches)).toEqual(
      lines(`${before.branches}refs/heads/${BRANCH} ${r.structured.commit}\n`),
    );
    expect(lines(remoteBranches(w.remote))).toEqual(
      lines(`${remoteBefore}refs/heads/${BRANCH} ${r.structured.commit}\n`),
    );
    const commit = String(r.structured.commit);
    expect(git(w.root, "rev-parse", `${commit}^`).trim()).toBe(before.head);
    expect(git(w.root, "diff-tree", "-r", "--name-only", "--no-commit-id", commit).trim()).toBe(
      "src/ai.ts",
    );
    expect(git(w.root, "show", `${commit}:src/ai.ts`)).toBe(
      readFileSync(join(w.root, "src/ai.ts"), "utf8"),
    );
    const verbs = w.calls().map((c) => c.args.slice(0, 2).join(" "));
    expect(verbs).toEqual(["auth status", "pr list", "pr create"]);
    const create = w.calls()[2]?.args ?? [];
    expect(create).toContain("--draft");
    expect(create.slice(create.indexOf("--base"), create.indexOf("--base") + 2)).toEqual([
      "--base",
      "main",
    ]);
    expect(create.slice(create.indexOf("--head"), create.indexOf("--head") + 2)).toEqual([
      "--head",
      BRANCH,
    ]);
    expect(w.calls().flatMap((c) => c.args)).not.toContain("merge");
    expect((await w.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
      /one per change/,
    );
  });

  it("refuses an existing branch, locally or on the remote, and a default branch that is the target; nothing moves", async () => {
    const local = world();
    await applySwap(local);
    git(local.root, "branch", BRANCH, "main");
    const before = checkout(local.root);
    expect((await local.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
      /already exists in this clone/,
    );
    expect(checkout(local.root)).toEqual(before);

    const onRemote = world();
    await applySwap(onRemote);
    git(onRemote.root, "push", "-q", "origin", `main:refs/heads/${BRANCH}`);
    const remoteBefore = remoteBranches(onRemote.remote);
    const r = await onRemote.s.call("open_pr", { eventId: EVENTS.swap }, yes());
    expect(r.text).toMatch(/already exists on the remote/);
    expect(remoteBranches(onRemote.remote)).toBe(remoteBefore);
    expect(git(onRemote.root, "branch", "--list", BRANCH).trim()).toBe("");

    const asDefault = world();
    await applySwap(asDefault);
    git(asDefault.root, "update-ref", `refs/remotes/origin/${BRANCH}`, "HEAD");
    git(
      asDefault.root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${BRANCH}`,
    );
    expect((await asDefault.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
      /default branch: refused/,
    );
  });

  it("never forces: the push has no --force and no '+' refspec, and a closed pull request for the branch stops it before any push", async () => {
    const code = ["git.ts", "open-pr.ts"]
      .map((f) => readFileSync(resolve(import.meta.dirname, "..", "src", "mcp", f), "utf8"))
      .join("\n")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(
      /["'`]-f["'`]|--force["'`]|--force-with-lease["'`]|["'`]\+refs|["'`]\+\$\{/,
    );
    expect([...code.matchAll(/--force-with-lease=([^"'`]*)/g)].map((m) => m[1])).toEqual([
      "refs/heads/${branch}:",
    ]);
    expect([...code.matchAll(/"pr",\s*"([a-z-]+)"/g)].map((m) => m[1]).sort()).toEqual([
      "create",
      "list",
    ]);
    const w = world({
      list: JSON.stringify([
        { number: 3, state: "CLOSED", url: "https://github.com/acme/app/pull/3" },
      ]),
    });
    await applySwap(w);
    const remoteBefore = remoteBranches(w.remote);
    const r = await w.s.call("open_pr", { eventId: EVENTS.swap }, yes());
    expect(r.text).toMatch(/exists or was closed; Harbyn never reopens/);
    expect(remoteBranches(w.remote)).toBe(remoteBefore);
    expect(w.calls().map((c) => c.args[1])).not.toContain("create");
  });

  it("a migration's package.json and lockfile (over 1 MB) are committed with exactly the recorded hashes, the lockfile summarised", async () => {
    const lockOf = (v: string) =>
      `${JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/fakesdk": { version: v }, pad: { note: "x".repeat(1_200_000) } } })}\n`;
    const pkgOf = (v: string) => `${JSON.stringify({ dependencies: { fakesdk: v } })}\n`;
    const w = world({
      files: { "package.json": pkgOf("1.4.0"), "package-lock.json": lockOf("1.4.0") },
    });
    const write = (path: string, text: string) => {
      const before = readFileSync(join(w.root, path), "utf8");
      writeFileSync(join(w.root, path), text);
      return {
        path,
        sha256Before: createHash("sha256").update(before).digest("hex"),
        sha256After: createHash("sha256").update(text).digest("hex"),
        before,
        after: text,
        lines: [],
        machine: path === "package-lock.json",
      };
    };
    w.s.ctx.applied.push({
      at: "2026-10-11T12:00:00Z",
      eventId: EVENTS.swap,
      planId: "p_00000000000000aa",
      mode: "recipe",
      recipeId: `migration:${EVENTS.swap}`,
      engineSha256: w.p.sha,
      evidence: {
        source: "https://acme.example/changelog",
        reviewState: "automated, deterministic",
        feedGeneratedAt: "2026-10-11T00:00:00Z",
        harbynUrl: "https://harbyn.com/changes/x",
      },
      risk: "medium",
      files: [write("package.json", pkgOf("2.0.0")), write("package-lock.json", lockOf("2.0.0"))],
      leftAlone: [],
      upgrades: [{ package: "fakesdk", installed: "1.4.0", to: "2.0.0", eventId: EVENTS.swap }],
    });
    const r = await w.s.call("open_pr", { eventId: EVENTS.swap }, yes());
    expect(r.structured, r.text).toMatchObject({ status: "opened" });
    const commit = String(r.structured.commit);
    expect(
      git(w.root, "diff-tree", "-r", "--name-only", "--no-commit-id", commit)
        .trim()
        .split("\n")
        .sort(),
    ).toEqual(["package-lock.json", "package.json"]);
    expect(git(w.root, "show", `${commit}:package-lock.json`)).toBe(lockOf("2.0.0"));
    const body = readFileSync(`${w.log}.body`, "utf8");
    expect(body).toContain("`package-lock.json`: regenerated by npm");
    expect(body).not.toContain("xxxxxxxx");
  });

  it("the push is create-only: a branch that appears on the remote after the ls-remote check is not overwritten", async () => {
    const w = world();
    git(w.root, "push", "-q", "origin", `main:refs/heads/${BRANCH}`);
    const theirs = git(w.remote, "rev-parse", `refs/heads/${BRANCH}`).trim();
    writeFileSync(join(w.root, "extra.txt"), "x\n");
    git(w.root, "add", "extra.txt");
    git(w.root, "commit", "-qm", "ours");
    git(w.root, "branch", "-f", BRANCH, "HEAD");
    const env = safeGitEnv(process.env, {
      hooksDir: emptyHooksDir(mkdtempSync(join(tmpdir(), "hooks-"))),
      schemes: ["https", "ssh", "file"],
    });
    const pushed = await pushBranch(w.root, env, w.url, BRANCH);
    expect(pushed.exitCode).not.toBe(0);
    expect(git(w.remote, "rev-parse", `refs/heads/${BRANCH}`).trim()).toBe(theirs);
    const fresh = world();
    git(fresh.root, "branch", BRANCH, "main");
    const created = await pushBranch(fresh.root, env, fresh.url, BRANCH);
    expect(created.exitCode, created.output).toBe(0);
    expect(remoteBranches(fresh.remote)).toContain(`refs/heads/${BRANCH}`);
  });

  it("a remote name that is not valid is refused before anything is built from it, the commands for the person included", async () => {
    const w = world();
    for (const remote of ["-oevil", "origin;rm", "a b", "../x"]) {
      const r = await w.s.call("open_pr", { eventId: EVENTS.swap, remote }, yes());
      expect(r.text, remote).toMatch(/remote name is not valid/);
      expect(JSON.stringify(r.structured ?? {})).not.toContain(remote);
    }
  });

  it("HEAD with commits that are not on origin/main is refused: the pull request may contain only Harbyn's commit", async () => {
    const w = world({ files: { "notes.md": "a\n" } });
    await applySwap(w);
    writeFileSync(join(w.root, "notes.md"), "b\n");
    git(w.root, "commit", "-qm", "local only", "--", "notes.md");
    expect((await w.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
      /not on origin\/main|not what apply_fix changed/,
    );
  });
});

describe(
  "open_pr: hostile git config cannot run or redirect anything",
  { timeout: 120_000 },
  () => {
    const marker = () => join(mkdtempSync(join(tmpdir(), "marker-")), "ran").replaceAll("\\", "/");
    const hook = (root: string, name: string, file: string, dir = join(root, ".git", "hooks")) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> "${file}"\n`);
      chmodSync(join(dir, name), 0o755);
    };

    it("hooks (in .git/hooks and a core.hooksPath such as husky's) and fsmonitor never run, in git or in the git gh starts", async () => {
      const w = world();
      await applySwap(w);
      const ran = marker();
      for (const name of [
        "pre-push",
        "reference-transaction",
        "post-commit",
        "pre-commit",
        "post-index-change",
      ])
        hook(w.root, name, ran);
      hook(w.root, "pre-push", ran, join(w.root, ".husky"));
      git(w.root, "config", "core.hooksPath", ".husky");
      const monitor = join(w.root, "..", `fsmonitor-${Date.now()}.sh`);
      writeFileSync(monitor, `#!/bin/sh\necho fsmonitor >> "${ran}"\n`);
      chmodSync(monitor, 0o755);
      git(w.root, "config", "core.fsmonitor", monitor.replaceAll("\\", "/"));
      const r = await w.s.call("open_pr", { eventId: EVENTS.swap }, yes());
      expect(r.structured.status, r.text).toBe("opened");
      expect(existsSync(ran)).toBe(false);
      for (const c of w.calls())
        expect(c).toMatchObject({
          gitConfigCount: expect.stringMatching(/^\d+$/),
          allow: "https:ssh:file",
        });
      git(w.root, "push", "-q", "origin", `main:refs/heads/control-${Date.now()}`);
      expect(existsSync(ran)).toBe(true);
    });

    it("a url rewrite to file:// or ext::, a pushurl, a filter or a credential helper in the repository's config is refused before git runs anything", async () => {
      for (const [key, value, why] of [
        [`url.file:///tmp/evil.git.insteadOf`, "https://github.com/acme/app.git", /url\.file/],
        ["url.ext::sh -c touch% /tmp/pwned.insteadOf", "https://github.com/", /url\.ext/],
        ["credential.helper", "!sh -c 'touch /tmp/pwned'", /credential\.helper/],
        ["filter.evil.clean", "sh -c 'touch /tmp/pwned'", /filter\.evil\.clean/],
        ["core.sshCommand", "sh -c 'touch /tmp/pwned'", /core\.sshcommand/],
        ["include.path", "../evil.config", /include\.path/],
        ["diff.external", "sh -c 'touch /tmp/pwned'", /diff\.external/],
      ] as const) {
        const w = world();
        await applySwap(w);
        git(w.root, "config", key, value);
        const before = checkout(w.root);
        const r = await w.s.call("open_pr", { eventId: EVENTS.swap }, yes());
        expect(r.text, key).toMatch(why);
        expect(r.text).toMatch(/could run a program or redirect the push/);
        expect(checkout(w.root)).toEqual(before);
        expect(w.calls()).toEqual([]);
      }
    });

    it("a push URL that resolves to file:// or ext:: (pushurl, or a global rewrite) is refused with the server's https and ssh only", async () => {
      const server = world({ schemes: "server" });
      await applySwap(server);
      expect((await server.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
        /push URL is refused: file is not https or ssh/,
      );
      const w = world();
      await applySwap(w);
      git(w.root, "config", "remote.origin.pushurl", "ext::sh -c touch% /tmp/pwned");
      expect((await w.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
        /push URL is refused/,
      );
      git(w.root, "config", "remote.origin.pushurl", "ext::/tmp/pwned");
      expect((await w.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
        /remote helpers/,
      );
      const globalConfig = join(mkdtempSync(join(tmpdir(), "global-")), "gitconfig");
      const rewritten = world({ schemes: "server", env: { GIT_CONFIG_GLOBAL: globalConfig } });
      writeFileSync(
        globalConfig,
        `[url "${rewritten.url}"]\n\tinsteadOf = https://github.com/acme/app.git\n`,
      );
      git(rewritten.root, "remote", "set-url", "origin", "https://github.com/acme/app.git");
      await applySwap(rewritten);
      expect((await rewritten.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
        /push URL is refused: file is not https or ssh/,
      );
      for (const x of [server, w, rewritten]) {
        expect(remoteBranches(x.remote)).not.toMatch(/harbyn/);
        expect(x.calls().map((c) => c.args[1])).not.toContain("create");
      }
    });

    it("parses push URLs strictly and hides credentials", () => {
      const all = ["https", "ssh"] as const;
      expect(parseRemoteUrl("https://github.com/acme/app.git", all)).toEqual({
        scheme: "https",
        host: "github.com",
        repo: "acme/app",
        display: "https://github.com/acme/app.git",
      });
      expect(
        parseRemoteUrl("https://x-access-token:ghs_secret@github.com/acme/app.git", all),
      ).toMatchObject({ display: "https://***@github.com/acme/app.git" });
      expect(parseRemoteUrl("git@github.com:acme/app.git", all)).toMatchObject({
        scheme: "ssh",
        host: "github.com",
        repo: "acme/app",
      });
      expect(parseRemoteUrl("ssh://git@github.com/acme/app", all)).toMatchObject({
        scheme: "ssh",
        repo: "acme/app",
      });
      for (const bad of [
        "file:///tmp/x.git",
        "ext::sh -c id",
        "http://github.com/a/b",
        "git://github.com/a/b",
        "-oProxyCommand=x",
        "ssh://-oProxyCommand=x/a/b",
        "C:/repos/x.git",
        "/srv/x.git",
        "fd::17",
        `https://github.com/a/b${String.fromCodePoint(0x202e)}`,
      ]) {
        expect(parseRemoteUrl(bad, all), bad).toHaveProperty("error");
      }
      for (const ok of [
        "core.hookspath",
        "core.fsmonitor",
        "remote.origin.url",
        "remote.origin.pushurl",
        "branch.main.merge",
        "user.email",
        "lfs.repositoryformatversion",
      ])
        expect(safeConfigKey(ok), ok).toBe(true);
      for (const bad of [
        "credential.helper",
        "url.x.insteadof",
        "include.path",
        "includeif.gitdir:/x.path",
        "filter.lfs.process",
        "core.sshcommand",
        "core.gitproxy",
        "diff.x.textconv",
        "merge.x.driver",
        "remote.origin.receivepack",
        "http.proxy",
        "gpg.ssh.defaultkeycommand",
        "diff.external",
        "alias.x",
        "submodule.x.update",
        "sequence.editor",
      ]) {
        expect(safeConfigKey(bad), bad).toBe(false);
      }
    });
  },
);

describe(
  "open_pr: no gh, no confirmation, no paid change: nothing happens",
  { timeout: 120_000 },
  () => {
    it("gh missing or signed out: the patch, the pull request text and the commands; nothing committed or pushed", async () => {
      for (const gh of ["missing", "signed-out"] as const) {
        const w = world({ gh });
        await applySwap(w);
        const before = checkout(w.root);
        const r = await w.s.call("open_pr", { eventId: EVENTS.swap }, yes());
        expect(r.structured, r.text).toMatchObject({
          status: "patch",
          commit: null,
          pullRequest: null,
          branch: BRANCH,
        });
        expect(String(r.structured.note)).toMatch(
          gh === "missing" ? /not installed/ : /not signed in/,
        );
        expect(String(r.structured.patch)).toMatch(
          /^diff --git a\/src\/ai\.ts b\/src\/ai\.ts\n--- a\/src\/ai\.ts\n\+\+\+ b\/src\/ai\.ts\n@@ -1,3 \+1,3 @@/,
        );
        expect(String(r.structured.patch)).toContain(
          '-client.create({ model: "acme-1" });\n+client.create({ model: "acme-2" });',
        );
        expect(r.structured.commands).toEqual(
          expect.arrayContaining([`git switch -c ${BRANCH}`, `git push -u origin ${BRANCH}`]),
        );
        expect(String(r.structured.body)).toMatch(/### Changes/);
        expect(checkout(w.root)).toEqual(before);
        expect(remoteBranches(w.remote)).not.toMatch(/harbyn/);
        const copy = mkdtempSync(join(tmpdir(), "apply-"));
        git(copy, "clone", "-q", w.url, ".");
        writeFileSync(join(copy, "change.patch"), String(r.structured.patch));
        git(copy, "apply", "--check", "change.patch");
      }
    });

    it("confirmation is required: without elicitation and token mode off it refuses; a no does nothing; a token works once, for this pull request only", async () => {
      const w = world();
      await applySwap(w);
      const before = checkout(w.root);
      const settings = join(String(w.over.configDir), "mcp-settings.json");
      writeFileSync(settings, JSON.stringify({ tokenConfirmation: false }));
      expect((await w.s.call("open_pr", { eventId: EVENTS.swap })).text).toMatch(
        /cannot ask the person to confirm/,
      );
      expect((await w.s.call("open_pr", { eventId: EVENTS.swap }, no())).structured.status).toBe(
        "declined",
      );
      expect(checkout(w.root)).toEqual(before);
      expect(w.calls().map((c) => c.args[1])).not.toContain("create");
      writeFileSync(settings, JSON.stringify({ tokenConfirmation: true }));
      const first = await w.s.call("open_pr", { eventId: EVENTS.swap });
      expect(first.structured.status).toBe("needs-confirmation");
      const c = first.structured.confirmation as { token: string; summary: string };
      expect(c.summary).toContain(`branch: ${BRANCH}`);
      expect(c.summary).toContain(`origin = ${w.url}`);
      expect(c.summary).toContain("src/ai.ts");
      expect(c.summary).toContain("title: Harbyn: acme-1 retired (Acme, 2099-01-01)");
      expect(
        (
          await w.s.call("open_pr", {
            eventId: EVENTS.swap,
            remote: "upstream",
            confirmationToken: c.token,
          })
        ).text,
      ).toMatch(/push URL|token is unknown/);
      expect(checkout(w.root)).toEqual(before);
      const again = await w.s.call("open_pr", { eventId: EVENTS.swap });
      const token = (again.structured.confirmation as { token: string }).token;
      expect(
        (await w.s.call("open_pr", { eventId: EVENTS.swap, confirmationToken: token })).structured
          .status,
      ).toBe("opened");
    });

    it("a file changed after apply_fix, or edited by the agent itself, is not committed", async () => {
      const w = world();
      await applySwap(w);
      writeFileSync(
        join(w.root, "src/ai.ts"),
        `${readFileSync(join(w.root, "src/ai.ts"), "utf8")}// more\n`,
      );
      expect((await w.s.call("open_pr", { eventId: EVENTS.swap }, yes())).text).toMatch(
        /changed since apply_fix wrote it/,
      );
      expect(remoteBranches(w.remote)).not.toMatch(/harbyn/);
    });

    it("free plan: apply_fix writes nothing, so open_pr has nothing to commit and returns guidance only: no patch, no git, no gh", async () => {
      const root = gitRepo();
      const log = join(mkdtempSync(join(tmpdir(), "gh-log-")), "calls.jsonl");
      writeFileSync(log, "");
      const s = setup(root, {
        env: {
          ...process.env,
          PATH: [fakeBin, gitOnly].join(delimiter),
          NODE_OPTIONS: `--require "${join(fakeBin, "fake-gh.cjs").replaceAll("\\", "/")}"`,
          FAKE_GH_LOG: log,
        },
      });
      const scan = await s.call("scan", {});
      const f = (scan.structured.findings as Array<{ path: string; findingId: string }>).find(
        (x) => x.path === "src/ai.ts",
      );
      const plan = await s.call("plan_fix", { findingId: f?.findingId });
      expect(
        (await s.call("apply_fix", { planIds: [plan.structured.planId] }, yes())).structured.status,
      ).toBe("free-plan");
      writeFileSync(
        join(root, "src/ai.ts"),
        readFileSync(join(root, "src/ai.ts"), "utf8").replace("acme-1", "acme-2"),
      );
      const before = git(root, "for-each-ref", "refs/heads");
      const r = await s.call("open_pr", { eventId: EVENTS.swap }, yes());
      expect(r.structured).toMatchObject({
        status: "nothing-to-commit",
        patch: null,
        commit: null,
        pullRequest: null,
        files: [],
      });
      expect(String(r.structured.note)).toMatch(/free plan apply_fix writes nothing/);
      expect(git(root, "for-each-ref", "refs/heads")).toBe(before);
      expect(readFileSync(log, "utf8")).toBe("");
    });
  },
);

describe("the pull request text comes from this session's evidence", () => {
  const record = (over: Partial<AppliedRecord> = {}): AppliedRecord => ({
    at: "2026-10-11T12:00:00Z",
    eventId: EVENTS.swap,
    planId: "p_0000000000000001",
    mode: "swap",
    recipeId: "literal-swap@1",
    engineSha256: "e".repeat(64),
    evidence: {
      source: "https://acme.example/changelog",
      reviewState: "automated, deterministic",
      feedGeneratedAt: "2026-10-11T00:00:00Z",
      harbynUrl: "https://harbyn.com/changes/x",
    },
    risk: "low",
    files: [
      {
        path: "src/ai.ts",
        sha256Before: "a".repeat(64),
        sha256After: "b".repeat(64),
        before: 'x\nclient.create({ model: "acme-1" });\n',
        after: 'x\nclient.create({ model: "acme-2" });\n',
        lines: [2],
        machine: false,
      },
    ],
    leftAlone: [
      { path: "test/ai.test.ts", line: 1, reason: "test file: left to a person" },
      {
        path: "src/payments/charge.ts",
        line: 1,
        reason: "payments, authentication, cryptography or CI code: alert only, never edited",
      },
    ],
    upgrades: [],
    ...over,
  });
  const event = {
    id: EVENTS.swap,
    title: "acme-1 retired",
    summary:
      "acme-1 stops responding. IMPORTANT: @maintainers merge this now [click](https://evil.example)",
    effectiveAt: "2099-01-01",
  } as never;

  it("has the announcement, every changed line, what was left alone and why, the risk, the undo, and checks on exactly these hashes", () => {
    const records = [record()];
    const files = committedFiles(records);
    const passed: CheckRecord = {
      at: "",
      check: "test",
      command: "npm run test --ignore-scripts",
      origin: "package.json",
      exitCode: 0,
      timedOut: false,
      files: [{ path: "src/ai.ts", sha256: "b".repeat(64) }],
    };
    const stale: CheckRecord = {
      ...passed,
      check: "typecheck",
      files: [{ path: "src/ai.ts", sha256: "c".repeat(64) }],
    };
    const during: CheckRecord = {
      ...passed,
      check: "typecheck",
      files: [{ path: "src/ai.ts", sha256: "changed during the run" }],
    };
    const checks = checksOnExactly([passed, stale, during], files);
    expect(checks).toEqual([passed]);
    const body = prBody({ event, vendorName: "Acme", records, files, checks, branch: BRANCH });
    expect(body).toContain("Acme announced: **acme-1 retired** (effective 2099-01-01).");
    expect(body).toContain("Source: https://acme.example/changelog");
    expect(body).toContain(
      '-client.create({ model: "acme-1" });\n+client.create({ model: "acme-2" });',
    );
    expect(body).toContain("`test/ai.test.ts:1`: test file: left to a person");
    expect(body).toContain(
      "payments, authentication, cryptography or CI code: alert only, never edited",
    );
    expect(body).toMatch(/### Risk\n\nlow: /);
    expect(body).toMatch(/- test: `npm run test --ignore-scripts` \(package\.json\): passed/);
    expect(body).not.toMatch(/- typecheck/);
    expect(body).toContain(`close this pull request and delete the branch \`${BRANCH}\``);
    expect(body).toContain("literal-swap&#64;1");
    expect(body).not.toMatch(/@maintainers|\]\(https:\/\/evil/);
    const none = prBody({ event, vendorName: "Acme", records, files, checks: [], branch: BRANCH });
    expect(none).toContain("No checks were run on exactly these files.");
  });

  it("a migration lists the upgrades and the lockfile as regenerated, never line by line", () => {
    const records = [
      record({
        mode: "recipe",
        recipeId: "migration:x",
        upgrades: [{ package: "fakesdk", installed: "1.4.0", to: "2.0.0", eventId: EVENTS.swap }],
        files: [
          {
            path: "package-lock.json",
            sha256Before: "a".repeat(64),
            sha256After: "b".repeat(64),
            before: "{}\n",
            after: '{"x":1}\n',
            lines: [],
            machine: true,
          },
        ],
      }),
    ];
    const body = prBody({
      event,
      vendorName: "Acme",
      records,
      files: committedFiles(records),
      checks: [],
      branch: BRANCH,
    });
    expect(body).toContain("`fakesdk` 1.4.0 to 2.0.0");
    expect(body).toContain("`package-lock.json`: regenerated by npm");
    expect(body).not.toContain('{"x":1}');
  });
});
