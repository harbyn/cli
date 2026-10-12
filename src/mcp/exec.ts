import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";

export const CHECK_TIMEOUT_MS = 10 * 60_000;
export const OUTPUT_TAIL_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  tailBytes?: number;
  platform?: NodeJS.Platform;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  durationMs: number;
  failedToStart: boolean;
}

const isInside = (parent: string, child: string, platform: NodeJS.Platform): boolean => {
  const p = platform === "win32" ? win32 : posix;
  const rel = p.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
};

export const resolveProgram = (
  name: string,
  o: { cwd: string; env: Record<string, string | undefined>; platform: NodeJS.Platform },
): string | undefined => {
  const p = o.platform === "win32" ? win32 : posix;
  const runnable = (file: string): boolean => {
    try {
      if (!statSync(file).isFile()) return false;
      if (o.platform !== "win32") accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (p.isAbsolute(name)) return runnable(name) ? name : undefined;
  if (/[\\/]/.test(name)) {
    const full = p.resolve(o.cwd, name);
    return runnable(full) ? full : undefined;
  }
  const pathKey = Object.keys(o.env).find((k) =>
    o.platform === "win32" ? k.toUpperCase() === "PATH" : k === "PATH",
  );
  const dirs = (pathKey ? (o.env[pathKey] ?? "") : "")
    .split(p.delimiter)
    .filter((d) => d !== "" && p.isAbsolute(d) && !isInside(o.cwd, d, o.platform));
  const names =
    o.platform === "win32"
      ? /\.(exe|com)$/i.test(name)
        ? [name]
        : [`${name}.exe`, `${name}.com`]
      : [name];
  for (const dir of dirs)
    for (const n of names) if (runnable(p.join(dir, n))) return p.join(dir, n);
  return undefined;
};

const killTree = (pid: number | undefined, platform: NodeJS.Platform): void => {
  if (pid === undefined) return;
  try {
    if (platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.windir;
      if (!systemRoot) return;
      spawn(win32.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      }).on("error", () => undefined);
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {}
};

export const runArgv = (argv: readonly string[], options: RunOptions): Promise<RunResult> =>
  new Promise((resolve) => {
    const platform = options.platform ?? process.platform;
    const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
    const tailBytes = options.tailBytes ?? OUTPUT_TAIL_BYTES;
    const started = Date.now();
    const [name, ...args] = argv;
    const file =
      name && !argv.some((a) => typeof a !== "string" || a.includes("\0"))
        ? resolveProgram(name, { cwd: options.cwd, env: options.env, platform })
        : undefined;
    if (!file) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        output: "",
        truncated: false,
        durationMs: 0,
        failedToStart: true,
      });
      return;
    }
    let tail = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const keep = (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > tailBytes) {
        tail = tail.subarray(tail.length - tailBytes);
        truncated = true;
      }
    };
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: platform !== "win32",
    });
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, platform);
    }, timeoutMs);
    timer.unref?.();
    const finish = (
      exitCode: number | null,
      signal: string | null,
      failedToStart: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let start = 0;
      if (truncated) while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start += 1;
      const text = tail.subarray(start).toString("utf8");
      resolve({
        exitCode,
        signal,
        timedOut,
        output: text,
        truncated,
        durationMs: Date.now() - started,
        failedToStart,
      });
    };
    child.on("error", () => finish(null, null, true));
    child.on("close", (code, signal) => finish(code, signal, false));
  });

const NUL = String.fromCharCode(0);

export const blobId = (bytes: Buffer, hexLength: number): string =>
  createHash(hexLength === 64 ? "sha256" : "sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}`), Buffer.from(NUL), bytes]))
    .digest("hex");

export const gitClean = async (
  root: string,
  rel: string,
  env: Record<string, string>,
): Promise<"clean" | "dirty" | "untracked" | "unknown"> => {
  const git = (args: string[]) =>
    runArgv(["git", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
      tailBytes: 64 * 1024,
    });
  const index = await git(["ls-files", "-s", "-z", "--", rel]);
  if (index.failedToStart || index.timedOut || index.exitCode !== 0 || index.truncated)
    return "unknown";
  const entries = index.output.split(NUL).filter((e) => e !== "");
  if (entries.length === 0) return "untracked";
  const entry =
    entries.length === 1
      ? (entries[0] as string).match(/^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/)
      : null;
  if (!entry) return "unknown";
  const indexId = entry[2] as string;
  const head = await git(["rev-parse", "--verify", "--quiet", `HEAD:./${rel}`]);
  if (head.failedToStart || head.timedOut) return "unknown";
  if (head.exitCode !== 0) return "dirty";
  const headId = head.output.trim();
  if (headId.length !== indexId.length || !/^[0-9a-f]+$/.test(headId)) return "unknown";
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, rel));
  } catch {
    return "unknown";
  }
  const working = blobId(bytes, indexId.length);
  return working === indexId && working === headId ? "clean" : "dirty";
};
