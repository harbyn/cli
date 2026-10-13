import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobId, runArgv, type RunResult } from "./exec.ts";

export const GIT_TIMEOUT_MS = 30_000;
export const NETWORK_TIMEOUT_MS = 3 * 60_000;
export type Scheme = "https" | "ssh" | "file";
export const DEFAULT_SCHEMES: readonly Scheme[] = ["https", "ssh"];

const REDIRECTS =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|ALLOW_PROTOCOL|PROTOCOL_FROM_USER|EXTERNAL_DIFF|EXEC_PATH|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|.*PATHSPECS|OPTIONAL_LOCKS|TERMINAL_PROMPT|SHALLOW_FILE|QUARANTINE_PATH|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|TEMPLATE_DIR)$/i;

export interface GitSafety {
  hooksDir: string;
  schemes: readonly Scheme[];
}

export const safeGitEnv = (
  base: Record<string, string | undefined>,
  safety: GitSafety,
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !REDIRECTS.test(k)) env[k] = v;
  const settings: Array<[string, string]> = [
    ["core.hooksPath", safety.hooksDir],
    ["core.fsmonitor", "false"],
    ["core.untrackedCache", "false"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["push.gpgSign", "false"],
    ["push.recurseSubmodules", "no"],
    ["submodule.recurse", "false"],
    ["http.sslVerify", "true"],
    ["protocol.allow", "never"],
    ["core.askPass", ""],
  ];
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_ALLOW_PROTOCOL = safety.schemes.join(":");
  env.GIT_PROTOCOL_FROM_USER = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_LITERAL_PATHSPECS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return { ...env, ...extra };
};

export const emptyHooksDir = (cacheDir: string): string => {
  const dir = join(cacheDir, "mcp-no-hooks");
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || readdirSync(dir).length > 0)
      rmSync(dir, { recursive: true, force: true });
  } catch {}
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

export const git = (
  root: string,
  env: Record<string, string>,
  args: readonly string[],
  o: { timeoutMs?: number; tailBytes?: number } = {},
): Promise<RunResult> =>
  runArgv(["git", ...args], {
    cwd: root,
    env,
    timeoutMs: o.timeoutMs ?? GIT_TIMEOUT_MS,
    tailBytes: o.tailBytes ?? 256 * 1024,
  });

const ok = (r: RunResult): boolean =>
  !r.failedToStart && !r.timedOut && r.exitCode === 0 && !r.truncated;

const SAFE_SECTIONS = new Set([
  "core",
  "extensions",
  "remote",
  "branch",
  "user",
  "pull",
  "push",
  "fetch",
  "init",
  "gc",
  "maintenance",
  "rerere",
  "color",
  "merge",
  "diff",
  "status",
  "log",
  "advice",
  "help",
  "i18n",
  "checkout",
  "submodule",
  "lfs",
  "blame",
  "column",
  "format",
  "feature",
  "index",
  "pack",
  "transfer",
  "rebase",
  "stash",
  "commit",
  "tag",
  "gui",
  "interactive",
  "apply",
  "am",
  "worktree",
  "ssh",
  "clone",
  "gpg",
]);
const UNSAFE_NAMES = new Set([
  "textconv",
  "driver",
  "process",
  "clean",
  "smudge",
  "helper",
  "gitproxy",
  "askpass",
  "editor",
  "pager",
  "insteadof",
  "pushinsteadof",
  "proxy",
  "proxyauthmethod",
  "receivepack",
  "uploadpack",
  "vcs",
  "update",
  "packobjectshook",
  "external",
  "externaldiff",
  "cookiefile",
  "extraheader",
  "sslverify",
  "sslcainfo",
  "sslcapath",
  "sslcert",
  "sslkey",
  "excludesfile",
  "attributesfile",
  "worktree",
  "notesref",
]);

export const safeConfigKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  const first = lower.indexOf(".");
  const last = lower.lastIndexOf(".");
  if (first <= 0 || last === lower.length - 1) return false;
  const section = lower.slice(0, first);
  const name = lower.slice(last + 1);
  if (!SAFE_SECTIONS.has(section) || UNSAFE_NAMES.has(name)) return false;
  return !/(command|cmd|program)$/.test(name);
};

export const unsafeLocalConfig = async (
  root: string,
  env: Record<string, string>,
): Promise<{ keys: string[] } | { error: string }> => {
  const r = await git(root, env, ["config", "--list", "--show-scope", "--name-only", "-z"]);
  if (!ok(r))
    return { error: "git could not list this repository's settings (git 2.26 or later is needed)" };
  const parts = r.output.split(String.fromCharCode(0));
  const keys = new Set<string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] as string;
    const key = parts[i + 1] as string;
    if ((scope === "local" || scope === "worktree") && !safeConfigKey(key)) keys.add(key);
  }
  return { keys: [...keys].sort() };
};

