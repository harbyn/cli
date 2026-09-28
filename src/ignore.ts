const MAX_PATTERNS = 2000;
const MAX_PATTERN_LENGTH = 256;

interface Rule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  segments: string[];
  base: string;
}

export const matchSegment = (pattern: string, text: string): boolean => {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const pc = pattern[p];
    let matched = false;
    let advance = 1;
    if (pc === "*") {
      starP = p++;
      starT = t;
      continue;
    }
    if (pc === "?") matched = true;
    else if (pc === "[") {
      const close = pattern.indexOf("]", p + 2);
      if (close === -1) matched = text[t] === "[";
      else {
        let body = pattern.slice(p + 1, close);
        const negate = body[0] === "!" || body[0] === "^";
        if (negate) body = body.slice(1);
        let inClass = false;
        for (let i = 0; i < body.length; i++) {
          const lo = body[i] as string;
          if (body[i + 1] === "-" && i + 2 < body.length) {
            const hi = body[i + 2] as string;
            if ((text[t] as string) >= lo && (text[t] as string) <= hi) inClass = true;
            i += 2;
          } else if (text[t] === lo) inClass = true;
        }
        matched = inClass !== negate;
        advance = close - p + 1;
      }
    } else if (pc === "\\" && p + 1 < pattern.length) {
      matched = pattern[p + 1] === text[t];
      advance = 2;
    } else matched = pc === text[t];

    if (matched) {
      p += advance;
      t++;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
};

const matchSegments = (pattern: string[], path: string[]): boolean => {
  const memo = new Map<number, boolean>();
  const go = (pi: number, ti: number): boolean => {
    const key = pi * (path.length + 1) + ti;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (pi === pattern.length) result = ti === path.length;
    else if (pattern[pi] === "**") result = go(pi + 1, ti) || (ti < path.length && go(pi, ti + 1));
    else
      result =
        ti < path.length &&
        matchSegment(pattern[pi] as string, path[ti] as string) &&
        go(pi + 1, ti + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
};

export class IgnoreRules {
  private readonly rules: Rule[] = [];

  add(content: string, base: string): void {
    for (const raw of content.split("\n")) {
      if (this.rules.length >= MAX_PATTERNS) return;
      let line = raw.replace(/\r$/, "");
      if (line.length > MAX_PATTERN_LENGTH) continue;
      if (!line.endsWith("\\ ")) line = line.trimEnd();
      if (line === "" || line.startsWith("#")) continue;
      const negated = line.startsWith("!");
      if (negated) line = line.slice(1);
      const dirOnly = line.endsWith("/");
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.includes("/");
      if (line.startsWith("/")) line = line.slice(1);
      const segments = line.split("/").filter((s) => s !== "");
      if (segments.length === 0) continue;
      this.rules.push({ negated, dirOnly, anchored, segments, base });
    }
  }

  ignores(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.base !== "" && !path.startsWith(`${rule.base}/`)) continue;
      const relative = (rule.base === "" ? path : path.slice(rule.base.length + 1)).split("/");
      const hit = rule.anchored
        ? matchSegments(rule.segments, relative)
        : matchSegments(["**", ...rule.segments], relative);
      if (hit) ignored = !rule.negated;
    }
    return ignored;
  }
}
