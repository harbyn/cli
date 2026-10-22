import type { ChangeEvent, FeedIndex } from "./schema/index.ts";
import { configContextOf, type Finding, liveEvents } from "./match.ts";
import type { SourceFile } from "./walk.ts";

export type PhpPin = "exact" | "floating" | "range";

export interface PhpDeclaration {
  version: string;
  pin: PhpPin;
  line: number;
  shown: string;
  span?: [number, number];
  digest?: boolean;
}

export interface PhpFinding {
  declared: string;
  pin: PhpPin;
  branch: string;
  fixed?: string;
  oldestFixed?: string;
  span?: [number, number];
  digest?: boolean;
}

const MAX_LINE = 1000;
const MAX_SPEC = 100;
const MAX_DECLARATIONS = 100;

const VERSION = /^([5-9])\.(0|[1-9][0-9]?)(?:\.(0|[1-9][0-9]{0,2}))?$/;
const TAG = /^([5-9])\.(0|[1-9][0-9]?)(?:\.(0|[1-9][0-9]{0,2}))?(?:-[a-z0-9][a-z0-9.-]{0,63})?$/;
const FROM =
  /^ *FROM +(?:--platform=[^ ]{1,64} +)?(?:docker\.io\/)?(?:library\/)?php:([A-Za-z0-9._${}-]{1,128})(@sha256:[0-9a-f]{64})?(?: +AS +[A-Za-z0-9._-]{1,64})? *(?:#.*)?$/di;
const ARG = /^ *ARG +PHP_VERSION=["']?([0-9.]{1,12})["']? *(?:#.*)?$/di;
const IMAGE =
  /^ *-? *image: *["']?(?:docker\.io\/)?(?:library\/)?php:([A-Za-z0-9._-]{1,128})(@sha256:[0-9a-f]{64})?["']? *(?:#.*)?$/d;
const TOOL_VERSIONS = /^ *php +([0-9.]{1,12})(?: +[^ ].{0,200})? *(?:#.*)?$/d;
const COMPOSER_VALUE = /^ *"php" *: *"([^"]{1,100})" *,? *$/d;
const WORKFLOW_KEY = /^ *-? *(?:php|php-version|php-versions): *(.{0,400})$/d;
const LIST_ITEM = /^ *- *["']?([0-9.]{1,12})["']? *(?:#.*)?$/d;
const SCALAR = /^["']?([0-9.]{1,12})["']? *(?:#.*)?$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]{1,100}\.ya?ml$/;
const DOCKERFILE =
  /^(?:Dockerfile|Containerfile)(?:\.[A-Za-z0-9_-]{1,40})?$|^[A-Za-z0-9_-]{1,40}\.[Dd]ockerfile$/;
const COMPOSE = /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]{1,40})?\.ya?ml$/;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const linesOf = (text: string): string[] =>
  withoutBom(text)
    .split("\n")
    .map((l) => (l.length > MAX_LINE ? "" : l.replace(/\r$/, "")));

type Kind = "dockerfile" | "compose" | "php-version" | "tool-versions" | "composer" | "workflow";

const kindOf = (path: string, text: string): Kind | undefined => {
  const name = basename(path);
  if (DOCKERFILE.test(name)) return "dockerfile";
  if (COMPOSE.test(name)) return "compose";
  if (name === ".php-version") return "php-version";
  if (name === ".tool-versions") return "tool-versions";
  if (name === "composer.json") return "composer";
  if (WORKFLOW_PATH.test(path) && text.includes("shivammathur/setup-php")) return "workflow";
  return undefined;
};

export const isPhpFile = (path: string): boolean => {
  const name = basename(path);
  return (
    DOCKERFILE.test(name) ||
    COMPOSE.test(name) ||
    name === ".php-version" ||
    name === ".tool-versions" ||
    name === "composer.json" ||
    WORKFLOW_PATH.test(path)
  );
};

const parts = (version: string): [number, number, number | undefined] | undefined => {
  const m = VERSION.exec(version);
  return m
    ? [Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3])]
    : undefined;
};

const pinOf = (version: string): PhpPin | undefined => {
  const p = parts(version);
  return p ? (p[2] === undefined ? "floating" : "exact") : undefined;
};

const COMPOSER_COMPARATOR =
  /^(>=|<=|>|<|=|==|!=|\^|~)?v?([0-9]{1,2})(?:\.([0-9]{1,3}|\*))?(?:\.([0-9]{1,3}|\*))?(?:@[a-z]{1,10})?$/;

