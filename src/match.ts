import {
  type ChangeEvent,
  declaredFloor,
  type FeedIndex,
  parseRange,
  type Range,
  satisfies,
  type Vendor,
} from "./schema/index.ts";
import type { SourceFile } from "./walk.ts";

export type FindingContext = "code" | "test" | "docs" | "catalog";
export type FindingVia = "model-id" | "api-version" | "package" | "endpoint";

export interface Finding {
  event: ChangeEvent;
  via: FindingVia;
  token: string;
  path: string;
  line: number;
  context: FindingContext;
}

export interface VendorUsage {
  vendor: Vendor;
  evidence: Set<string>;
}

const CATALOG_THRESHOLD = 6;

const isIdChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_-]/.test(ch);

export const findToken = (
  line: string,
  token: string,
  variantSuffixes: readonly string[] = [],
): string | undefined => {
  let from = 0;
  for (;;) {
    const at = line.indexOf(token, from);
    if (at === -1) return undefined;
    from = at + 1;
    const before = line[at - 1];
    if (isIdChar(before) || before === "." || before === "/") continue;
    let end = at + token.length;
    const suffix = variantSuffixes.find((s) => line.startsWith(s, end));
    if (suffix) end += suffix.length;
    const after = line[end];
    if (isIdChar(after)) continue;
    if (
      (after === "." || after === ":" || after === "@" || after === "/") &&
      isIdChar(line[end + 1])
    )
      continue;
    return line.slice(at, end);
  }
};

const MANIFEST =
  /(?:^|\/)(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|composer\.json|Gemfile|Cargo\.toml)$/;
const ECOSYSTEM_MANIFESTS: Record<string, RegExp> = {
  npm: /(?:^|\/)package\.json$/,
  pypi: /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/,
  go: /(?:^|\/)go\.mod$/,
  packagist: /(?:^|\/)composer\.json$/,
  rubygems: /(?:^|\/)Gemfile$/,
  cargo: /(?:^|\/)Cargo\.toml$/,
};

export const contextOf = (path: string): FindingContext => {
  if (
    /(?:^|\/)(?:__tests__|tests?|spec|fixtures?|__mocks__|mocks?|e2e)\//i.test(path) ||
    /\.(?:test|spec)\.[a-z]+$/i.test(path)
  )
    return "test";
  if (
    /\.(?:md|mdx|rst|txt|adoc)$/i.test(path) ||
    /(?:^|\/)(?:docs?|documentation|examples?|samples?)\//i.test(path)
  )
    return "docs";
  return "code";
};

const normalisePackageName = (ecosystem: string, name: string): string =>
  ecosystem === "pypi" ? name.toLowerCase().replace(/[._]+/g, "-") : name;

interface ModelNeedle {
  token: string;
  vendor: Vendor;
  events: ChangeEvent[];
}
interface VersionNeedle {
  event: ChangeEvent;
  vendorId: string;
  header: string | undefined;
  values: string[];
}
interface PackageNeedle {
  event: ChangeEvent;
  ecosystem: string;
  name: string;
  range: Range;
}
interface EndpointNeedle {
  event: ChangeEvent;
  vendor: Vendor;
  prefix: string;
  path: string;
}

const liveEvents = (feed: FeedIndex): ChangeEvent[] => {
  const superseded = new Set(
    feed.events.map((e) => e.supersedes).filter((id): id is string => id !== undefined),
  );
  return feed.events.filter(
    (e) => (e.status === "announced" || e.status === "in-effect") && !superseded.has(e.id),
  );
};

const VERSION_KEYWORDS = ["apiversion", "api_version", "api-version"];

export class Matcher {
  private readonly modelsByPrefix = new Map<string, ModelNeedle[]>();
  private readonly versions: VersionNeedle[] = [];
  private readonly packages: PackageNeedle[] = [];
  private readonly endpoints: EndpointNeedle[] = [];
  private readonly vendors: Vendor[];

