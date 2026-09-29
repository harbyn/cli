import { type ChangeEvent, deadlineOf } from "./schema/index.ts";
import type { FixPlan, Unfixable } from "./fix.ts";
import type { Inventory } from "./inventory.ts";
import type { Finding, VendorUsage } from "./match.ts";
import type { WalkStats } from "./walk.ts";

export interface ScanResult {
  findings: Finding[];
  usage: VendorUsage[];
  stats: WalkStats;
  inventory?: Inventory;
}

export const safe = (s: string): string =>
  Array.from(s, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    const printable =
      (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp < 0x2000) || (cp >= 0x3000 && cp < 0xd800);
    return printable ? ch : "?";
  }).join("");

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const deadlineLabel = (event: ChangeEvent, today: string): string => {
  if (event.effectiveMonth && !event.effectiveAt) {
    const [year, month] = event.effectiveMonth.split("-");
    const label = `${MONTHS[Number(month) - 1]} ${year}, no exact day announced`;
    const days = daysBetween(today, `${event.effectiveMonth}-01`);
    if (today.slice(0, 7) > event.effectiveMonth) return `ALREADY IN EFFECT since ${label}`;
    if (days <= 0) return `THIS MONTH (${label})`;
    return `in about ${days} days (${label})`;
  }
  if (!event.effectiveAt) return "no date announced yet";
  const days = daysBetween(today, event.effectiveAt);
  if (days < 0) return `ALREADY IN EFFECT since ${event.effectiveAt} (${-days} days ago)`;
  if (days === 0) return `TODAY (${event.effectiveAt})`;
  return `in ${days} days (${event.effectiveAt})`;
};

export const toJson = (result: ScanResult) => ({
  schemaVersion: 1,
  stats: result.stats,
  vendors: result.usage.map((u) => ({ id: u.vendor.id, evidence: [...u.evidence].sort() })),
  findings: result.findings.map((f) => ({
    eventId: f.event.id,
    kind: f.event.kind,
    severity: f.event.severity,
    effectiveAt: f.event.effectiveAt ?? null,
    effectiveMonth: f.event.effectiveMonth ?? null,
    via: f.via,
    context: f.context,
    token: f.token,
    path: f.path,
    line: f.line,
    replacement: f.event.replacement?.targets.flatMap((t) => ("values" in t ? t.values : [])) ?? [],
    source: f.event.sources[0]?.url ?? null,
  })),
  dependencies: result.inventory?.dependencies ?? [],
});

export const toFixText = (
  plans: FixPlan[],
  unfixable: Unfixable[],
  written?: { written: string[]; conflicts: string[] },
): string => {
  const out: string[] = [];
  for (const plan of plans) {
    out.push(
      `${plan.event.title}`,
      `  replace with: ${safe(plan.to)}   source: ${plan.event.sources[0]?.url ?? "-"}`,
    );
    for (const e of plan.edits)
      out.push(
        `  ${safe(e.path)}:${e.line}`,
        `  - ${safe(e.before.trim())}`,
        `  + ${safe(e.after.trim())}`,
      );
    for (const s of plan.skipped)
      out.push(`  not changed: ${safe(s.path)}:${s.line} (${s.reason})`);
    out.push("");
  }
  for (const u of unfixable)
    out.push(`Not fixed automatically: ${u.event.title}`, `  ${u.reason}`, "");
  const edits = plans.reduce((n, p) => n + p.edits.length, 0);
  if (plans.length === 0 && unfixable.length === 0)
    out.push("Nothing to fix: no retired model or API version with a named replacement was found.");
  else if (written) {
    out.push(
      `Changed ${written.written.length} ${written.written.length === 1 ? "file" : "files"}. Review with git diff.`,
    );
    if (written.conflicts.length > 0)
      out.push(
        `Left alone (changed since the scan, or not a regular file): ${written.conflicts.map(safe).join(", ")}`,
      );
  } else if (edits > 0)
    out.push(
      `${edits} ${edits === 1 ? "line" : "lines"} can be fixed. Run again with --write to apply them, then review with git diff.`,
    );
  return out.join("\n");
};

