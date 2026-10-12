import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_LEDGER_BYTES = 5 * 1024 * 1024;

export interface LedgerEntry {
  at: string;
  tool: "apply_fix" | "run_checks";
  [field: string]: unknown;
}

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const ledgerFile = (
  cacheDir: string,
  root: string,
): { file: string } | { error: string } => {
  const dir = resolve(cacheDir, "ledger");
  if (inside(root, dir))
    return {
      error: "the cache directory is inside the repository: the ledger is never written there",
    };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    const real = realpathSync(dir);
    if (inside(root, real))
      return {
        error: "the cache directory is inside the repository: the ledger is never written there",
      };
    return {
      file: join(real, `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.jsonl`),
    };
  } catch {
    return { error: "the ledger directory cannot be created" };
  }
};

export const appendLedger = (
  cacheDir: string,
  root: string,
  entry: LedgerEntry,
): { file: string } | { error: string } => {
  const target = ledgerFile(cacheDir, root);
  if ("error" in target) return target;
  try {
    try {
      const stat = lstatSync(target.file);
      if (!stat.isFile()) return { error: "the ledger is not a regular file" };
      if (stat.size > MAX_LEDGER_BYTES) renameSync(target.file, `${target.file}.1`);
    } catch {}
    appendFileSync(target.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return target;
  } catch {
    return { error: "the ledger could not be written" };
  }
};