  constructor(feed: FeedIndex) {
    this.vendors = feed.vendors;
    const vendorById = new Map(feed.vendors.map((v) => [v.id, v]));
    const models = new Map<string, ModelNeedle>();
    for (const event of liveEvents(feed)) {
      const vendor = vendorById.get(event.vendor);
      if (!vendor) continue;
      for (const target of event.affects) {
        if (target.type === "model-id") {
          for (const token of target.values) {
            const key = `${vendor.id}|${token}`;
            let needle = models.get(key);
            if (!needle) {
              needle = { token, vendor, events: [] };
              models.set(key, needle);
              const prefix =
                vendor.detection.modelIdPrefixes.find((p) => token.startsWith(p)) ?? token;
              this.modelsByPrefix.set(prefix, [...(this.modelsByPrefix.get(prefix) ?? []), needle]);
            }
            needle.events.push(event);
          }
        } else if (target.type === "api-version") {
          this.versions.push({
            event,
            vendorId: vendor.id,
            header: target.header?.toLowerCase(),
            values: target.values,
          });
        } else if (target.type === "package") {
          const range = parseRange(target.range);
          if (range)
            this.packages.push({ event, ecosystem: target.ecosystem, name: target.name, range });
        } else if (target.type === "endpoint") {
          const prefix = target.path.split("{")[0] as string;
          if (prefix.length >= 8) this.endpoints.push({ event, vendor, prefix, path: target.path });
        }
      }
    }
  }

  scanFile(file: SourceFile, findings: Finding[], usage: Map<string, VendorUsage>): void {
    const lines = file.text.split("\n");
    const baseContext = contextOf(file.path);
    const isManifest = MANIFEST.test(file.path);
    const vendorsInFile = new Set<string>();

    for (const vendor of this.vendors) {
      const note = (evidence: string) => {
        const entry = usage.get(vendor.id) ?? { vendor, evidence: new Set<string>() };
        entry.evidence.add(evidence);
        usage.set(vendor.id, entry);
        vendorsInFile.add(vendor.id);
      };
      for (const host of vendor.detection.apiHosts)
        if (file.text.includes(host)) note(`host:${host}`);
      for (const name of vendor.detection.envVars)
        if (file.text.includes(name)) note(`env:${name}`);
      if (isManifest) {
        for (const pkg of vendor.detection.packages) {
          if (
            ECOSYSTEM_MANIFESTS[pkg.ecosystem]?.test(file.path) &&
            lines.some((l) => findToken(l, pkg.name))
          ) {
            note(`${pkg.ecosystem}:${pkg.name}`);
          }
        }
      }
    }

    const local: Finding[] = [];
    this.scanModels(file, lines, baseContext, local);
    this.scanVersions(file, lines, baseContext, vendorsInFile, local);
    this.scanEndpoints(file, lines, baseContext, vendorsInFile, local);
    if (isManifest) this.scanPackages(file, lines, local);
    findings.push(...local);
  }

  private scanModels(
    file: SourceFile,
    lines: string[],
    context: FindingContext,
    out: Finding[],
  ): void {
    const found: Finding[] = [];
    for (const [prefix, needles] of this.modelsByPrefix) {
      if (!file.text.includes(prefix)) continue;
      lines.forEach((line, index) => {
        if (line.length > 4000 || !line.includes(prefix)) return;
        for (const needle of needles) {
          const matched = findToken(
            line,
            needle.token,
            needle.vendor.detection.modelIdVariantSuffixes,
          );
          if (!matched) continue;
          for (const event of needle.events) {
            found.push({
              event,
              via: "model-id",
              token: matched,
              path: file.path,
              line: index + 1,
              context,
            });
          }
        }
      });
    }
    const distinctByVendor = new Map<string, Set<string>>();
    for (const f of found) {
      distinctByVendor.set(
        f.event.vendor,
        (distinctByVendor.get(f.event.vendor) ?? new Set()).add(f.token),
      );
    }
    for (const f of found) {
      if ((distinctByVendor.get(f.event.vendor)?.size ?? 0) >= CATALOG_THRESHOLD)
        f.context = "catalog";
      out.push(f);
    }
  }

