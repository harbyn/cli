import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isSecretFile } from "../walk.ts";

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 1024;
const NEVER = new Set([".git", "node_modules"]);

export class PathRefused extends Error {}

export const checkRoot = (
  candidate: string,
  home: string = homedir(),
): { ok: true; root: string } | { ok: false; reason: string } => {
  let root: string;
  try {
    root = realpathSync(candidate);
    if (!statSync(root).isDirectory()) return { ok: false, reason: "the root is not a directory" };
  } catch {
    return { ok: false, reason: "the root does not exist" };
  }
  if (dirname(root) === root)
    return {
      ok: false,
      reason: "the root is a filesystem root: start the server in a repository, or pass --root",
    };
  let homeReal = home;
  try {
    homeReal = realpathSync(home);
  } catch {}
  if (root === homeReal)
    return {
      ok: false,
      reason: "the root is your home directory: start the server in a repository, or pass --root",
    };
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return { ok: true, root };
    if (dirname(dir) === dir) break;
  }
  return {
    ok: false,
    reason:
      "the root is not inside a git work tree: start the server in a repository, or pass --root",
  };
};

export const resolveInside = (root: string, path: string): { full: string; rel: string } => {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_CHARS)
    throw new PathRefused("the path is empty or too long");
  if (path.includes("\0")) throw new PathRefused("the path contains a NUL character");
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("/") || path.startsWith("\\"))
    throw new PathRefused("the path must be relative to the repository root");
  const parts = path.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new PathRefused("the path may not contain '..'");
  const folded = (p: string): string => p.toLowerCase().replace(/[. ]+$/, "");
  if (parts.some((p) => NEVER.has(folded(p))))
    throw new PathRefused("the path is inside .git or node_modules");
  if (parts.some((p) => /~\d/.test(p))) throw new PathRefused("the path uses a short (8.3) name");
  let full = root;
  for (const part of parts) {
    full = join(full, part);
    let link: boolean;
    try {
      link = lstatSync(full).isSymbolicLink();
    } catch {
      throw new PathRefused("the path does not exist");
    }
    if (link) throw new PathRefused("the path goes through a symbolic link");
  }
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new PathRefused("the path does not exist");
  }
  const rel = relative(root, real);
  if (real !== full || rel.startsWith("..") || isAbsolute(rel))
    throw new PathRefused("the path leaves the repository root");
  return { full, rel: rel.split(sep).join("/") };
};

export const readInside = (root: string, path: string): string | undefined => {
  try {
    const { full } = resolveInside(root, path);
    const name = full.split(sep).pop() ?? "";
    if (isSecretFile(name)) return undefined;
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    const bytes = readFileSync(full);
    const text = bytes.toString("utf8");
    return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
  } catch {
    return undefined;
  }
};
