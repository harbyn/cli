import type { FeedIndex } from "./schema/index.ts";
import { type Finding, Matcher, type VendorUsage } from "./match.ts";
import { InventoryCollector } from "./inventory.ts";
import type { ScanResult } from "./report.ts";
import { newStats, type WalkOptions, walk } from "./walk.ts";

export * from "./engine.ts";
export * from "./ignore.ts";
export * from "./inventory.ts";
export * from "./match.ts";
export * from "./remote-feed.ts";
export * from "./report.ts";
export * from "./walk.ts";
export { mdText } from "./github.ts";
export { CLI_NAME, CLI_VERSION } from "./product.ts";

export const scan = (root: string, feed: FeedIndex, options: WalkOptions = {}): ScanResult => {
  const stats = newStats();
  const findings: Finding[] = [];
  const usage = new Map<string, VendorUsage>();
  const matcher = new Matcher(feed);
  const inventory = new InventoryCollector();
  for (const file of walk(root, stats, {
    ...options,
    onLockfile: (lock) => inventory.add(lock.path, lock.text),
  })) {
    matcher.scanFile(file, findings, usage);
    inventory.add(file.path, file.text);
  }
  return {
    findings,
    usage: [...usage.values()].sort((a, b) => a.vendor.id.localeCompare(b.vendor.id)),
    stats,
    inventory: inventory.result(),
  };
};