export const phpFloor = (spec: string): string | undefined => {
  if (spec.length > MAX_SPEC) return undefined;
  const alternatives = spec.split(/\|\|?/);
  if (alternatives.length > 8) return undefined;
  let floor: [number, number, number] | undefined;
  const less = (a: [number, number, number], b: [number, number, number]) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  for (const alternative of alternatives) {
    const tokens = alternative
      .replace(/(>=|<=|>|<|==|=|!=|\^|~) +/g, "$1")
      .trim()
      .split(/[ ,]+/);
    let lower: [number, number, number] | undefined;
    for (const token of tokens) {
      if (token === "" || token === "-") continue;
      const m = COMPOSER_COMPARATOR.exec(token);
      if (!m) return undefined;
      const op = m[1] ?? "";
      if (op === "<" || op === "<=" || op === "!=") continue;
      const version: [number, number, number] = [
        Number(m[2]),
        m[3] === undefined || m[3] === "*" ? 0 : Number(m[3]),
        m[4] === undefined || m[4] === "*" ? 0 : Number(m[4]),
      ];
      if (!lower || less(version, lower) > 0) lower = version;
    }
    if (!lower) return undefined;
    if (!floor || less(lower, floor) < 0) floor = lower;
  }
  if (!floor || floor[0] < 5 || floor[0] > 9) return undefined;
  return floor.join(".");
};

const exactSpan = (
  m: RegExpExecArray,
  group: number,
  version: string,
): [number, number] | undefined => {
  const at = m.indices?.[group];
  if (!at || pinOf(version) !== "exact") return undefined;
  return [at[0], at[0] + version.length];
};

const fromTag = (
  tag: string,
  digest: boolean,
  m: RegExpExecArray,
  line: number,
  shown: string,
): PhpDeclaration | undefined => {
  if (!TAG.test(tag)) return undefined;
  const version = tag.split("-")[0] as string;
  const pin = pinOf(version);
  if (!pin) return undefined;
  const span = exactSpan(m, 1, version);
  return {
    version,
    pin,
    line,
    shown,
    ...(span ? { span } : {}),
    ...(digest ? { digest: true } : {}),
  };
};

const fromComposer = (text: string, lines: string[]): PhpDeclaration[] => {
  let json: unknown;
  try {
    json = JSON.parse(withoutBom(text));
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];
  const record = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  const out: PhpDeclaration[] = [];
  const lineAfter = (key: string): number => {
    const at = lines.findIndex((l) => l.includes(`"${key}"`));
    if (at === -1) return -1;
    return lines.findIndex((l, i) => i >= at && /^ *"php" *:/.test(l));
  };
  const require = record((json as Record<string, unknown>).require)?.php;
  if (typeof require === "string") {
    const floor = phpFloor(require);
    const at = lineAfter("require");
    if (floor)
      out.push({ version: floor, pin: "range", line: at + 1 || 1, shown: require.slice(0, 40) });
  }
  const platform = record(record((json as Record<string, unknown>).config)?.platform)?.php;
  if (typeof platform === "string" && pinOf(platform) === "exact") {
    const at = lineAfter("platform");
    const m = at === -1 ? null : COMPOSER_VALUE.exec(lines[at] as string);
    const span = m && m[1] === platform ? exactSpan(m, 1, platform) : undefined;
    out.push({
      version: platform,
      pin: "exact",
      line: at + 1 || 1,
      shown: platform,
      ...(span ? { span } : {}),
    });
  }
  return out;
};

