import type { ChangeEvent, FeedIndex } from "./schema/index.ts";
import { configContextOf, type Finding, liveEvents } from "./match.ts";
import type { SourceFile } from "./walk.ts";

type RuntimeKind = "node" | "python" | "lambda";

export interface DeclaredRuntime {
  kind: RuntimeKind;
  value: string;
  line: number;
  engines?: boolean;
}

interface RuntimeSymbol {
  kind: RuntimeKind;
  value: string;
  vercel?: boolean;
}

export const RUNTIME_FILES = new Set([
  "package.json",
  ".nvmrc",
  ".node-version",
  ".python-version",
  "runtime.txt",
  "pyproject.toml",
  "serverless.yml",
  "serverless.yaml",
  "template.yaml",
  "template.yml",
]);

const MAX_LINE = 1000;
const MAX_SPEC = 100;
const MAX_DECLARATIONS = 100;

const NODE_SYMBOL = /^node([1-9][0-9]{0,2})$/;
const VERCEL_SYMBOL = /^(?:node|nodejs)?([1-9][0-9]{0,2})\.x$|^(?:node|nodejs)([1-9][0-9]{0,2})$/;
const PYTHON_SYMBOL = /^python([23])\.(0|[1-9][0-9]?)$/;
const LAMBDA_RUNTIME =
  /^(?:nodejs[1-9][0-9]?\.x|python[23]\.(?:0|[1-9][0-9]?)|ruby[1-9]\.(?:0|[1-9][0-9]?)|java[1-9][0-9]?(?:\.al2|\.al2023)?|dotnet(?:core)?[1-9][0-9]?(?:\.[0-9])?|go1\.x|provided(?:\.al2|\.al2023)?)$/;

const SYMBOL_GRAMMARS: Record<string, (symbol: string) => RuntimeSymbol | undefined> = {
  nodejs: (s) => {
    const m = NODE_SYMBOL.exec(s);
    return m ? { kind: "node", value: m[1] as string } : undefined;
  },
  python: (s) => {
    const m = PYTHON_SYMBOL.exec(s);
    return m ? { kind: "python", value: `${m[1]}.${m[2]}` } : undefined;
  },
  "aws-lambda": (s) => (LAMBDA_RUNTIME.test(s) ? { kind: "lambda", value: s } : undefined),
  vercel: (s) => {
    const m = VERCEL_SYMBOL.exec(s);
    return m ? { kind: "node", value: (m[1] ?? m[2]) as string, vercel: true } : undefined;
  },
};

export const runtimeSymbol = (vendor: string, symbol: string): RuntimeSymbol | undefined =>
  Object.hasOwn(SYMBOL_GRAMMARS, vendor) && symbol.length <= 32
    ? SYMBOL_GRAMMARS[vendor]?.(symbol)
    : undefined;

const NODE_COMPARATOR =
  /^(>=|<=|>|<|=|\^|~>|~)?v?([0-9]{1,3}|[xX*])(?:\.([0-9]{1,6}|[xX*]))?(?:\.([0-9]{1,6}|[xX*]))?(?:-[0-9A-Za-z.]{1,32})?$/;

export const nodeFloor = (spec: string): number | undefined => {
  if (spec.length > MAX_SPEC) return undefined;
  const alternatives = spec.split("||");
  if (alternatives.length > 8) return undefined;
  let floor: number | undefined;
  for (const alternative of alternatives) {
    const tokens = alternative
      .replace(/(>=|<=|>|<|=|\^|~>|~) +/g, "$1")
      .trim()
      .split(/ +/);
    let lower: number | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string;
      if (token === "-") {
        i++;
        continue;
      }
      const m = NODE_COMPARATOR.exec(token);
      if (!m) return undefined;
      const op = m[1] ?? "";
      if (op === "<" || op === "<=" || !/^[0-9]/.test(m[2] as string)) continue;
      const major = Number(m[2]) + (op === ">" && m[3] === undefined ? 1 : 0);
      lower = lower === undefined ? major : Math.max(lower, major);
    }
    if (lower === undefined) return undefined;
    floor = floor === undefined ? lower : Math.min(floor, lower);
  }
  return floor;
};

