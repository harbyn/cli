import { type ChangeEvent, deadlineOf, parseVersion, type Version } from "./schema/index.ts";
import { CLI_NAME } from "./product.ts";
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
  if (!event.effectiveAt)
    return event.kind === "security" && event.status !== "announced"
      ? "now (security advisory, no deadline)"
      : "no date announced yet";
  const days = daysBetween(today, event.effectiveAt);
  if (days < 0) return `ALREADY IN EFFECT since ${event.effectiveAt} (${-days} days ago)`;
  if (days === 0) return `TODAY (${event.effectiveAt})`;
  return `in ${days} days (${event.effectiveAt})`;
};

type Target = ChangeEvent["affects"][number];
type PackageTarget = Extract<Target, { type: "package" }>;

const floorOf = (range: string): Version | undefined => {
  const m = /^>=?(\d{1,6}(?:\.\d{1,6}){0,2})$/.exec(range.trim());
  return m ? parseVersion(m[1] as string) : undefined;
};
const before = (a: Version, b: Version): boolean =>
  a[0] - b[0] < 0 || (a[0] === b[0] && (a[1] - b[1] < 0 || (a[1] === b[1] && a[2] < b[2])));

const packageTargets = (
  targets: readonly Target[],
  finding?: Pick<Finding, "via" | "token">,
): PackageTarget[] => {
  const all = targets.filter((t): t is PackageTarget => t.type === "package");
  if (!finding || finding.via !== "package") return all;
  const at = finding.token.lastIndexOf("@");
  const name = finding.token.slice(0, at);
  const declared = parseVersion(finding.token.slice(at + 1));
  const same = all.filter((t) => t.name === name);
  if (!declared || same.length === 0) return all;
  const above = same
    .map((t) => ({ t, floor: floorOf(t.range) }))
    .filter(
      (x): x is { t: PackageTarget; floor: Version } =>
        x.floor !== undefined && before(declared, x.floor),
    )
    .sort((a, b) => (before(a.floor, b.floor) ? -1 : before(b.floor, a.floor) ? 1 : 0));
  return above.length > 0 ? [(above[0] as { t: PackageTarget }).t] : same;
};

const targetText = (t: Target): string[] => {
  switch (t.type) {
    case "package":
      return [`${t.name} ${t.range}`];
    case "endpoint":
      return [`${t.method} ${t.path}`];
    default:
      return t.values;
  }
};

export const replacementOf = (
  event: ChangeEvent,
  finding?: Pick<Finding, "via" | "token">,
): { label: string; text: string } | undefined => {
  const targets = event.replacement?.targets ?? [];
  const note = event.replacement?.note;
  const packages = packageTargets(targets, finding);
  if (packages.length > 0)
    return { label: "Upgrade to", text: packages.flatMap(targetText).join(" or ") };
  const others = targets.filter((t) => t.type !== "package");
  if (note && others.every((t) => t.type === "symbol"))
    return { label: others.length > 0 ? "Migrate to" : "What to do", text: note };
  if (others.length > 0)
    return {
      label: "Migrate to",
      text: `${others.flatMap(targetText).join(", ")}${note ? ` (${note})` : ""}`,
    };
  return undefined;
};

export const NO_REPLACEMENT =
  "Replacement: none named yet, by the vendor or by Harbyn; check the source before changing anything";

export const replacementLine = (
  event: ChangeEvent,
  finding?: Pick<Finding, "via" | "token">,
): string => {
  const r = replacementOf(event, finding);
  return r ? `${r.label}: ${r.text}` : NO_REPLACEMENT;
};

export const replacementTargets = (
  event: ChangeEvent,
  finding?: Pick<Finding, "via" | "token">,
): string[] => {
  const targets = event.replacement?.targets ?? [];
  return [
    ...packageTargets(targets, finding),
    ...targets.filter((t) => t.type !== "package"),
  ].flatMap(targetText);
};

export const nestedNotice = (nested: readonly string[]): string | undefined => {
  if (nested.length === 0) return undefined;
  const names = `${nested.slice(0, 5).map(safe).join(", ")}${nested.length > 5 ? `, and ${nested.length - 5} more` : ""}`;
  const one = nested.length === 1;
  return `Skipped ${nested.length} nested ${one ? "repository" : "repositories"}: ${names} (${one ? "it is its own git repository" : "each is its own git repository"}; run \`npx ${CLI_NAME} scan\` inside ${one ? "it" : "each"}, or add --include-nested)`;
};

export const toJson = (result: ScanResult) => ({
  schemaVersion: 1,
  stats: result.stats,
  vendors: result.usage.map((u) => ({ id: u.vendor.id, evidence: [...u.evidence].sort() })),
  skippedNestedRepos: result.stats.skippedNestedRepos,
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
    replacement: replacementTargets(f.event, f),
    replacementNote: f.event.replacement?.note ?? null,
    nextStep: replacementLine(f.event, f),
    source: f.event.sources[0]?.url ?? null,
  })),
  dependencies: result.inventory?.dependencies ?? [],
});

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
  const nested = nestedNotice(result.stats.skippedNestedRepos);
  if (nested && groups.length === 0) out.push(nested, "");
  for (const group of groups) {
    const event = (group[0] as Finding).event;
    out.push(`[${event.severity.toUpperCase()}] ${event.title}`);
    out.push(`  ${safe(replacementLine(event, group[0]))}`);
    out.push(`  when:   ${deadlineLabel(event, today)}`);
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
  out.push(
    `${actionable(result).length} finding(s), ${result.stats.scanned} ${result.stats.scanned === 1 ? "file" : "files"} scanned` +
      (result.stats.truncated ? " (file limit reached; scan is partial)" : ""),
  );
  if (low > 0 && !showAll)
    out.push(`${low} more in tests, docs and model catalogs (low confidence) - show with --all`);
  if (result.inventory && result.inventory.dependencies.length > 0)
    out.push(`${dependencySummary(result)} - list with --deps`);
  if (nested && groups.length > 0) out.push(nested);
  if (result.stats.skippedSecret > 0)
    out.push(`${result.stats.skippedSecret} secret file(s) were not opened`);
  return out.join("\n");
};
