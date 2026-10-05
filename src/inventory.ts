import { NPM_PACKAGE_NAME, PACKAGE_VERSION, PYPI_PACKAGE_NAME } from "./schema/index.ts";

export type InventoryEcosystem = "npm" | "pypi";

export interface Dependency {
  ecosystem: InventoryEcosystem;
  name: string;
  version: string;
  direct: boolean;
  dev: boolean;
}

export interface Inventory {
  dependencies: Dependency[];
  files: string[];
  skippedNonPublic: number;
  skippedInvalid: number;
}

export const INVENTORY_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "uv.lock",
]);
export const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;
export const MAX_DEPENDENCIES = 20_000;

const NPM_NAME = NPM_PACKAGE_NAME;
const PYPI_NAME = PYPI_PACKAGE_NAME;
const VERSION = PACKAGE_VERSION;
const PUBLIC_NPM = /^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\//;
const PUBLIC_PYPI =
  /^https:\/\/(?:pypi\.org\/simple|pypi\.python\.org\/simple|files\.pythonhosted\.org)\/?/;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, "");
export const normalisePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

interface Raw {
  ecosystem: InventoryEcosystem;
  name: string;
  version: string;
  public: boolean;
  dev?: boolean;
}

interface DirectSet {
  prod: Set<string>;
  dev: Set<string>;
}

const npmDirect = (text: string): DirectSet | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const names = (key: string) => {
    const section = (json as Record<string, unknown>)[key];
    return typeof section === "object" && section !== null ? Object.keys(section) : [];
  };
  return {
    prod: new Set([
      ...names("dependencies"),
      ...names("optionalDependencies"),
      ...names("peerDependencies"),
    ]),
    dev: new Set(names("devDependencies")),
  };
};

const fromPackageLock = (text: string): { raws: Raw[]; direct?: DirectSet } => {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raws: [] };
  }
  const raws: Raw[] = [];
  const packages = json.packages;
  if (typeof packages === "object" && packages !== null) {
    const root = (packages as Record<string, unknown>)[""];
    const direct = root ? npmDirect(JSON.stringify(root)) : undefined;
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      if (key === "" || typeof value !== "object" || value === null) continue;
      const at = key.lastIndexOf("node_modules/");
      const entry = value as {
        version?: unknown;
        resolved?: unknown;
        dev?: unknown;
        link?: unknown;
      };
      if (at === -1 || entry.link === true) {
        raws.push({ ecosystem: "npm", name: key, version: "0", public: false });
        continue;
      }
      const name = key.slice(at + "node_modules/".length);
      const resolved = typeof entry.resolved === "string" ? entry.resolved : "";
      raws.push({
        ecosystem: "npm",
        name,
        version: String(entry.version ?? ""),
        public: PUBLIC_NPM.test(resolved),
        dev: entry.dev === true,
      });
    }
    return { raws, ...(direct ? { direct } : {}) };
  }
  const walkV1 = (deps: unknown, depth: number): void => {
    if (typeof deps !== "object" || deps === null || depth > 50) return;
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as {
        version?: unknown;
        resolved?: unknown;
        dev?: unknown;
        dependencies?: unknown;
      };
      raws.push({
        ecosystem: "npm",
        name,
        version: String(entry.version ?? ""),
        public: PUBLIC_NPM.test(String(entry.resolved ?? "")),
        dev: entry.dev === true,
      });
      walkV1(entry.dependencies, depth + 1);
    }
  };
  walkV1(json.dependencies, 0);
  return { raws };
};

