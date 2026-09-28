export type Version = readonly [number, number, number];
type Operator = "<" | "<=" | ">" | ">=" | "=";
export interface Comparator {
  op: Operator;
  version: Version;
}
export type Range = Comparator[][];

const VERSION = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+][0-9A-Za-z.+-]{0,64})?$/;
const COMPARATOR = /^(<=|>=|<|>|=)?(\d{1,6}(?:\.\d{1,6}){0,2})$/;

export const parseVersion = (text: string): Version | undefined => {
  const m = VERSION.exec(text.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
};

export const parseRange = (text: string): Range | undefined => {
  if (text.length > 64) return undefined;
  const sets: Range = [];
  for (const part of text.split("||")) {
    const tokens = part
      .replace(/(<=|>=|<|>|=)\s+/g, "$1")
      .trim()
      .split(/\s+/);
    const set: Comparator[] = [];
    for (const token of tokens) {
      const m = COMPARATOR.exec(token);
      const version = m ? parseVersion(m[2] as string) : undefined;
      if (!m || !version) return undefined;
      set.push({ op: (m[1] as Operator | undefined) ?? "=", version });
    }
    if (set.length === 0) return undefined;
    sets.push(set);
  }
  return sets;
};

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const satisfies = (version: Version, range: Range): boolean =>
  range.some((set) =>
    set.every(({ op, version: bound }) => {
      const c = compare(version, bound);
      return op === "<"
        ? c < 0
        : op === "<="
          ? c <= 0
          : op === ">"
            ? c > 0
            : op === ">="
              ? c >= 0
              : c === 0;
    }),
  );

export const declaredFloor = (spec: string): Version | undefined => {
  if (spec.length > 200 || /^(?:workspace:|file:|link:|git|https?:|npm:)/.test(spec.trim()))
    return undefined;
  const m = /(\d{1,6}(?:\.\d{1,6}){0,2})/.exec(spec);
  return m ? parseVersion(m[1] as string) : undefined;
};
