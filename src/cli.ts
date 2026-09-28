import { resolve } from "node:path";
import { FeedVerificationError } from "./feed/index.ts";
import { config } from "zod";
import { getFeed } from "./feed-source.ts";
import { actionable, scan, toJson, toText } from "./index.ts";
import { CLI_NAME, CLI_VERSION } from "./product.ts";

config({ jitless: true });

const USAGE = `usage: ${CLI_NAME} scan [dir] [options]

  --json              machine-readable output
  --ci                exit 1 when there are findings in code
  --all               also list low-confidence findings (tests, docs, model catalogs)
  --ignore <glob>     extra ignore pattern, repeatable (.gitignore and .harbynignore are honoured)
  --include-nested    also scan nested git repositories
  --no-gitignore      do not honour .gitignore files
  --offline           use the cached feed, make no network request
  --feed-url <url>    alternative https location of the signed feed
  --feed-dir <dir>    development: read an unsigned feed from a local directory
  --version           print the version

Read-only. Never opens .env or key files. Nothing about your code leaves this machine;
the only network request is the download of the signed change feed.`;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--feed-dir", "--feed-url", "--ignore"]);
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
if (flag("--help") || flag("-h") || (positional[0] !== undefined && positional[0] !== "scan")) {
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
  console.log(
    flag("--json")
      ? JSON.stringify(toJson(result), null, 2)
      : toText(result, now.toISOString().slice(0, 10), flag("--all")),
  );
  process.exit(flag("--ci") && actionable(result).length > 0 ? 1 : 0);
} catch (error) {
  console.error(
    `${CLI_NAME}: ${error instanceof FeedVerificationError ? error.message : (error as Error).message}`,
  );
  process.exit(2);
}
