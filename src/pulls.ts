import { deadlineOf, type Vendor } from "./schema/index.ts";
import { type FixPlan, joinLines, splitLines, utf8Text } from "./fix.ts";
import { mdText } from "./github.ts";

export const GITHUB_API = "https://api.github.com";
export const MAX_PULLS = 3;
const MAX_BODY = 60_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PullContext {
  repository: string;
  sha: string;
  ref: string;
  token: string;
  vendors: ReadonlyMap<string, Vendor>;
  fetch: Fetch;
}

export interface PullOutcome {
  eventId: string;
  status: "opened" | "exists" | "declined" | "failed";
  url?: string;
  message?: string;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const SOURCE = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%/-]*)?$/;

export const branchFor = (eventId: string): string =>
  `harbyn/${eventId.replace("/", "-")}`.replace(/[^A-Za-z0-9._/-]/g, "-").slice(0, 200);

const fence = (code: string): string => {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${code}\n${ticks}`;
};

const prText = (s: string): string =>
  mdText(s).replaceAll("@", "&#64;").replaceAll("://", ":&#47;&#47;");

export const pullRequestFor = (
  plan: FixPlan,
  vendors: ReadonlyMap<string, Vendor>,
): { title: string; body: string } => {
  const e = plan.event;
  const vendor = vendors.get(e.vendor)?.name ?? e.vendor;
  const deadline = deadlineOf(e);
  const title =
    `Harbyn: replace ${plan.from} with ${plan.to} (${vendor.replaceAll("@", "")}${deadline ? `, ${deadline.date}` : ""})`.slice(
      0,
      250,
    );
  const source = e.sources[0]?.url ?? "";
  const lines = [
    `${prText(vendor)} announced: **${prText(e.title)}**${deadline ? ` (effective ${prText(deadline.date)})` : ""}.`,
    "",
    prText(e.summary),
    "",
    `This pull request replaces ${plan.edits.length === 1 ? "the one place" : `the ${plan.edits.length} places`} your code uses the retired identifier with the one ${prText(vendor)} names as its replacement. Nothing else changes.`,
    "",
    "### Changes",
    "",
    ...plan.edits.flatMap((edit) => [
      `\`${mdText(edit.path)}:${edit.line}\``,
      "",
      fence(`- ${edit.before.trim()}\n+ ${edit.after.trim()}`),
      "",
    ]),
  ];
  if (plan.skipped.length > 0) {
    lines.push(
      "### Not changed",
      "",
      ...plan.skipped.map((s) => `- \`${mdText(s.path)}:${s.line}\`: ${mdText(s.reason)}`),
      "",
    );
  }
  lines.push(
    "### Before merging",
    "",
    `- A newer model or API version can behave differently. Run your tests and check the vendor's notes${SOURCE.test(source) ? `: ${source}` : "."}`,
    "- Pull requests opened with the default workflow token do not start other workflows. Push to this branch, or close and reopen this pull request, to run your CI on it.",
    "- To decline, close this pull request: Harbyn will not open it again.",
    "",
    `<sub>Opened by the Harbyn GitHub Action from change event \`${mdText(e.id)}\` (${e.review.state === "human-reviewed" ? "reviewed by a person" : "from the vendor's structured data"}). Harbyn never merges, and never writes to your default branch.</sub>`,
  );
  const body = lines.join("\n");
  return {
    title,
    body:
      body.length > MAX_BODY
        ? `${body.slice(0, MAX_BODY - 40)}\n\n(truncated: see the job summary)`
        : body,
  };
};

export const editedText = (text: string, plan: FixPlan, path: string): string | undefined => {
  const split = splitLines(text);
  for (const edit of plan.edits.filter((e) => e.path === path)) {
    if (split.lines[edit.line - 1] !== edit.before) return undefined;
    split.lines[edit.line - 1] = edit.after;
  }
  return joinLines(split);
};

