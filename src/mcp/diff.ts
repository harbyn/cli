const CONTEXT = 3;
const MAX_LCS_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; text: string };

const lines = (text: string): string[] => (text === "" ? [] : text.split(/(?<=\n)/));

const middleOps = (a: string[], b: string[]): Op[] => {
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text) => ({ kind: "-" as const, text })),
      ...b.map((text) => ({ kind: "+" as const, text })),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
      ops.push({ kind: "-", text: a[i++] as string });
    else ops.push({ kind: "+", text: b[j++] as string });
  }
  while (i < a.length) ops.push({ kind: "-", text: a[i++] as string });
  while (j < b.length) ops.push({ kind: "+", text: b[j++] as string });
  return ops;
};

const opsOf = (before: string, after: string): Op[] => {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...a.slice(0, start).map((text) => ({ kind: " " as const, text })),
    ...middleOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((text) => ({ kind: " " as const, text })),
  ];
};

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: Op[];
}

export const hunks = (before: string, after: string): Hunk[] => {
  const ops = opsOf(before, after);
  const changes = ops.flatMap((o, k) => (o.kind === " " ? [] : [k]));
  const groups: Array<[number, number]> = [];
  for (const k of changes) {
    const last = groups[groups.length - 1];
    if (last && k - last[1] <= 2 * CONTEXT + 1) last[1] = k;
    else groups.push([k, k]);
  }
  return groups.map(([first, lastChange]) => {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length, lastChange + CONTEXT + 1);
    const prior = ops.slice(0, from);
    const slice = ops.slice(from, to);
    const oldLines = slice.filter((o) => o.kind !== "+").length;
    const newLines = slice.filter((o) => o.kind !== "-").length;
    const oldStart = prior.filter((o) => o.kind !== "+").length + (oldLines > 0 ? 1 : 0);
    const newStart = prior.filter((o) => o.kind !== "-").length + (newLines > 0 ? 1 : 0);
    return { oldStart, oldLines, newStart, newLines, ops: slice };
  });
};

const render = (o: Op): string[] => {
  const ended = o.text.endsWith("\n");
  const body = ended ? o.text.slice(0, -1) : o.text;
  return ended ? [`${o.kind}${body}`] : [`${o.kind}${body}`, "\\ No newline at end of file"];
};

export const unifiedDiff = (path: string, before: string, after: string): string => {
  const hs = hunks(before, after);
  if (hs.length === 0) return "";
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const h of hs)
    out.push(
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      ...h.ops.flatMap(render),
    );
  return `${out.join("\n")}\n`;
};

export const changedLines = (path: string, before: string, after: string): string[] =>
  hunks(before, after).flatMap((h) => {
    const shown: string[] = [];
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    for (const o of h.ops) {
      const text = o.text.replace(/\r?\n$/, "");
      if (o.kind === "-") shown.push(`${path}:${oldLine} - ${text}`);
      if (o.kind === "+") shown.push(`${path}:${newLine} + ${text}`);
      if (o.kind !== "+") oldLine++;
      if (o.kind !== "-") newLine++;
    }
    return shown;
  });
