import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { FeedVerificationError } from "./feed/index.ts";
import { config } from "zod";
import { getFeed } from "./feed-source.ts";
import { mdText, toAnnotations, toStepSummary, workflowCommand } from "./github.ts";
import { actionable, scan, toJson } from "./index.ts";
import { CLI_NAME, CLI_VERSION } from "./product.ts";
import { planFixes } from "./fix.ts";
import { openPullRequests } from "./pulls.ts";
import {
  CONNECTION_ID,
  requestOidcToken,
  toManifest,
  uploadBody,
  uploadManifest,
} from "./upload.ts";

config({ jitless: true });

const input = (name: string): string => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
const lines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const fail = (message: string): never => {
  console.log(workflowCommand("error", CLI_NAME, message));
  process.exit(1);
};

const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const target = resolve(workspace, input("path") || ".");
const outside = (from: string, to: string): boolean => {
  const rel = relative(from, to);
  return isAbsolute(rel) || rel.split(sep).includes("..");
};
const inside = relative(workspace, target);
if (outside(workspace, target)) fail("the path input must stay inside the repository workspace");
try {
  if (outside(realpathSync(workspace), realpathSync(target)))
    fail("the path input must stay inside the repository workspace");
} catch {
  fail("the path input does not exist in the repository");
}
const pathPrefix = inside.split(sep).join("/");
const failOn = input("fail-on") || "none";
if (failOn !== "none" && failOn !== "findings") fail("fail-on must be 'none' or 'findings'");
const onFeedError = input("on-feed-error") || "warn";
if (onFeedError !== "warn" && onFeedError !== "fail")
  fail("on-feed-error must be 'warn' or 'fail'");
const upload = (input("upload") || "false").toLowerCase();
if (upload !== "true" && upload !== "false") fail("upload must be 'true' or 'false'");
const connection = input("connection").toLowerCase();
if (upload === "true" && !CONNECTION_ID.test(connection))
  fail("upload needs the connection id shown in your Harbyn dashboard (Repositories)");
const inventory = (input("inventory") || "false").toLowerCase();
if (inventory !== "true" && inventory !== "false") fail("inventory must be 'true' or 'false'");
if (inventory === "true" && upload !== "true")
  fail("inventory needs upload: true (it only decides what the upload includes)");
const onUploadError = input("on-upload-error") || "warn";
const remediate = (input("remediate") || "false").toLowerCase();
if (remediate !== "true" && remediate !== "false") fail("remediate must be 'true' or 'false'");
const githubToken = input("github-token");
if (onUploadError !== "warn" && onUploadError !== "fail")
  fail("on-upload-error must be 'warn' or 'fail'");

const now = new Date();
const today = now.toISOString().slice(0, 10);
const feedDir = input("feed-dir");

const writeOutput = (name: string, value: string): void => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
};

const feed = await (async () => {
  try {
    return await getFeed({
      now,
      ...(feedDir ? { feedDir: resolve(workspace, feedDir) } : {}),
      onWarning: (message) => console.log(workflowCommand("warning", CLI_NAME, message)),
    });
  } catch (error) {
    const reason =
      error instanceof FeedVerificationError ? error.message : (error as Error).message;
    const message = `no scan: the change feed could not be verified (${reason})`;
    writeOutput("findings", "");
    if (onFeedError === "fail") fail(message);
    console.log(workflowCommand("warning", CLI_NAME, message));
    process.exit(0);
  }
})();

const result = scan(target, feed, { ignore: lines(input("ignore")) });

for (const annotation of toAnnotations(result, today, pathPrefix)) console.log(annotation);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    toStepSummary(result, today, CLI_NAME, pathPrefix, upload === "true"),
  );
}

const reportPath = join(process.env.RUNNER_TEMP ?? workspace, `${CLI_NAME}-report.json`);
writeFileSync(reportPath, JSON.stringify(toJson(result), null, 2));
const count = actionable(result).length;
writeOutput("findings", String(count));
writeOutput("report", reportPath);
console.log(
  `${count} affected ${count === 1 ? "line" : "lines"}, ${result.stats.scanned} ${result.stats.scanned === 1 ? "file" : "files"} scanned.`,
);

if (upload === "true") {
  let outcome: { ok: boolean; message: string };
  try {
    const body = uploadBody(
      connection,
      toManifest(result, CLI_VERSION, { inventory: inventory === "true" }),
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `
### Sent to ${CLI_NAME}

The exact body of the upload: feed terms and counts, no paths, lines or code.

\`\`\`json
${pretty}
\`\`\`
`,
      );
    }
    outcome = await uploadManifest(body, await requestOidcToken(process.env, fetch), fetch);
  } catch (error) {
    outcome = { ok: false, message: (error as Error).message };
  }
  if (outcome.ok) console.log(`${CLI_NAME}: ${outcome.message}`);
  else if (onUploadError === "fail") fail(`upload: ${outcome.message}`);
  else
    console.log(
      workflowCommand(
        "warning",
        CLI_NAME,
        `upload: ${outcome.message}. The scan above is complete; only the dashboard misses this run.`,
      ),
    );
}
if (remediate === "true") {
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  if (!["push", "schedule", "workflow_dispatch"].includes(event)) {
    console.log(
      workflowCommand(
        "notice",
        CLI_NAME,
        `remediation skipped: it runs on push, schedule or workflow_dispatch, not ${event || "this event"}`,
      ),
    );
  } else if (!githubToken) {
    console.log(
      workflowCommand(
        "warning",
        CLI_NAME,
        "remediation needs a token: grant the job contents: write and pull-requests: write",
      ),
    );
  } else {
    const vendors = new Map(feed.vendors.map((v) => [v.id, v]));
    const { plans, unfixable } = planFixes(result, { root: target, vendors });
    try {
      const outcomes = await openPullRequests(plans, {
        repository: process.env.GITHUB_REPOSITORY ?? "",
        sha: process.env.GITHUB_SHA ?? "",
        ref: process.env.GITHUB_REF ?? "",
        token: githubToken,
        vendors,
        fetch,
      });
      for (const o of outcomes) {
        const verb = {
          opened: "opened",
          exists: "already open",
          declined: "declined earlier, not reopened",
          failed: "",
        }[o.status];
        const line =
          o.status === "failed"
            ? `could not open a fix for ${o.eventId}: ${o.message ?? "unknown error"}`
            : `${verb}: ${o.url ?? o.eventId}`;
        console.log(
          o.status === "failed"
            ? workflowCommand("warning", CLI_NAME, line)
            : `${CLI_NAME}: ${line}`,
        );
      }
      writeOutput(
        "pull-requests",
        outcomes
          .filter((o) => o.url)
          .map((o) => o.url)
          .join(" "),
      );
      if (process.env.GITHUB_STEP_SUMMARY && (outcomes.length > 0 || unfixable.length > 0)) {
        const rows = outcomes.map(
          (o) =>
            `- ${o.status}: ${o.url ? mdText(o.url) : mdText(o.eventId)}${o.message ? ` (${mdText(o.message)})` : ""}`,
        );
        const left = unfixable.map((u) => `- ${mdText(u.event.title)}: ${mdText(u.reason)}`);
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `\n### Fixes\n\n${[...rows, ...(left.length ? ["", "Left for a person:", ...left] : [])].join("\n")}\n`,
        );
      }
    } catch (error) {
      console.log(
        workflowCommand("warning", CLI_NAME, `remediation skipped: ${(error as Error).message}`),
      );
    }
  }
}
process.exit(failOn === "findings" && count > 0 ? 1 : 0);