export const toDependencyText = (result: ScanResult): string => {
  const inv = result.inventory;
  if (!inv || inv.dependencies.length === 0)
    return "No dependencies found in lockfiles (package-lock, pnpm-lock, yarn.lock, poetry.lock, uv.lock, pinned requirements).";
  const out = inv.dependencies.map(
    (d) =>
      `${d.ecosystem.padEnd(5)} ${safe(d.name)}@${safe(d.version)}${d.direct ? "" : "  (transitive)"}${d.dev ? "  (dev)" : ""}`,
  );
  out.push("", dependencySummary(result));
  return out.join("\n");
};

export const dependencySummary = (result: ScanResult): string => {
  const inv = result.inventory;
  if (!inv) return "";
  const direct = inv.dependencies.filter((d) => d.direct).length;
  const skipped =
    inv.skippedNonPublic > 0
      ? `; ${inv.skippedNonPublic} private, workspace or git entries not listed`
      : "";
  return `${inv.dependencies.length} dependencies (${direct} direct) from ${inv.files.length} ${inv.files.length === 1 ? "lockfile" : "lockfiles"}${skipped}`;
};

export const sortKey = (group: Finding[]): string =>
  (group[0] ? deadlineOf(group[0].event)?.date : undefined) ?? "9999";

export const actionable = (result: ScanResult): Finding[] =>
  result.findings.filter((f) => f.context === "code");

export const toText = (result: ScanResult, today: string, showAll = false): string => {
  const out: string[] = [];
  const shownFindings = showAll ? result.findings : actionable(result);
  const byEvent = new Map<string, Finding[]>();
  for (const f of shownFindings) byEvent.set(f.event.id, [...(byEvent.get(f.event.id) ?? []), f]);
  const groups = [...byEvent.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  if (result.usage.length > 0) {
    out.push("Vendors detected:");
    for (const u of result.usage)
      out.push(`  ${u.vendor.name}  (${[...u.evidence].sort().slice(0, 4).join(", ")})`);
    out.push("");
  }

  if (groups.length === 0) out.push("No known dated changes affect this repository.");
  for (const group of groups) {
    const event = (group[0] as Finding).event;
    out.push(`[${event.severity.toUpperCase()}] ${event.title}`);
    out.push(`  when:   ${deadlineLabel(event, today)}`);
    const replacement =
      event.replacement?.targets.flatMap((t) => ("values" in t ? t.values : [])) ?? [];
    if (replacement.length > 0) out.push(`  use:    ${replacement.join(", ")}`);
    out.push(`  source: ${event.sources[0]?.url ?? "-"}`);
    const shown = group.slice(0, 12);
    for (const f of shown)
      out.push(
        `    ${safe(f.path)}:${f.line}  ${safe(f.token)}${f.context === "code" ? "" : `  [${f.context}]`}`,
      );
    if (group.length > shown.length) out.push(`    ... and ${group.length - shown.length} more`);
    out.push("");
  }

  const low = result.findings.length - actionable(result).length;
  const nested = result.stats.skippedNestedRepos;
  out.push(
    `${actionable(result).length} finding(s), ${result.stats.scanned} ${result.stats.scanned === 1 ? "file" : "files"} scanned` +
      (result.stats.truncated ? " (file limit reached; scan is partial)" : ""),
  );
  if (low > 0 && !showAll)
    out.push(`${low} more in tests, docs and model catalogs (low confidence) - show with --all`);
  if (result.inventory && result.inventory.dependencies.length > 0)
    out.push(`${dependencySummary(result)} - list with --deps`);
  if (nested.length > 0) {
    out.push(
      `skipped ${nested.length} nested repo(s): ${nested.slice(0, 5).map(safe).join(", ")}${nested.length > 5 ? ", ..." : ""} - include with --include-nested`,
    );
  }
  if (result.stats.skippedSecret > 0)
    out.push(`${result.stats.skippedSecret} secret file(s) were not opened`);
  return out.join("\n");
};
