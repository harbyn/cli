import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import {
  type ChangeEvent,
  changeEvent,
  checkEventAgainstVendor,
  type Vendor,
  vendor,
} from "../schema/index.ts";

const MAX_FILE_BYTES = 64 * 1024;

export interface LoadedFeed {
  vendors: Vendor[];
  events: ChangeEvent[];
  problems: string[];
}

const listJson = (root: string, dir: string, problems: string[]): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join(posix.sep);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) problems.push(`${rel}: symlinks are not allowed in the feed`);
    else if (stat.isDirectory()) out.push(...listJson(root, full, problems));
    else if (!stat.isFile() || !name.endsWith(".json"))
      problems.push(`${rel}: only .json files are allowed`);
    else if (stat.size > MAX_FILE_BYTES)
      problems.push(`${rel}: larger than ${MAX_FILE_BYTES} bytes`);
    else out.push(rel);
  }
  return out;
};

const readJson = (root: string, rel: string, problems: string[]): unknown => {
  try {
    return JSON.parse(readFileSync(join(root, rel), "utf8"));
  } catch (error) {
    problems.push(`${rel}: invalid JSON (${(error as Error).message})`);
    return undefined;
  }
};

const formatIssues = (
  rel: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): string[] =>
  issues.map((i) => `${rel}: ${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

export const loadFeed = (root: string): LoadedFeed => {
  const problems: string[] = [];
  const vendors = new Map<string, Vendor>();
  const events = new Map<string, ChangeEvent>();

  for (const rel of listJson(root, join(root, "vendors"), problems)) {
    const parsed = vendor.safeParse(readJson(root, rel, problems));
    if (!parsed.success) problems.push(...formatIssues(rel, parsed.error.issues));
    else if (rel !== `vendors/${parsed.data.id}.json`)
      problems.push(`${rel}: file name must equal vendor id '${parsed.data.id}'`);
    else vendors.set(parsed.data.id, parsed.data);
  }

  for (const rel of listJson(root, join(root, "events"), problems)) {
    const parsed = changeEvent.safeParse(readJson(root, rel, problems));
    if (!parsed.success) {
      problems.push(...formatIssues(rel, parsed.error.issues));
      continue;
    }
    const event = parsed.data;
    if (rel !== `events/${event.id}.json`)
      problems.push(`${rel}: path must equal events/<id>.json for id '${event.id}'`);
    const owner = vendors.get(event.vendor);
    if (!owner) problems.push(`${rel}: unknown vendor '${event.vendor}'`);
    else problems.push(...checkEventAgainstVendor(event, owner).map((p) => `${rel}: ${p}`));
    events.set(event.id, event);
  }

  for (const event of events.values()) {
    if (event.supersedes && !events.has(event.supersedes)) {
      problems.push(`events/${event.id}.json: supersedes unknown event '${event.supersedes}'`);
    }
  }

  return { vendors: [...vendors.values()], events: [...events.values()], problems };
};