const pnpmKey = (key: string): { name: string; version: string } | undefined => {
  const k = unquote(key).replace(/\(.*$/, "").replace(/^\//, "");
  const at = k.lastIndexOf("@");
  if (at > 0) return { name: k.slice(0, at), version: k.slice(at + 1) };
  const slash = k.lastIndexOf("/");
  return slash > 0 ? { name: k.slice(0, slash), version: k.slice(slash + 1) } : undefined;
};

const fromPnpmLock = (text: string): { raws: Raw[]; direct: DirectSet } => {
  const raws: Raw[] = [];
  const direct: DirectSet = { prod: new Set(), dev: new Set() };
  const lines = text.split(/\r?\n/);
  let section = "";
  let importerSection = "";
  let current: { name: string; version: string; public: boolean; dev?: boolean } | undefined;
  let directName: string | undefined;
  const flush = () => {
    if (current) raws.push({ ecosystem: "npm", ...current });
    current = undefined;
  };
  for (const line of lines) {
    if (/^\S/.test(line)) {
      flush();
      section = line.replace(/:.*$/, "");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (section === "importers") {
      if (indent === 4 && trimmed.endsWith(":")) importerSection = trimmed.slice(0, -1);
      else if (indent === 6 && trimmed.endsWith(":")) directName = unquote(trimmed.slice(0, -1));
      else if (indent === 6 && trimmed.includes(": ")) {
        const [name, spec] = trimmed.split(/:\s+/, 2);
        if (name && spec && !/^(?:link|file|workspace):/.test(unquote(spec)))
          (importerSection === "devDependencies" ? direct.dev : direct.prod).add(unquote(name));
      } else if (indent === 8 && directName && trimmed.startsWith("version:")) {
        if (!/^(?:link|file|workspace):/.test(unquote(trimmed.slice(8))))
          (importerSection === "devDependencies" ? direct.dev : direct.prod).add(directName);
        directName = undefined;
      }
    } else if (section === "packages") {
      if (indent === 2 && trimmed.endsWith(":")) {
        flush();
        const parsed = pnpmKey(trimmed.slice(0, -1));
        current = parsed
          ? { ...parsed, public: !/[:@](?:https?:|git|file:|link:)/.test(trimmed) }
          : undefined;
      } else if (
        current &&
        /^resolution:/.test(trimmed) &&
        /tarball:|directory:|repo:|commit:/.test(trimmed)
      ) {
        current.public = false;
      } else if (current && trimmed === "dev: true") {
        current.dev = true;
      }
    }
  }
  flush();
  return { raws, direct };
};

const fromYarnLock = (text: string): Raw[] => {
  const raws: Raw[] = [];
  let header: string | undefined;
  let version = "";
  let origin = "";
  const flush = () => {
    if (header && header !== "__metadata") {
      const first = unquote(header.split(",")[0] ?? "");
      const at = first.lastIndexOf("@");
      const name = at > 0 ? first.slice(0, at) : first;
      const isPublic =
        PUBLIC_NPM.test(origin) ||
        (/@npm:\d/.test(origin) && !/@(?:patch|workspace|link|portal|file|git|exec):/.test(origin));
      raws.push({ ecosystem: "npm", name, version, public: isPublic });
    }
    header = undefined;
    version = "";
    origin = "";
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (/^\S.*:$/.test(line)) {
      flush();
      header = line.slice(0, -1);
      continue;
    }
    const m = /^\s+(version|resolved|resolution):?\s+"?([^"]*)"?\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === "version") version = m[2] as string;
    else origin = m[2] as string;
  }
  flush();
  return raws;
};

const fromPythonLock = (
  text: string,
  kind: "poetry" | "uv",
): { raws: Raw[]; rootDirect?: Set<string> } => {
  const raws: Raw[] = [];
  let rootDirect: Set<string> | undefined;
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!name) continue;
    if (kind === "uv") {
      const source = /^source\s*=\s*\{([^}]*)\}/m.exec(block)?.[1] ?? "";
      if (/virtual\s*=|editable\s*=/.test(source)) {
        const deps = /^dependencies\s*=\s*\[([\s\S]*?)^\]/m.exec(block)?.[1] ?? "";
        rootDirect = new Set(
          [...deps.matchAll(/name\s*=\s*"([^"]+)"/g)].map((m) => normalisePypi(m[1] as string)),
        );
        continue;
      }
      const registry = /registry\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? "";
      raws.push({
        ecosystem: "pypi",
        name,
        version: version ?? "",
        public: PUBLIC_PYPI.test(registry),
      });
    } else {
      const source = /^\[package\.source\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(block)?.[1];
      raws.push({ ecosystem: "pypi", name, version: version ?? "", public: source === undefined });
    }
  }
  return { raws, ...(rootDirect ? { rootDirect } : {}) };
};

const pyprojectDirect = (text: string): Set<string> => {
  const names = new Set<string>();
  const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1] ?? "";
  for (const m of list.matchAll(/"([A-Za-z0-9][A-Za-z0-9._-]*)/g))
    names.add(normalisePypi(m[1] as string));
  for (const table of text.matchAll(
    /^\[tool\.poetry(?:\.group\.[^\]]+)?\.(?:dev-)?dependencies\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm,
  )) {
    for (const m of (table[1] as string).matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm))
      if (m[1] !== "python") names.add(normalisePypi(m[1] as string));
  }
  return names;
};

const fromRequirements = (text: string): Raw[] => {
  const raws: Raw[] = [];
  const privateIndex =
    /^\s*(?:-i|--index-url|--extra-index-url|--find-links|-f)\b/m.test(text) &&
    !/^\s*(?:-i|--index-url)\s+https:\/\/pypi\.org\/simple\/?\s*$/m.test(text);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
    const m =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([0-9][0-9A-Za-z.+_-]*)\s*(?:;.*)?$/.exec(
        line,
      );
    if (m)
      raws.push({
        ecosystem: "pypi",
        name: m[1] as string,
        version: m[2] as string,
        public: !privateIndex,
      });
    else if (/(?:^|\s)(?:git\+|https?:|file:|\.\/|\/)|\s@\s/.test(line))
      raws.push({ ecosystem: "pypi", name: "local", version: "0", public: false });
  }
  return raws;
};

