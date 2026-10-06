import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FeedVerificationError } from "./feed/index.ts";
import { config } from "zod";
import { banner, showsBanner } from "./banner.ts";
import { loadEngine } from "./engine.ts";
import { getFeed } from "./feed-source.ts";
import { actionable, scan, toDependencyText, toJson, toText } from "./index.ts";
import { configDir, deviceLogin, logout, readToken, saveToken, whoami } from "./login.ts";
import { PAID_FIX_MESSAGE } from "./product.ts";
import { defaultCacheDir } from "./remote-feed.ts";
import { CLI_NAME, CLI_VERSION } from "./product.ts";
import { CONNECTION_ID, requestOidcToken } from "./upload.ts";

config({ jitless: true });

const USAGE = `usage: ${CLI_NAME} scan [dir] [options]

  login               sign this CLI in from your browser (Harbyn Pro and Team: fixes on this machine)
  logout              sign it out, and revoke the sign-in
  fix [dir] [--write] show the fixes the paid engine makes; --write applies them to the files
  migrate             SDK migrations (prepare | apply); see https://harbyn.com/docs
                      Fixes and migrations are part of Harbyn Pro and Team: https://harbyn.com/pricing

  --json              machine-readable output
  --ci                exit 1 when there are findings in code
  --all               also list low-confidence findings (tests, docs, model catalogs)
  --deps              list every dependency found in lockfiles (public registries only)
  --ignore <glob>     extra ignore pattern, repeatable (.gitignore and .harbynignore are honoured)
  --include-nested    also scan nested git repositories
  --no-gitignore      do not honour .gitignore files
  --offline           use the cached feed, make no network request
  --feed-url <url>    alternative https location of the signed feed
  --feed-dir <dir>    development: read an unsigned feed from a local directory
  --version           print the version

scan is read-only, never opens .env or key files, and makes one network request: the
signed change feed. Nothing about your code leaves this machine, with any command.`;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set([
  "--feed-dir",
  "--feed-url",
  "--ignore",
  "--out",
  "--llm",
  "--llm-model",
  "--max-calls",
  "--checks",
]);
const flag = (name: string): boolean => args.includes(name);
const values = (name: string): string[] =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1] as string] : []));
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1] ?? ""),
);

if (flag("--version")) {
  console.log(CLI_VERSION);
  process.exit(0);
}
const command = positional[0] ?? "scan";
if (command === "login") {
  try {
    const { token, expiresAt } = await deviceLogin({ fetch, print: (line) => console.log(line) });
    if (readToken()) await logout(fetch).catch(() => undefined);
    saveToken(token, expiresAt);
    const who = await whoami(fetch, token).catch(() => undefined);
    console.log(
      `Signed in${who?.email ? ` as ${who.email}` : ""}.${who && !who.fixes ? " Automatic fixes need Harbyn Pro or Team: https://harbyn.com/pricing" : ""}`,
    );
    console.log(`The sign-in is saved in ${configDir()}; \`${CLI_NAME} logout\` removes it.`);
    process.exit(0);
  } catch (error) {
    console.error(`${CLI_NAME}: ${(error as Error).message}`);
    process.exit(3);
  }
}
if (command === "logout") {
  const out = await logout(fetch);
  if (!out.signedIn) console.log("Not signed in.");
  else if (out.revoked) console.log("Signed out.");
  else {
    console.error(
      `${CLI_NAME}: deleted here, but the sign-in could not be revoked: sign it out in Settings > Command line`,
    );
    process.exit(1);
  }
  process.exit(0);
}
if (command === "fix" || command === "migrate") {
  const connection = (process.env.HARBYN_CONNECTION ?? "").trim().toLowerCase();
  const inCi =
    command === "migrate" &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
    CONNECTION_ID.test(connection);
  const signedIn = inCi ? undefined : readToken();
  if (!inCi && !signedIn) {
    console.log(PAID_FIX_MESSAGE);
    console.log(
      `Already on Pro or Team? Run \`${CLI_NAME} login\` once, then \`${CLI_NAME} ${command}\` here.`,
    );
    process.exit(0);
  }
  try {
    const auth = inCi
      ? { kind: "ci" as const, connection, token: await requestOidcToken(process.env, fetch) }
      : { kind: "cli" as const, token: signedIn as string };
    const loaded = await loadEngine({
      auth,
      dir: process.env.RUNNER_TEMP ?? tmpdir(),
      fetch,
      ...(inCi ? {} : { cacheDir: join(defaultCacheDir(), "engine") }),
    });
    if (!loaded.ok) {
      console.error(
        `${CLI_NAME}: no ${command === "fix" ? "fixes" : "migration"}: ${loaded.message}`,
      );
      process.exit(3);
    }
    if (command === "migrate")
      process.exit(await loaded.engine.runMigrate(positional, values, loaded.knowledge));
    if (!loaded.engine.runFix) {
      console.error(
        `${CLI_NAME}: this engine cannot fix locally yet: update the CLI (npx ${CLI_NAME}@latest fix)`,
      );
      process.exit(3);
    }
    const feed = await getFeed({
      now: new Date(),
      onWarning: (message) => console.error(`warning: ${message}`),
    });
    const target = resolve(positional[1] ?? ".");
    const result = scan(target, feed, {
      ignore: values("--ignore"),
      includeNestedRepos: flag("--include-nested"),
      noGitignore: flag("--no-gitignore"),
    });
    process.exit(
      await loaded.engine.runFix({
        result,
        feed,
        knowledge: loaded.knowledge,
        target,
        write: flag("--write"),
        print: (text) => console.log(text),
      }),
    );
  } catch (error) {
    console.error(
      `${CLI_NAME}: no ${command === "fix" ? "fixes" : "migration"}: ${error instanceof FeedVerificationError ? error.message : (error as Error).message}`,
    );
    process.exit(3);
  }
}
const terminal = {
  isTTY: Boolean(process.stdout.isTTY),
  env: process.env,
  platform: process.platform,
};
const help = flag("--help") || flag("-h");
if ((help || command === "scan") && showsBanner(terminal, flag("--json")))
  console.log(banner(terminal));
if (help || command !== "scan") {
  console.log(USAGE);
  process.exit(flag("--help") || flag("-h") ? 0 : 2);
}
const target = resolve(positional[1] ?? ".");
const now = new Date();

try {
  const feedUrl = values("--feed-url")[0];
  const feedDir = values("--feed-dir")[0];
  const feed = await getFeed({
    now,
    offline: flag("--offline"),
    ...(feedDir ? { feedDir } : {}),
    ...(feedUrl ? { feedUrl } : {}),
    onWarning: (message) => console.error(`warning: ${message}`),
  });
  const result = scan(target, feed, {
    ignore: values("--ignore"),
    includeNestedRepos: flag("--include-nested"),
    noGitignore: flag("--no-gitignore"),
  });
  const today = now.toISOString().slice(0, 10);
  console.log(
    flag("--json")
      ? JSON.stringify(toJson(result), null, 2)
      : flag("--deps")
        ? toDependencyText(result)
        : toText(result, today, flag("--all")),
  );
  process.exit(flag("--ci") && actionable(result).length > 0 ? 1 : 0);
} catch (error) {
  console.error(
    `${CLI_NAME}: ${error instanceof FeedVerificationError ? error.message : (error as Error).message}`,
  );
  process.exit(2);
}
