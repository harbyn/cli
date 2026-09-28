import type { FeedIndex } from "./schema/index.ts";
import { type Finding, Matcher, type VendorUsage } from "./match.ts";
import type { ScanResult } from "./report.ts";
import { newStats, type WalkOptions, walk } from "./walk.ts";

export * from "./ignore.ts";
export * from "./match.ts";
export * from "./remote-feed.ts";
export * from "./report.ts";
export * from "./walk.ts";

export const scan = (root: string, feed: FeedIndex, options: WalkOptions = {}): ScanResult => {
  const stats = newStats();
  const findings: Finding[] = [];
  const usage = new Map<string, VendorUsage>();
  const matcher = new Matcher(feed);
  for (const file of walk(root, stats, options)) matcher.scanFile(file, findings, usage);
  return {
    findings,
    usage: [...usage.values()].sort((a, b) => a.vendor.id.localeCompare(b.vendor.id)),
    stats,
  };
};
