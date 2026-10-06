import { z } from "zod";
import type { ChangeEvent } from "./change-event.ts";
import { literalToken, slug } from "./primitives.ts";

export const MANIFEST_LIMITS = {
  findings: 1000,
  vendors: 200,
  count: 100_000,
  packages: 5000,
} as const;

export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
export const PYPI_PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
export const PACKAGE_VERSION = /^[0-9][0-9A-Za-z.+_-]{0,63}$/;

export const manifestPackage = z
  .strictObject({
    ecosystem: z.enum(["npm", "pypi"]),
    name: z.string().max(214),
    version: z.string().regex(PACKAGE_VERSION),
    direct: z.boolean(),
    dev: z.boolean(),
  })
  .refine(
    (p) => (p.ecosystem === "npm" ? NPM_PACKAGE_NAME : PYPI_PACKAGE_NAME).test(p.name),
    "not a public package name",
  );

const eventId = z
  .string()
  .max(160)
  .regex(/^[a-z0-9-]+\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const manifestFinding = z.strictObject({
  eventId,
  identifier: literalToken.optional(),
  via: z.enum(["model-id", "api-version", "package", "endpoint"]),
  context: z.enum(["code", "test", "docs", "catalog"]),
  count: z.number().int().min(1).max(MANIFEST_LIMITS.count),
});

export const repoManifest = z.strictObject({
  version: z.literal(1),
  scanner: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/),
  filesScanned: z.number().int().min(0).max(10_000_000),
  vendors: z.array(slug).max(MANIFEST_LIMITS.vendors),
  findings: z.array(manifestFinding).max(MANIFEST_LIMITS.findings),
  packages: z.array(manifestPackage).max(MANIFEST_LIMITS.packages).optional(),
  fixes: z
    .strictObject({
      pullRequests: z.enum(["allowed", "blocked", "unknown"]),
      opened: z.number().int().min(0).max(100),
    })
    .optional(),
});

export type RepoManifest = z.infer<typeof repoManifest>;
export type ManifestFinding = z.infer<typeof manifestFinding>;
export type ManifestPackage = z.infer<typeof manifestPackage>;

const identifiersOf = (event: ChangeEvent): Set<string> =>
  new Set(event.affects.flatMap((a) => ("values" in a ? a.values : [])));

export const manifestProblems = (
  manifest: RepoManifest,
  feed: { vendors: Array<{ id: string }>; events: ChangeEvent[] },
): string[] => {
  const vendors = new Set(feed.vendors.map((v) => v.id));
  const events = new Map(feed.events.map((e) => [e.id, e]));
  const problems: string[] = [];
  for (const v of manifest.vendors) if (!vendors.has(v)) problems.push(`unknown vendor: ${v}`);
  const seen = new Set<string>();
  for (const f of manifest.findings) {
    const event = events.get(f.eventId);
    if (!event) {
      problems.push(`unknown event: ${f.eventId}`);
      continue;
    }
    if (f.identifier !== undefined && !identifiersOf(event).has(f.identifier))
      problems.push(`identifier not listed by ${f.eventId}`);
    const key = `${f.eventId}|${f.identifier ?? ""}|${f.via}|${f.context}`;
    if (seen.has(key)) problems.push(`duplicate finding group: ${f.eventId}`);
    seen.add(key);
  }
  return problems.slice(0, 20);
};