export class InventoryCollector {
  private readonly raws = new Map<string, Raw & { direct: boolean }>();
  private readonly npmDirectByDir = new Map<string, DirectSet>();
  private readonly pyDirectByDir = new Map<string, Set<string>>();
  private readonly pending: Array<{
    dir: string;
    raws: Raw[];
    direct?: DirectSet;
    pyDirect?: Set<string>;
  }> = [];
  private readonly files: string[] = [];
  private nonPublic = 0;
  private invalid = 0;

  add(path: string, text: string): void {
    const name = basename(path);
    const dir = dirname(path);
    if (name === "package.json") {
      const direct = npmDirect(text);
      if (direct) this.npmDirectByDir.set(dir, direct);
      return;
    }
    if (name === "pyproject.toml") {
      this.pyDirectByDir.set(dir, pyprojectDirect(text));
      return;
    }
    if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
      const parsed = fromPackageLock(text);
      this.pending.push({
        dir,
        raws: parsed.raws,
        ...(parsed.direct ? { direct: parsed.direct } : {}),
      });
    } else if (name === "pnpm-lock.yaml") {
      const parsed = fromPnpmLock(text);
      this.pending.push({ dir, raws: parsed.raws, direct: parsed.direct });
    } else if (name === "yarn.lock") {
      this.pending.push({ dir, raws: fromYarnLock(text) });
    } else if (name === "poetry.lock" || name === "uv.lock") {
      const parsed = fromPythonLock(text, name === "uv.lock" ? "uv" : "poetry");
      this.pending.push({
        dir,
        raws: parsed.raws,
        ...(parsed.rootDirect ? { pyDirect: parsed.rootDirect } : {}),
      });
    } else if (/^requirements(?:[-_.][A-Za-z0-9_-]+)?\.txt$/.test(name)) {
      this.pending.push({
        dir,
        raws: fromRequirements(text).map((r) => ({ ...r, dev: /dev|test/i.test(name) })),
        pyDirect: new Set(["*"]),
      });
    } else {
      return;
    }
    this.files.push(path);
  }

  result(): Inventory {
    for (const { dir, raws, direct, pyDirect } of this.pending) {
      const npmDirect = direct ?? this.npmDirectByDir.get(dir);
      const pyDirectSet = pyDirect ?? this.pyDirectByDir.get(dir);
      for (const raw of raws) {
        if (!raw.public) {
          this.nonPublic++;
          continue;
        }
        const name = raw.ecosystem === "pypi" ? normalisePypi(raw.name) : raw.name;
        if (
          !(raw.ecosystem === "npm" ? NPM_NAME : PYPI_NAME).test(name) ||
          !VERSION.test(raw.version)
        ) {
          this.invalid++;
          continue;
        }
        const isDirect =
          raw.ecosystem === "npm"
            ? !!npmDirect && (npmDirect.prod.has(name) || npmDirect.dev.has(name))
            : !!pyDirectSet && (pyDirectSet.has("*") || pyDirectSet.has(name));
        const dev =
          raw.ecosystem === "npm" && npmDirect?.dev.has(name) && !npmDirect.prod.has(name)
            ? true
            : raw.dev === true;
        const key = `${raw.ecosystem} ${name} ${raw.version}`;
        const seen = this.raws.get(key);
        if (seen) {
          seen.direct = seen.direct || isDirect;
          seen.dev = seen.dev === true && dev;
          continue;
        }
        if (this.raws.size >= MAX_DEPENDENCIES) break;
        this.raws.set(key, {
          ecosystem: raw.ecosystem,
          name,
          version: raw.version,
          public: true,
          direct: isDirect,
          dev,
        });
      }
    }
    this.pending.length = 0;
    const dependencies = [...this.raws.values()]
      .map(({ ecosystem, name, version, direct, dev }) => ({
        ecosystem,
        name,
        version,
        direct,
        dev: dev === true,
      }))
      .sort(
        (a, b) =>
          a.ecosystem.localeCompare(b.ecosystem) ||
          a.name.localeCompare(b.name) ||
          a.version.localeCompare(b.version),
      );
    return {
      dependencies,
      files: [...this.files].sort(),
      skippedNonPublic: this.nonPublic,
      skippedInvalid: this.invalid,
    };
  }
}