export const openPullRequests = async (
  plans: FixPlan[],
  ctx: PullContext,
): Promise<PullOutcome[]> => {
  if (!REPO.test(ctx.repository) || !SHA.test(ctx.sha))
    throw new Error("unexpected GITHUB_REPOSITORY or GITHUB_SHA");
  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> => {
    const res = await ctx.fetch(`${GITHUB_API}/repos/${ctx.repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "harbyn-action",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
  const contentsPath = (path: string) =>
    `/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

  const repo = await api("GET", "");
  const defaultBranch = (repo.json as { default_branch?: unknown } | null)?.default_branch;
  if (repo.status !== 200 || typeof defaultBranch !== "string")
    throw new Error(`could not read the repository (HTTP ${repo.status})`);
  if (ctx.ref !== `refs/heads/${defaultBranch}`)
    throw new Error(
      `remediation runs only on the default branch (${defaultBranch}), not ${ctx.ref}`,
    );
  const owner = ctx.repository.split("/")[0] as string;

  const outcomes: PullOutcome[] = [];
  const ordered = [...plans].sort((a, b) =>
    (deadlineOf(a.event)?.date ?? "9999").localeCompare(deadlineOf(b.event)?.date ?? "9999"),
  );
  for (const plan of ordered) {
    if (outcomes.filter((o) => o.status === "opened").length >= MAX_PULLS) break;
    const branch = branchFor(plan.event.id);
    try {
      const earlier = await api(
        "GET",
        `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      );
      if (earlier.status !== 200 || !Array.isArray(earlier.json))
        throw new Error(`could not list pull requests (HTTP ${earlier.status})`);
      const pulls = earlier.json as Array<{ state?: unknown; html_url?: unknown }>;
      const open = pulls.find((p) => p.state === "open");
      if (open) {
        outcomes.push({
          eventId: plan.event.id,
          status: "exists",
          ...(typeof open.html_url === "string" ? { url: open.html_url } : {}),
        });
        continue;
      }
      if (pulls.length > 0) {
        outcomes.push({
          eventId: plan.event.id,
          status: "declined",
          ...(typeof pulls[0]?.html_url === "string" ? { url: pulls[0].html_url } : {}),
        });
        continue;
      }

      const files: Array<{ path: string; content: string; sha: string }> = [];
      for (const path of [...new Set(plan.edits.map((e) => e.path))]) {
        const current = await api("GET", `${contentsPath(path)}?ref=${ctx.sha}`);
        const doc = current.json as { sha?: unknown; content?: unknown; encoding?: unknown } | null;
        if (
          current.status !== 200 ||
          typeof doc?.sha !== "string" ||
          typeof doc.content !== "string" ||
          doc.encoding !== "base64"
        ) {
          throw new Error(`could not read ${path} at the scanned commit (HTTP ${current.status})`);
        }
        const text = utf8Text(Buffer.from(doc.content, "base64"));
        const next = text === undefined ? undefined : editedText(text, plan, path);
        if (next === undefined) throw new Error(`${path} is not UTF-8 or does not match the scan`);
        files.push({ path, content: next, sha: doc.sha });
      }

      const created = await api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: ctx.sha });
      if (created.status !== 201) {
        const leftover = await api(
          "GET",
          `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
        );
        const at = (leftover.json as { object?: { sha?: unknown } } | null)?.object?.sha;
        if (leftover.status !== 200 || at !== ctx.sha)
          throw new Error(`branch ${branch} already exists: delete it to get a new pull request`);
      }
      for (const file of files) {
        const put = await api("PUT", contentsPath(file.path), {
          message: `Replace ${plan.from} with ${plan.to} in ${file.path}`.slice(0, 200),
          content: Buffer.from(file.content, "utf8").toString("base64"),
          sha: file.sha,
          branch,
        });
        if (put.status !== 200 && put.status !== 201)
          throw new Error(`could not commit ${file.path} (HTTP ${put.status})`);
      }
      const { title, body } = pullRequestFor(plan, ctx.vendors);
      const pr = await api("POST", "/pulls", {
        title,
        body,
        head: branch,
        base: defaultBranch,
        maintainer_can_modify: true,
      });
      const url = (pr.json as { html_url?: unknown } | null)?.html_url;
      if (pr.status !== 201) throw new Error(`could not open the pull request (HTTP ${pr.status})`);
      outcomes.push({
        eventId: plan.event.id,
        status: "opened",
        ...(typeof url === "string" ? { url } : {}),
      });
    } catch (error) {
      outcomes.push({
        eventId: plan.event.id,
        status: "failed",
        message: (error as Error).message.slice(0, 200),
      });
    }
  }
  return outcomes;
};