  private scanVersions(
    file: SourceFile,
    lines: string[],
    context: FindingContext,
    vendorsInFile: Set<string>,
    out: Finding[],
  ): void {
    if (this.versions.length === 0) return;
    lines.forEach((line, index) => {
      if (line.length > 4000) return;
      const lower = line.toLowerCase();
      for (const needle of this.versions) {
        const keyed = needle.header
          ? lower.includes(needle.header)
          : VERSION_KEYWORDS.some((k) => lower.includes(k));
        const vendorHere = vendorsInFile.has(needle.vendorId);
        if (!keyed && !vendorHere) continue;
        for (const value of needle.values) {
          const hit =
            (keyed && findToken(line, value) !== undefined) ||
            (vendorHere &&
              (line.includes(`/${value}/`) ||
                (VERSION_KEYWORDS.some((k) => lower.includes(k)) &&
                  findToken(line, value) !== undefined)));
          if (hit)
            out.push({
              event: needle.event,
              via: "api-version",
              token: value,
              path: file.path,
              line: index + 1,
              context,
            });
        }
      }
    });
  }

  private scanEndpoints(
    file: SourceFile,
    lines: string[],
    context: FindingContext,
    vendorsInFile: Set<string>,
    out: Finding[],
  ): void {
    for (const needle of this.endpoints) {
      if (!vendorsInFile.has(needle.vendor.id) || !file.text.includes(needle.prefix)) continue;
      lines.forEach((line, index) => {
        if (line.length > 4000) return;
        const at = line.indexOf(needle.prefix);
        if (at === -1) return;
        const exact = !needle.path.includes("{");
        if (exact && isIdChar(line[at + needle.prefix.length])) return;
        out.push({
          event: needle.event,
          via: "endpoint",
          token: needle.path,
          path: file.path,
          line: index + 1,
          context,
        });
      });
    }
  }

  private scanPackages(file: SourceFile, lines: string[], out: Finding[]): void {
    const relevant = this.packages.filter((p) => ECOSYSTEM_MANIFESTS[p.ecosystem]?.test(file.path));
    if (relevant.length === 0) return;
    const declared = new Map<string, { spec: string; line: number }>();

    if (/package\.json$|composer\.json$/.test(file.path)) {
      let json: unknown;
      try {
        json = JSON.parse(file.text);
      } catch {
        return;
      }
      if (typeof json !== "object" || json === null) return;
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
        "require",
        "require-dev",
      ]) {
        const deps = (json as Record<string, unknown>)[section];
        if (typeof deps !== "object" || deps === null) continue;
        for (const [name, spec] of Object.entries(deps)) {
          if (typeof spec !== "string") continue;
          const line = lines.findIndex((l) => l.includes(`"${name}"`)) + 1;
          declared.set(name, { spec, line: line || 1 });
        }
      }
    } else {
      lines.forEach((line, index) => {
        const m = /^\s*["']?([A-Za-z0-9@][A-Za-z0-9._/-]*)["']?\s*(?:[=<>~!^]|\s+v?\d)(.*)$/.exec(
          line.slice(0, 300),
        );
        if (m)
          declared.set(m[1] as string, {
            spec: line.slice(line.indexOf(m[1] as string) + (m[1] as string).length),
            line: index + 1,
          });
      });
    }

    for (const needle of relevant) {
      const wanted = normalisePackageName(needle.ecosystem, needle.name);
      const entry = [...declared].find(
        ([name]) => normalisePackageName(needle.ecosystem, name) === wanted,
      )?.[1];
      const floor = entry ? declaredFloor(entry.spec) : undefined;
      if (!entry || !floor || !satisfies(floor, needle.range)) continue;
      out.push({
        event: needle.event,
        via: "package",
        token: `${needle.name}@${floor.join(".")}`,
        path: file.path,
        line: entry.line,
        context: "code",
      });
    }
  }
}
