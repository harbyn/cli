import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_NAME } from "./product.ts";
import type { Fetch } from "./upload.ts";

export const CLI_API = "https://api.harbyn.com/cli";
const TOKEN = /^hbn_cli_[A-Za-z0-9_-]{43}$/;
const USER_CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;

export const configDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.APPDATA ?? env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), CLI_NAME);
const credentialsFile = (dir: string): string => join(dir, "credentials.json");

export const readToken = (dir = configDir()): string | undefined => {
  try {
    const saved = JSON.parse(readFileSync(credentialsFile(dir), "utf8")) as { token?: unknown };
    return typeof saved.token === "string" && TOKEN.test(saved.token) ? saved.token : undefined;
  } catch {
    return undefined;
  }
};

export const saveToken = (token: string, expiresAt: string, dir = configDir()): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const temp = join(dir, `.credentials-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(temp, `${JSON.stringify({ token, expiresAt })}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, credentialsFile(dir));
};

export const forgetToken = (dir = configDir()): void => {
  if (existsSync(credentialsFile(dir))) rmSync(credentialsFile(dir));
};

const platformOf = (platform: string): "linux" | "darwin" | "win32" | "other" =>
  platform === "linux" || platform === "darwin" || platform === "win32" ? platform : "other";

const post = async (
  fetch: Fetch,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await fetch(`${CLI_API}${path}`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = (await res.text()).slice(0, 4096);
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
};

export interface LoginOptions {
  fetch: Fetch;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  platform?: string;
  now?: () => number;
}

export const deviceLogin = async (
  options: LoginOptions,
): Promise<{ token: string; expiresAt: string }> => {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const start = await post(options.fetch, "/device", {
    platform: platformOf(options.platform ?? process.platform),
  });
  const { deviceCode, userCode, verificationUri, interval, expiresIn } = start.json;
  if (
    start.status !== 200 ||
    typeof deviceCode !== "string" ||
    !DEVICE_CODE.test(deviceCode) ||
    typeof userCode !== "string" ||
    !USER_CODE.test(userCode) ||
    verificationUri !== "https://app.harbyn.com/cli"
  ) {
    throw new Error(`could not start the sign-in (HTTP ${start.status})`);
  }
  options.print(`Open ${verificationUri}?code=${userCode} in your browser,`);
  options.print(`sign in, and check that it shows this code: ${userCode}`);
  options.print("Waiting for you to approve it there...");
  let wait = Math.min(Math.max(Number(interval) || 5, 5), 30) * 1000;
  const deadline = now() + Math.min(Math.max(Number(expiresIn) || 600, 60), 900) * 1000;
  while (now() < deadline) {
    await sleep(wait);
    const poll = await post(options.fetch, "/token", { deviceCode });
    const { token, expiresAt, error } = poll.json;
    if (
      poll.status === 200 &&
      typeof token === "string" &&
      TOKEN.test(token) &&
      typeof expiresAt === "string"
    )
      return { token, expiresAt };
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      wait += 5000;
      continue;
    }
    if (error === "expired_token") throw new Error("the code expired: run `harbyn login` again");
    if (error === "invalid_grant")
      throw new Error("the sign-in was denied or already used: run `harbyn login` again");
    throw new Error(`the sign-in failed (HTTP ${poll.status})`);
  }
  throw new Error("the code expired: run `harbyn login` again");
};

export const whoami = async (
  fetch: Fetch,
  token: string,
): Promise<{ email: string; plan: string; fixes: boolean } | undefined> => {
  const res = await fetch(`${CLI_API}/whoami`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) return undefined;
  const json = (await res.json().catch(() => ({}))) as {
    email?: unknown;
    plan?: unknown;
    fixes?: unknown;
  };
  const printable = (v: unknown) =>
    typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, 200) : "";
  return { email: printable(json.email), plan: printable(json.plan), fixes: json.fixes === true };
};

export const logout = async (
  fetch: Fetch,
  dir = configDir(),
): Promise<{ signedIn: boolean; revoked: boolean }> => {
  const token = readToken(dir);
  const revoked = token
    ? (await post(fetch, "/logout", {}, token).catch(() => ({ status: 0 }))).status === 204
    : false;
  forgetToken(dir);
  return { signedIn: token !== undefined, revoked };
};