const fromWorkflow = (lines: string[]): PhpDeclaration[] => {
  const out: PhpDeclaration[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_DECLARATIONS; i++) {
    const m = WORKFLOW_KEY.exec(lines[i] as string);
    if (!m) continue;
    const value = (m[1] as string).trim();
    const valueAt = m.indices?.[1]?.[0] ?? 0;
    if (value === "" || value.startsWith("#")) {
      const indent = (lines[i] as string).search(/[^ ]/);
      for (let j = i + 1; j < lines.length && out.length < MAX_DECLARATIONS; j++) {
        const raw = lines[j] as string;
        if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
        const item = raw.search(/[^ ]/) >= indent ? LIST_ITEM.exec(raw) : null;
        if (!item) break;
        const version = item[1] as string;
        const pin = pinOf(version);
        const span = exactSpan(item, 1, version);
        if (pin) out.push({ version, pin, line: j + 1, shown: version, ...(span ? { span } : {}) });
      }
      continue;
    }
    if (value.startsWith("[")) {
      const close = value.indexOf("]");
      if (close === -1) continue;
      let offset = valueAt + 1;
      for (const raw of value.slice(1, close).split(",")) {
        const lead = raw.length - raw.trimStart().length;
        const literal = raw.trim();
        const quoted = /^(["'])([0-9.]{1,12})\1$/.exec(literal);
        const version = quoted ? (quoted[2] as string) : literal;
        const pin = pinOf(version);
        if (pin) {
          const start = offset + lead + (quoted ? 1 : 0);
          out.push({
            version,
            pin,
            line: i + 1,
            shown: version,
            ...(pin === "exact"
              ? { span: [start, start + version.length] as [number, number] }
              : {}),
          });
        }
        offset += raw.length + 1;
      }
      continue;
    }
    const scalar = SCALAR.exec(value);
    if (!scalar) continue;
    const version = scalar[1] as string;
    const pin = pinOf(version);
    if (!pin) continue;
    const start = valueAt + (value.startsWith('"') || value.startsWith("'") ? 1 : 0);
    out.push({
      version,
      pin,
      line: i + 1,
      shown: version,
      ...(pin === "exact" ? { span: [start, start + version.length] as [number, number] } : {}),
    });
  }
  return out;
};

export const declaredPhp = (path: string, text: string): PhpDeclaration[] => {
  const kind = kindOf(path, text);
  if (!kind) return [];
  const lines = linesOf(text);
  const out: PhpDeclaration[] = [];
  switch (kind) {
    case "dockerfile": {
      const usesArg = /php:\$\{?PHP_VERSION\b/.test(text);
      lines.forEach((raw, i) => {
        const from = FROM.exec(raw);
        if (from) {
          const d = fromTag(
            from[1] as string,
            from[2] !== undefined,
            from,
            i + 1,
            `php:${from[1]}`,
          );
          if (d) out.push(d);
          return;
        }
        const arg = usesArg ? ARG.exec(raw) : null;
        const version = arg?.[1] as string | undefined;
        const pin = version ? pinOf(version) : undefined;
        if (arg && version && pin) {
          const span = exactSpan(arg, 1, version);
          out.push({
            version,
            pin,
            line: i + 1,
            shown: `PHP_VERSION=${version}`,
            ...(span ? { span } : {}),
          });
        }
      });
      break;
    }
    case "compose":
      lines.forEach((raw, i) => {
        const m = IMAGE.exec(raw);
        const d = m
          ? fromTag(m[1] as string, m[2] !== undefined, m, i + 1, `php:${m[1]}`)
          : undefined;
        if (d) out.push(d);
      });
      break;
    case "php-version": {
      const i = lines.findIndex((l) => l.trim() !== "" && !l.trim().startsWith("#"));
      const raw = i === -1 ? "" : (lines[i] as string);
      const m = /^ *([0-9.]{1,12}) *$/d.exec(raw);
      const version = m?.[1];
      const pin = version ? pinOf(version) : undefined;
      if (m && version && pin) {
        const span = exactSpan(m, 1, version);
        out.push({ version, pin, line: i + 1, shown: version, ...(span ? { span } : {}) });
      }
      break;
    }
    case "tool-versions":
      lines.forEach((raw, i) => {
        const m = TOOL_VERSIONS.exec(raw);
        const version = m?.[1];
        const pin = version ? pinOf(version) : undefined;
        if (m && version && pin) {
          const span = exactSpan(m, 1, version);
          out.push({ version, pin, line: i + 1, shown: version, ...(span ? { span } : {}) });
        }
      });
      break;
    case "composer":
      return fromComposer(text, lines);
    case "workflow":
      return fromWorkflow(lines);
  }
  return out.slice(0, MAX_DECLARATIONS);
};

const BRANCH = /^php([5-9])\.(0|[1-9][0-9]?)$/;
const RELEASE = /^php([5-9])\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]{0,2})$/;

interface PhpNeedle {
  event: ChangeEvent;
  branches: Set<string>;
  fixed: Map<string, number>;
  oldestFixed?: string;
}

export const phpNeedle = (event: ChangeEvent): PhpNeedle | undefined => {
  if (event.vendor !== "php") return undefined;
  const branches = new Set(
    event.affects
      .flatMap((t) => (t.type === "symbol" ? t.values : []))
      .flatMap((s) => {
        const m = BRANCH.exec(s);
        return m ? [`${m[1]}.${m[2]}`] : [];
      }),
  );
  if (branches.size === 0) return undefined;
  const fixed = new Map<string, number>();
  let oldest: [number, number, number] | undefined;
  for (const s of (event.replacement?.targets ?? []).flatMap((t) =>
    t.type === "symbol" ? t.values : [],
  )) {
    const m = RELEASE.exec(s);
    if (!m) continue;
    const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    fixed.set(`${v[0]}.${v[1]}`, v[2]);
    if (!oldest || v[0] - oldest[0] < 0 || (v[0] === oldest[0] && v[1] < oldest[1])) oldest = v;
  }
  return { event, branches, fixed, ...(oldest ? { oldestFixed: oldest.join(".") } : {}) };
};

export const phpVerdict = (
  needle: PhpNeedle,
  d: Pick<PhpDeclaration, "version" | "pin" | "span" | "digest">,
): PhpFinding | undefined => {
  const p = parts(d.version);
  if (!p) return undefined;
  const branch = `${p[0]}.${p[1]}`;
  if (!needle.branches.has(branch)) return undefined;
  const fixed = needle.fixed.get(branch);
  if (fixed !== undefined && d.pin !== "floating" && (p[2] ?? 0) >= fixed) return undefined;
  return {
    declared: d.version,
    pin: d.pin,
    branch,
    ...(fixed !== undefined ? { fixed: `${branch}.${fixed}` } : {}),
    ...(needle.oldestFixed ? { oldestFixed: needle.oldestFixed } : {}),
    ...(d.span ? { span: d.span } : {}),
    ...(d.digest ? { digest: true } : {}),
  };
};

export const phpNextStep = (php: PhpFinding): { label: string; text: string } => {
  const moveOn = `PHP ${php.branch} gets no fixed release: move to a supported branch${php.oldestFixed ? ` (PHP ${php.oldestFixed} or later)` : ""}`;
  if (php.pin === "range") {
    return {
      label: "What to do",
      text: `this constraint allows PHP ${php.declared}, which is affected. Composer does not choose the PHP that runs: make sure every server and image runs ${php.fixed ? `${php.fixed} or later` : "a fixed release"}`,
    };
  }
  if (!php.fixed) return { label: "What to do", text: moveOn };
  if (php.pin === "floating") {
    return {
      label: "What to do",
      text: `this follows the newest PHP ${php.branch} patch: rebuild or re-pull, then check that the running PHP reports ${php.fixed} or later (php -v)`,
    };
  }
  return {
    label: "Upgrade to",
    text: `PHP ${php.fixed} (same ${php.branch} branch)${php.digest ? "; the image is also pinned by digest: update the digest too" : ""}`,
  };
};

export const phpShortStep = (php: PhpFinding): string => {
  if (php.pin === "range") return "constraint only: check the PHP that runs";
  if (!php.fixed)
    return `no fix for ${php.branch}: move to ${php.oldestFixed ?? "a supported branch"}+`;
  if (php.pin === "floating") return `floating: rebuild, check ${php.fixed}+`;
  return `upgrade to ${php.fixed}${php.digest ? " (and the digest)" : ""}`;
};

export class PhpMatcher {
  private readonly needles: PhpNeedle[] = [];
  private readonly out: Finding[] = [];
  private readonly seen = new Set<string>();

  constructor(feed: FeedIndex) {
    for (const event of liveEvents(feed)) {
      if (event.kind === "feature" || event.kind === "notice") continue;
      const needle = phpNeedle(event);
      if (needle) this.needles.push(needle);
    }
  }

  scanFile(file: SourceFile): void {
    if (this.needles.length === 0 || !isPhpFile(file.path)) return;
    for (const d of declaredPhp(file.path, file.text)) {
      for (const needle of this.needles) {
        const php = phpVerdict(needle, d);
        if (!php) continue;
        const key = `${file.path}|${d.line}|${d.span?.[0] ?? d.shown}|${needle.event.id}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.out.push({
          event: needle.event,
          via: "runtime",
          token:
            d.pin === "range"
              ? `php ${d.shown}`
              : d.shown.startsWith("php:")
                ? d.shown
                : `php ${d.shown}`,
          path: file.path,
          line: d.line,
          context: configContextOf(file.path),
          php,
        });
      }
    }
  }

  findings(): Finding[] {
    return this.out;
  }
}
