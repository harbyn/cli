import { deadlineOf } from "./schema/index.ts";
import type { Finding } from "./match.ts";
import { actionable, deadlineLabel, type ScanResult, safe } from "./report.ts";

export const MAX_ANNOTATIONS_PER_LEVEL = 10;
export const MAX_SUMMARY_ROWS = 500;
const MAX_TITLE = 200;
const MAX_MESSAGE = 900;

const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

export const escapeData = (s: string): string =>
  s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (s: string): string =>
  escapeData(s).replaceAll(":", "%3A").replaceAll(",", "%2C");

export type Level = "error" | "warning";

export const workflowCommand = (level: Level, title: string, message: string): string =>
  `::${level} title=${escapeProperty(safe(title))}::${escapeData(cap(safe(message), MAX_MESSAGE))}`;

export const levelOf = (finding: Finding, today: string): Level => {
  const deadline = deadlineOf(finding.event)?.date;
  return deadline !== undefined && deadline <= today ? "error" : "warning";
};

const replacementOf = (finding: Finding): string[] =>
  finding.event.replacement?.targets.flatMap((t) => ("values" in t ? t.values : [])) ?? [];

const repoPath = (path: string, prefix: string): string => (prefix ? `${prefix}/${path}` : path);

const byDeadline = (a: Finding, b: Finding): number =>
  (deadlineOf(a.event)?.date ?? "9999").localeCompare(deadlineOf(b.event)?.date ?? "9999") ||
  a.path.localeCompare(b.path) ||
  a.line - b.line;

export const toAnnotations = (result: ScanResult, today: string, pathPrefix = ""): string[] => {
  const shown: Record<Level, number> = { error: 0, warning: 0 };
  const lines: string[] = [];
  for (const finding of [...actionable(result)].sort(byDeadline)) {
    const level = levelOf(finding, today);
    if (shown[level] >= MAX_ANNOTATIONS_PER_LEVEL) continue;
    shown[level] += 1;
    const replacement = replacementOf(finding);
    const message = [
      `${safe(finding.token)}: ${deadlineLabel(finding.event, today)}.`,
      replacement.length > 0 ? `Use instead: ${safe(replacement.join(", "))}.` : "",
      `Source: ${safe(finding.event.sources[0]?.url ?? "-")}`,
    ]
      .filter(Boolean)
      .join(" ");
    const props = `file=${escapeProperty(safe(repoPath(finding.path, pathPrefix)))},line=${finding.line},title=${escapeProperty(cap(safe(finding.event.title), MAX_TITLE))}`;
    lines.push(`::${level} ${props}::${escapeData(cap(message, MAX_MESSAGE))}`);
  }
  return lines;
};

export const mdText = (s: string): string =>
  Array.from(safe(s), (ch) =>
    /[A-Za-z0-9 .,:;/=?@+-]/.test(ch) ? ch : `&#${ch.codePointAt(0)};`,
  ).join("");

const mdLink = (url: string | undefined): string =>
  url && /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%/-]*)?(?:#[A-Za-z0-9._~-]*)?$/.test(url)
    ? `[source](${url})`
    : mdText(url ?? "-");

export const toStepSummary = (
  result: ScanResult,
  today: string,
  productName: string,
  pathPrefix = "",
  uploading = false,
): string => {
  const findings = [...actionable(result)].sort(byDeadline);
  const out = [`## ${mdText(productName)} scan`, ""];
  if (findings.length === 0) {
    out.push("No known dated vendor changes affect this repository.", "");
  } else {
    const errors = findings.filter((f) => levelOf(f, today) === "error").length;
    out.push(
      `**${findings.length}** ${findings.length === 1 ? "line is" : "lines are"} affected by vendor changes (${errors} already due).`,
      "",
    );
    out.push("| When | Change | Where | Use instead | |", "| --- | --- | --- | --- | --- |");
    for (const f of findings.slice(0, MAX_SUMMARY_ROWS)) {
      const replacement = replacementOf(f);
      out.push(
        `| ${mdText(deadlineLabel(f.event, today))} | ${mdText(f.event.title)} | ${mdText(`${repoPath(f.path, pathPrefix)}:${f.line}`)} ${mdText(f.token)} | ${replacement.length > 0 ? mdText(replacement.join(", ")) : "-"} | ${mdLink(f.event.sources[0]?.url)} |`,
      );
    }
    out.push("");
    if (findings.length > MAX_SUMMARY_ROWS) {
      out.push(
        `The table shows the first ${MAX_SUMMARY_ROWS}, by deadline. The JSON report (the \`report\` output) has all of them.`,
        "",
      );
    }
    const perLevel = { error: errors, warning: findings.length - errors };
    if (
      perLevel.error > MAX_ANNOTATIONS_PER_LEVEL ||
      perLevel.warning > MAX_ANNOTATIONS_PER_LEVEL
    ) {
      out.push(
        `GitHub shows at most ${MAX_ANNOTATIONS_PER_LEVEL} annotations of each level on the lines; the table lists the rest.`,
        "",
      );
    }
  }
  const low = result.findings.length - findings.length;
  if (low > 0)
    out.push(
      `${low} more in tests, docs and model catalogs (low confidence) are not annotated.`,
      "",
    );
  const scanned = `${result.stats.scanned} ${result.stats.scanned === 1 ? "file" : "files"} scanned on the runner.`;
  out.push(
    uploading
      ? `${scanned} The upload below is everything that leaves the runner.`
      : `${scanned} Nothing about this repository was sent anywhere.`,
    "",
  );
  return out.join("\n");
};
