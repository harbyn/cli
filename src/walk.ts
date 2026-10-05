import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IgnoreRules } from "./ignore.ts";
import { INVENTORY_FILES, MAX_LOCKFILE_BYTES } from "./inventory.ts";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".astro",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);
const SKIP_EXT =
  /\.(?:png|jpe?g|gif|webp|avif|ico|svg|pdf|zip|gz|tgz|rar|7z|exe|dll|so|dylib|bin|woff2?|ttf|otf|eot|mp[34]|mov|webm|ogg|wav|lock|map|min\.js|min\.css)$/i;
const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "composer.lock",
  "Cargo.lock",
]);
const SECRET_FILE =
  /^(?:\.env(?!\.example$|\.sample$|\.template$).*|.*\.(?:pem|key|p12|pfx|keystore)|id_(?:rsa|ed25519|ecdsa).*|\.npmrc|\.netrc|credentials(?:\.json)?)$/i;

export const IGNORE_FILE = ".harbynignore";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IGNORE_BYTES = 64 * 1024;
const MAX_FILES = 50_000;

export interface SourceFile {
  path: string;
  text: string;
}

export interface WalkStats {
  scanned: number;
  skippedSecret: number;
  skippedIgnored: number;
  skippedNestedRepos: string[];
  truncated: boolean;
}

export interface WalkOptions {
  ignore?: string[];
  includeNestedRepos?: boolean;
  noGitignore?: boolean;
  onLockfile?: (file: SourceFile) => void;
}

export const newStats = (): WalkStats => ({
  scanned: 0,
  skippedSecret: 0,
  skippedIgnored: 0,
  skippedNestedRepos: [],
  truncated: false,
});

const readSmall = (full: string): string | undefined => {
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > MAX_IGNORE_BYTES) return undefined;
    return readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
};

export function* walk(
  root: string,
  stats: WalkStats,
  options: WalkOptions = {},
): Generator<SourceFile> {
  const rules = new IgnoreRules();
  if (options.ignore?.length) rules.add(options.ignore.join("\n"), "");
  const projectIgnore = readSmall(join(root, IGNORE_FILE));
  if (projectIgnore) rules.add(projectIgnore, "");

  const stack: Array<{ full: string; rel: string }> = [{ full: root, rel: "" }];
  while (stack.length > 0) {
    const dir = stack.pop() as { full: string; rel: string };
    if (!options.noGitignore) {
      const gitignore = readSmall(join(dir.full, ".gitignore"));
      if (gitignore) rules.add(gitignore, dir.rel);
    }
    let names: string[];
    try {
      names = readdirSync(dir.full).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir.full, name);
      const rel = dir.rel === "" ? name : `${dir.rel}/${name}`;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (rules.ignores(rel, true)) {
          stats.skippedIgnored++;
          continue;
        }
        if (!options.includeNestedRepos && existsSync(join(full, ".git"))) {
          stats.skippedNestedRepos.push(rel);
          continue;
        }
        stack.push({ full, rel });
        continue;
      }
      if (!stat.isFile()) continue;
      if (SECRET_FILE.test(name)) {
        stats.skippedSecret++;
        continue;
      }
      if (
        options.onLockfile &&
        INVENTORY_FILES.has(name) &&
        stat.size > 0 &&
        stat.size <= MAX_LOCKFILE_BYTES &&
        !rules.ignores(rel, false)
      ) {
        try {
          options.onLockfile({ path: rel, text: readFileSync(full, "utf8") });
        } catch {}
        continue;
      }
      if (
        LOCKFILES.has(name) ||
        SKIP_EXT.test(name) ||
        stat.size > MAX_FILE_BYTES ||
        stat.size === 0
      )
        continue;
      if (rules.ignores(rel, false)) {
        stats.skippedIgnored++;
        continue;
      }
      if (stats.scanned >= MAX_FILES) {
        stats.truncated = true;
        return;
      }
      let buffer: Buffer;
      try {
        buffer = readFileSync(full);
      } catch {
        continue;
      }
      if (buffer.subarray(0, 8192).includes(0)) continue;
      stats.scanned++;
      yield { path: rel, text: buffer.toString("utf8") };
    }
  }
}
