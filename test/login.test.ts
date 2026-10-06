import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_API,
  configDir,
  deviceLogin,
  logout,
  readToken,
  saveToken,
  whoami,
} from "../src/login.ts";

const TOKEN = `hbn_cli_${"a".repeat(43)}`;
const DEVICE = "d".repeat(43);
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const start = {
  deviceCode: DEVICE,
  userCode: "BCDF-GH23",
  verificationUri: "https://app.harbyn.com/cli",
  interval: 5,
  expiresIn: 600,
};

const fakeApi = (polls: Array<Response | (() => Response)>, first: Response = json(200, start)) => {
  const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get("authorization"),
    });
    if (url === `${CLI_API}/device`) return first;
    const next = polls.shift();
    if (!next) return json(400, { error: "expired_token" });
    return typeof next === "function" ? next() : next;
  };
  return { fetch, calls };
};

describe("harbyn login", () => {
  it("shows the code and the page, polls at the interval, slows down when told, and returns the token", async () => {
    const api = fakeApi([
      json(400, { error: "authorization_pending" }),
      json(400, { error: "slow_down" }),
      json(200, { token: TOKEN, expiresAt: "2027-01-01T00:00:00.000Z" }),
    ]);
    const printed: string[] = [];
    const waits: number[] = [];
    let clock = 0;
    const got = await deviceLogin({
      fetch: api.fetch,
      print: (l) => printed.push(l),
      platform: "darwin",
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    expect(got).toEqual({ token: TOKEN, expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(printed.join("\n")).toContain("https://app.harbyn.com/cli?code=BCDF-GH23");
    expect(printed.join("\n")).toContain("BCDF-GH23");
    expect(printed.join("\n")).not.toContain(DEVICE);
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(api.calls[0]).toMatchObject({ url: `${CLI_API}/device`, body: { platform: "darwin" } });
    expect(
      api.calls
        .slice(1)
        .every(
          (c) =>
            c.url === `${CLI_API}/token` &&
            (c.body as { deviceCode: string }).deviceCode === DEVICE,
        ),
    ).toBe(true);
  });

  it("stops on a denied, expired or failed sign-in", async () => {
    const run = (polls: Response[]) =>
      deviceLogin({ fetch: fakeApi(polls).fetch, print: () => {}, sleep: async () => {} });
    await expect(run([json(400, { error: "invalid_grant" })])).rejects.toThrow(
      /denied or already used/,
    );
    await expect(run([json(400, { error: "expired_token" })])).rejects.toThrow(/expired/);
    await expect(run([json(500, { error: "boom" })])).rejects.toThrow(/failed \(HTTP 500\)/);
  });

  it("abuse: an answer with another approval page, malformed codes or a malformed token is refused", async () => {
    const quiet = { print: () => {}, sleep: async () => {} };
    for (const bad of [
      { ...start, verificationUri: "https://evil.example/cli" },
      { ...start, userCode: "<b>HI</b>" },
      { ...start, deviceCode: "short" },
    ]) {
      await expect(
        deviceLogin({ fetch: fakeApi([], json(200, bad)).fetch, ...quiet }),
      ).rejects.toThrow(/could not start/);
    }
    await expect(
      deviceLogin({
        fetch: fakeApi([json(200, { token: "ghp_stolen", expiresAt: "x" })]).fetch,
        ...quiet,
      }),
    ).rejects.toThrow(/failed/);
  });

  it("saves the token for the user only, reads back only a well-formed one, and logout revokes and deletes it", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "harbyn-login-")), "harbyn");
    expect(readToken(dir)).toBeUndefined();
    saveToken(TOKEN, "2027-01-01T00:00:00.000Z", dir);
    expect(readToken(dir)).toBe(TOKEN);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ token: "not a token" }));
    expect(readToken(dir)).toBeUndefined();
    saveToken(TOKEN, "2027-01-01T00:00:00.000Z", dir);
    const api = fakeApi([new Response(null, { status: 204 })]);
    expect(await logout(api.fetch, dir)).toEqual({ signedIn: true, revoked: true });
    expect(api.calls).toMatchObject([{ url: `${CLI_API}/logout`, auth: `Bearer ${TOKEN}` }]);
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
    expect(await logout(api.fetch, dir)).toEqual({ signedIn: false, revoked: false });
    saveToken(TOKEN, "2027-01-01T00:00:00.000Z", dir);
    expect(await logout(async () => json(503, { error: "down" }), dir)).toEqual({
      signedIn: true,
      revoked: false,
    });
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
  });

  it("a token never sits in a file others can read, even over an old readable one", () => {
    if (process.platform === "win32") return;
    const dir = join(mkdtempSync(join(tmpdir(), "harbyn-login-")), "harbyn");
    saveToken(TOKEN, "2027-01-01T00:00:00.000Z", dir);
    chmodSync(join(dir, "credentials.json"), 0o644);
    chmodSync(dir, 0o755);
    saveToken(TOKEN, "2027-01-02T00:00:00.000Z", dir);
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual(["credentials.json"]);
  });

  it("whoami shows printable text only, and the config directory follows the platform's convention", async () => {
    const who = await whoami(
      async () =>
        json(200, {
          email: `ana@example.com${String.fromCodePoint(0x1b)}[31m`,
          plan: "pro",
          fixes: true,
        }),
      TOKEN,
    );
    expect(who).toEqual({ email: "ana@example.com[31m", plan: "pro", fixes: true });
    expect(await whoami(async () => json(401, { error: "x" }), TOKEN)).toBeUndefined();
    expect(configDir({ APPDATA: "C:/Users/a/AppData/Roaming" })).toBe(
      join("C:/Users/a/AppData/Roaming", "harbyn"),
    );
    expect(configDir({ XDG_CONFIG_HOME: "/home/a/.config" })).toBe(
      join("/home/a/.config", "harbyn"),
    );
  });
});