export interface RemoteUrl {
  scheme: Scheme;
  host: string;
  repo: string | null;
  display: string;
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const printable = (s: string): boolean =>
  [...s].every((c) => (c.codePointAt(0) ?? 0) > 0x20 && (c.codePointAt(0) ?? 0) < 0x7f);

const repoOf = (path: string): string | null => {
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  return parts.length === 2 &&
    parts.every((p) => SEGMENT.test(p) && !p.startsWith("-") && p !== "." && p !== "..")
    ? parts.join("/")
    : null;
};

export const parseRemoteUrl = (
  url: string,
  schemes: readonly Scheme[],
): RemoteUrl | { error: string } => {
  const refuse = (why: string) => ({ error: `the push URL is refused: ${why}` });
  if (url.length === 0 || url.length > 2048 || !printable(url))
    return refuse("empty, too long, or with spaces, control or non-ASCII characters");
  if (url.startsWith("-")) return refuse("it looks like an option");
  if (url.includes("::")) return refuse("remote helpers (transport::address) are not used");
  const scp = url.match(/^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) && scp) {
    const host = scp[2] as string;
    const path = scp[3] as string;
    if (host.length < 2 || !HOST.test(host)) return refuse("not an ssh host");
    if (!schemes.includes("ssh")) return refuse("ssh is not allowed");
    if (path.startsWith("-") || path.split("/").includes("..")) return refuse("unexpected path");
    return {
      scheme: "ssh",
      host,
      repo: repoOf(path),
      display: `${scp[1] ? `${scp[1]}@` : ""}${host}:${path}`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse("not an https or ssh URL");
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme !== "https" && scheme !== "ssh" && scheme !== "file")
    return refuse(`${scheme.slice(0, 20)} is not https or ssh`);
  if (!schemes.includes(scheme)) return refuse(`${scheme} is not https or ssh`);
  if (scheme === "file") {
    if (parsed.host !== "") return refuse("a file URL with a host");
    return {
      scheme,
      host: "localhost",
      repo: repoOf(decodeURIComponent(parsed.pathname).split("/").slice(-2).join("/")),
      display: parsed.href,
    };
  }
  const host = parsed.hostname;
  if (!HOST.test(host)) return refuse("not a host name");
  const userinfo = parsed.username !== "" || parsed.password !== "";
  const user =
    scheme === "ssh" && parsed.username !== "" && parsed.password === ""
      ? `${parsed.username}@`
      : userinfo
        ? "***@"
        : "";
  return {
    scheme,
    host,
    repo: repoOf(decodeURIComponent(parsed.pathname)),
    display: `${scheme}://${user}${parsed.host}${parsed.pathname}`,
  };
};

const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const validRemoteName = (name: string): boolean => REMOTE.test(name) && !name.includes("..");
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const validBranch = (name: string): boolean =>
  BRANCH.test(name) &&
  !name.includes("..") &&
  !name.includes("//") &&
  !name.endsWith("/") &&
  !name.endsWith(".lock") &&
  !name.endsWith(".");

export const pushUrlOf = async (
  root: string,
  env: Record<string, string>,
  remote: string,
): Promise<string | undefined> => {
  const r = await git(root, env, ["remote", "get-url", "--push", "--", remote]);
  if (!ok(r)) return undefined;
  const lines = r.output.split(/\r?\n/).filter((l) => l !== "");
  return lines.length === 1 ? lines[0] : undefined;
};

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const revParse = async (
  root: string,
  env: Record<string, string>,
  rev: string,
): Promise<string | undefined> => {
  const r = await git(root, env, ["rev-parse", "--verify", "--quiet", "--end-of-options", rev]);
  const id = r.output.trim();
  return ok(r) && OID.test(id) ? id : undefined;
};

export const defaultBranchOf = async (
  root: string,
  env: Record<string, string>,
  remote: string,
): Promise<string | undefined> => {
  const r = await git(root, env, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  const ref = r.output.trim();
  const prefix = `refs/remotes/${remote}/`;
  if (!ok(r) || !ref.startsWith(prefix)) return undefined;
  const name = ref.slice(prefix.length);
  return validBranch(name) ? name : undefined;
};

export const currentBranch = async (
  root: string,
  env: Record<string, string>,
): Promise<string | null> => {
  const r = await git(root, env, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return ok(r) ? r.output.trim() || null : null;
};

export const refExists = async (
  root: string,
  env: Record<string, string>,
  ref: string,
): Promise<boolean | undefined> => {
  const r = await git(root, env, ["show-ref", "--verify", "--quiet", ref]);
  if (r.failedToStart || r.timedOut) return undefined;
  return r.exitCode === 0 ? true : r.exitCode === 1 ? false : undefined;
};

export const isAncestor = async (
  root: string,
  env: Record<string, string>,
  ancestor: string,
  of: string,
): Promise<boolean | undefined> => {
  const r = await git(root, env, ["merge-base", "--is-ancestor", ancestor, of]);
  if (r.failedToStart || r.timedOut) return undefined;
  return r.exitCode === 0 ? true : r.exitCode === 1 ? false : undefined;
};

export const lsRemote = async (
  root: string,
  env: Record<string, string>,
  url: string,
  branch: string,
): Promise<
  | { defaultBranch: string | null; defaultTip: string | null; branchExists: boolean }
  | { error: string }
> => {
  const r = await git(
    root,
    env,
    ["ls-remote", "--symref", "--", url, "HEAD", `refs/heads/${branch}`],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (!ok(r))
    return {
      error: r.timedOut
        ? "the remote did not answer in time"
        : "git could not read the remote (network, credentials, or access)",
    };
  let defaultBranch: string | null = null;
  let defaultTip: string | null = null;
  let branchExists = false;
  for (const line of r.output.split(/\r?\n/)) {
    const sym = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (sym) defaultBranch = sym[1] as string;
    const head = line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/);
    if (head) defaultTip = head[1] as string;
    if (line.endsWith(`\trefs/heads/${branch}`)) branchExists = true;
  }
  return { defaultBranch, defaultTip, branchExists };
};

export interface CommitFile {
  rel: string;
  bytes: Buffer;
}

export const plumbingCommit = async (
  root: string,
  env: Record<string, string>,
  workDir: string,
  o: { parent: string; files: CommitFile[]; message: string },
): Promise<{ commit: string } | { error: string }> => {
  const tag = randomBytes(6).toString("hex");
  const index = join(workDir, `index-${tag}`);
  const messageFile = join(workDir, `message-${tag}.txt`);
  const withIndex = { ...env, GIT_INDEX_FILE: index };
  try {
    writeFileSync(messageFile, o.message, { encoding: "utf8", mode: 0o600 });
    if (!ok(await git(root, withIndex, ["read-tree", o.parent])))
      return { error: "git could not read the parent commit's tree" };
    for (const f of o.files) {
      const entry = await git(root, withIndex, ["ls-files", "-s", "-z", "--", f.rel]);
      const m = ok(entry)
        ? entry.output.match(/^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/)
        : null;
      if (!m) return { error: `${f.rel} is not a regular tracked file in the parent commit` };
      const blobFile = join(workDir, `blob-${tag}`);
      writeFileSync(blobFile, f.bytes, { mode: 0o600 });
      const hashed = await git(root, withIndex, [
        "hash-object",
        "-w",
        "--no-filters",
        "--",
        blobFile,
      ]);
      rmSync(blobFile, { force: true });
      const id = hashed.output.trim();
      if (!ok(hashed) || id !== blobId(f.bytes, (m[2] as string).length))
        return { error: `git stored ${f.rel} differently than its bytes` };
      if (
        !ok(await git(root, withIndex, ["update-index", "--cacheinfo", `${m[1]},${id},${f.rel}`]))
      )
        return { error: `git could not stage ${f.rel} in the temporary index` };
    }
    const tree = await git(root, withIndex, ["write-tree"]);
    const treeId = tree.output.trim();
    if (!ok(tree) || !OID.test(treeId)) return { error: "git could not write the tree" };
    const made = await git(root, env, ["commit-tree", treeId, "-p", o.parent, "-F", messageFile]);
    const commit = made.output.trim();
    if (!ok(made) || !OID.test(commit))
      return { error: "git could not create the commit (are user.name and user.email set?)" };
    const changed = await git(root, env, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      o.parent,
      commit,
    ]);
    const names = changed.output
      .split(String.fromCharCode(0))
      .filter((n) => n !== "")
      .sort();
    const expected = o.files.map((f) => f.rel).sort();
    if (!ok(changed) || JSON.stringify(names) !== JSON.stringify(expected))
      return { error: "the commit does not change exactly the planned files: nothing was created" };
    return { commit };
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
    rmSync(messageFile, { force: true });
  }
};

export const createBranch = async (
  root: string,
  env: Record<string, string>,
  branch: string,
  commit: string,
): Promise<boolean> => {
  const zero = "0".repeat(commit.length);
  return ok(
    await git(root, env, [
      "update-ref",
      "-m",
      "harbyn open_pr",
      `refs/heads/${branch}`,
      commit,
      zero,
    ]),
  );
};

export const pushBranch = async (
  root: string,
  env: Record<string, string>,
  url: string,
  branch: string,
): Promise<RunResult> =>
  git(
    root,
    env,
    [
      "push",
      "--porcelain",
      "--no-verify",
      "--no-follow-tags",
      "--recurse-submodules=no",
      "--no-signed",
      `--force-with-lease=refs/heads/${branch}:`,
      "--",
      url,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    {
      timeoutMs: NETWORK_TIMEOUT_MS,
    },
  );