const PYTHON_SPEC =
  /^(===|==|~=|>=|<=|!=|>|<) *([0-9])(?:\.([0-9]{1,2}))?(?:\.[0-9*]{1,6})?(?:\.[0-9*]{1,6})?$/;

export const pythonFloor = (spec: string): string | undefined => {
  if (spec.length > MAX_SPEC) return undefined;
  const parts = spec.split(",");
  if (parts.length > 8) return undefined;
  let lower: [number, number] | undefined;
  for (const part of parts) {
    const m = PYTHON_SPEC.exec(part.trim());
    if (!m) return undefined;
    if (m[1] === "<" || m[1] === "<=" || m[1] === "!=") continue;
    const version: [number, number] = [Number(m[2]), Number(m[3] ?? 0)];
    if (!lower || version[0] > lower[0] || (version[0] === lower[0] && version[1] > lower[1]))
      lower = version;
  }
  return lower ? `${lower[0]}.${lower[1]}` : undefined;
};

const NODE_VERSION_FILE = /^v?([1-9][0-9]{0,2})(?:\.[0-9]{1,6})?(?:\.[0-9]{1,6})?$/;
const PYTHON_VERSION = /^([23])\.([0-9]{1,2})(?:\.[0-9]{1,4})?$/;
const HEROKU_PYTHON = /^python-([23])\.([0-9]{1,2})(?:\.[0-9]{1,4})?$/;
const TOML_SECTION = /^ *\[([A-Za-z0-9_.-]{1,64})\] *(?:#.*)?$/;
const REQUIRES_PYTHON = /^ *requires-python *= *["']([^"']{1,100})["'] *(?:#.*)?$/;
const SERVERLESS_RUNTIME = /^ *runtime: *["']?([A-Za-z0-9.]{1,40})["']? *(?:#.*)?$/;
const SAM_RUNTIME = /^ *Runtime: *["']?([A-Za-z0-9.]{1,40})["']? *(?:#.*)?$/;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const linesOf = (text: string): string[] =>
  withoutBom(text)
    .split("\n")
    .map((l) => (l.length > MAX_LINE ? "" : l.replace(/\r$/, "").replaceAll("\t", " ")));

const firstValue = (lines: string[]): { text: string; line: number } | undefined => {
  for (let i = 0; i < lines.length; i++) {
    const text = (lines[i] as string).trim();
    if (text !== "" && !text.startsWith("#")) return { text, line: i + 1 };
  }
  return undefined;
};

const fromPackageJson = (text: string, lines: string[]): DeclaredRuntime[] => {
  let json: unknown;
  try {
    json = JSON.parse(withoutBom(text));
  } catch {
    return [];
  }
  const engines =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>).engines
      : undefined;
  const spec =
    typeof engines === "object" && engines !== null
      ? (engines as Record<string, unknown>).node
      : undefined;
  if (typeof spec !== "string") return [];
  const major = nodeFloor(spec);
  if (major === undefined) return [];
  const enginesAt = lines.findIndex((l) => l.includes('"engines"'));
  const nodeAt =
    enginesAt === -1 ? -1 : lines.findIndex((l, i) => i >= enginesAt && /"node" *:/.test(l));
  return [
    {
      kind: "node",
      value: String(major),
      line: (nodeAt === -1 ? enginesAt : nodeAt) + 1 || 1,
      engines: true,
    },
  ];
};

export const declaredRuntimes = (path: string, text: string): DeclaredRuntime[] => {
  const name = basename(path);
  if (!RUNTIME_FILES.has(name)) return [];
  const lines = linesOf(text);
  const out: DeclaredRuntime[] = [];
  switch (name) {
    case "package.json":
      return fromPackageJson(text, lines);
    case ".nvmrc":
    case ".node-version": {
      const first = firstValue(lines);
      const m = first ? NODE_VERSION_FILE.exec(first.text) : null;
      if (first && m) out.push({ kind: "node", value: m[1] as string, line: first.line });
      break;
    }
    case ".python-version":
      lines.forEach((raw, i) => {
        const m = PYTHON_VERSION.exec(raw.trim());
        if (m) out.push({ kind: "python", value: `${Number(m[1])}.${Number(m[2])}`, line: i + 1 });
      });
      break;
    case "runtime.txt": {
      const first = firstValue(lines);
      const m = first ? HEROKU_PYTHON.exec(first.text) : null;
      if (first && m)
        out.push({ kind: "python", value: `${Number(m[1])}.${Number(m[2])}`, line: first.line });
      break;
    }
    case "pyproject.toml": {
      let section = "";
      lines.forEach((raw, i) => {
        if (raw.trimStart().startsWith("[")) {
          section = TOML_SECTION.exec(raw)?.[1] ?? "";
          return;
        }
        const m = section === "project" ? REQUIRES_PYTHON.exec(raw) : null;
        const floor = m ? pythonFloor(m[1] as string) : undefined;
        if (floor) out.push({ kind: "python", value: floor, line: i + 1 });
      });
      break;
    }
    case "serverless.yml":
    case "serverless.yaml":
    case "template.yaml":
    case "template.yml": {
      const sam = name.startsWith("template.");
      if (sam && !text.includes("AWS::")) break;
      lines.forEach((raw, i) => {
        const m = (sam ? SAM_RUNTIME : SERVERLESS_RUNTIME).exec(raw);
        if (m && LAMBDA_RUNTIME.test(m[1] as string))
          out.push({ kind: "lambda", value: m[1] as string, line: i + 1 });
      });
      break;
    }
  }
  return out.slice(0, MAX_DECLARATIONS);
};

interface RuntimeNeedle {
  event: ChangeEvent;
  symbol: string;
  vercel: boolean;
}

export class RuntimeMatcher {
  private readonly needles = new Map<string, RuntimeNeedle[]>();
  private readonly declared: Array<{ path: string; runtime: DeclaredRuntime }> = [];
  private readonly vercelDirs = new Set<string>();

  constructor(feed: FeedIndex) {
    for (const event of liveEvents(feed)) {
      if (event.kind === "feature" || event.kind === "notice") continue;
      for (const target of event.affects) {
        if (target.type !== "symbol") continue;
        for (const symbol of target.values) {
          const runtime = runtimeSymbol(event.vendor, symbol);
          if (!runtime) continue;
          const key = `${runtime.kind}|${runtime.value}`;
          this.needles.set(key, [
            ...(this.needles.get(key) ?? []),
            { event, symbol, vercel: runtime.vercel === true },
          ]);
        }
      }
    }
  }

  scanFile(file: SourceFile): void {
    const name = basename(file.path);
    if (name === "vercel.json") this.vercelDirs.add(dirname(file.path));
    if (this.needles.size === 0 || !RUNTIME_FILES.has(name)) return;
    for (const runtime of declaredRuntimes(file.path, file.text))
      this.declared.push({ path: file.path, runtime });
  }

  findings(): Finding[] {
    const out: Finding[] = [];
    const seen = new Set<string>();
    for (const { path, runtime } of this.declared) {
      for (const needle of this.needles.get(`${runtime.kind}|${runtime.value}`) ?? []) {
        if (
          needle.vercel &&
          !(runtime.engines && (this.vercelDirs.has(dirname(path)) || this.vercelDirs.has("")))
        )
          continue;
        const key = `${path}|${needle.event.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          event: needle.event,
          via: "runtime",
          token: needle.symbol,
          path,
          line: runtime.line,
          context: configContextOf(path),
        });
      }
    }
    return out;
  }
}
