import { type ChangeEvent, changeEvent } from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import {
  levelOf,
  MAX_ANNOTATIONS_PER_LEVEL,
  mdText,
  toAnnotations,
  toStepSummary,
  workflowCommand,
} from "../src/github.ts";
import type { Finding } from "../src/match.ts";
import type { ScanResult } from "../src/report.ts";

const TODAY = "2026-09-24";
const event = (over: Partial<ChangeEvent> = {}): ChangeEvent =>
  changeEvent.parse({
    schemaVersion: 1,
    id: "acme/2026-01-01-acme-1",
    vendor: "acme",
    kind: "retirement",
    status: "announced",
    severity: "high",
    title: "Acme: acme-1 retired",
    summary: "acme-1 stops responding.",
    announcedAt: "2026-01-01",
    addedAt: "2026-01-01",
    effectiveAt: "2026-12-01",
    affects: [{ type: "model-id", values: ["acme-1"] }],
    replacement: { targets: [{ type: "model-id", values: ["acme-2"] }] },
    sources: [
      {
        url: "https://acme.example/changelog",
        kind: "changelog",
        fetchedAt: "2026-01-01T00:00:00Z",
        sha256: "c".repeat(64),
      },
    ],
    review: { state: "automated", extractedBy: "deterministic" },
    ...over,
  });
const unchecked = (over: Partial<ChangeEvent>): ChangeEvent => ({ ...event(), ...over });
const finding = (over: Partial<Finding> = {}): Finding =>
  ({
    event: event(),
    via: "model-id",
    token: "acme-1",
    path: "src/a.ts",
    line: 3,
    context: "code",
    ...over,
  }) as Finding;
const result = (findings: Finding[]): ScanResult => ({
  findings,
  usage: [],
  stats: {
    scanned: 5,
    skippedSecret: 0,
    skippedIgnored: 0,
    skippedNestedRepos: [],
    truncated: false,
  },
});

const commands = (lines: string[]): string[] => lines.join("\n").split("\n");

describe("annotations", () => {
  it("puts the finding on its file and line with the deadline, replacement and source", () => {
    expect(toAnnotations(result([finding()]), TODAY)).toEqual([
      "::warning file=src/a.ts,line=3,title=Acme%3A acme-1 retired::acme-1: in 68 days (2026-12-01). Use instead: acme-2. Source: https://acme.example/changelog",
    ]);
  });

  it("marks changes already in effect as errors", () => {
    expect(levelOf(finding({ event: event({ effectiveAt: "2026-09-01" }) }), TODAY)).toBe("error");
    expect(levelOf(finding({ event: event({ effectiveAt: TODAY }) }), TODAY)).toBe("error");
    expect(levelOf(finding(), TODAY)).toBe("warning");
  });

  it("abuse: a hostile path cannot inject a workflow command", () => {
    const hostile = finding({
      path: "a.ts\n::add-mask::secret\r\n::stop-commands::x,line=1,title=owned:y",
    });
    const lines = commands(toAnnotations(result([hostile]), TODAY));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^::warning file=a\.ts\?%3A%3Aadd-mask%3A%3Asecret\?\?%3A%3Astop-commands%3A%3Ax%2Cline=1%2Ctitle=owned%3Ay,line=3,title=/,
    );
  });

  it("abuse: hostile feed text cannot break out of the message or the title", () => {
    const hostile = finding({
      event: unchecked({ title: "Acme: x\n::error::fake" }),
      token: "acme-1%0A::warning::y",
    });
    const [line] = commands(toAnnotations(result([hostile]), TODAY));
    expect(commands(toAnnotations(result([hostile]), TODAY))).toHaveLength(1);
    expect(line).toContain("title=Acme%3A x?%3A%3Aerror%3A%3Afake");
    expect(line).toContain("::acme-1%250A::warning::y:");
  });

  it("shows at most the per-level cap, most urgent first", () => {
    const many = Array.from({ length: 25 }, (_, i) => finding({ line: i + 1 }));
    const late = finding({ line: 99, event: event({ effectiveAt: "2027-06-01" }) });
    const lines = toAnnotations(result([late, ...many]), TODAY);
    expect(lines).toHaveLength(MAX_ANNOTATIONS_PER_LEVEL);
    expect(lines.some((l) => l.includes("line=99,"))).toBe(false);
  });

  it("does not annotate low-confidence findings (tests, docs)", () => {
    expect(
      toAnnotations(result([finding({ context: "test" as Finding["context"] })]), TODAY),
    ).toEqual([]);
  });

  it("file-less commands escape too", () => {
    expect(workflowCommand("warning", "harbyn", "a\n::error::b")).toBe(
      "::warning title=harbyn::a?::error::b",
    );
  });
});

describe("step summary", () => {
  it("lists every affected line and says nothing was sent", () => {
    const md = toStepSummary(result([finding(), finding({ line: 9 })]), TODAY, "harbyn");
    expect(md).toContain("**2** lines are affected");
    expect(md).toContain("src/a.ts:3");
    expect(md).toContain("[source](https://acme.example/changelog)");
    expect(md).toContain("Nothing about this repository was sent anywhere.");
  });

  it("abuse: hostile paths and titles cannot become markup or break the table", () => {
    const md = toStepSummary(
      result([
        finding({
          path: "<img src=x onerror=alert(1)>|](javascript:x)",
          event: unchecked({ title: "Acme: <script>x</script> | *y*" }),
        }),
      ]),
      TODAY,
      "harbyn",
    );
    expect(md).not.toMatch(/<img|<script|\]\(javascript/);
    const row = md.split("\n").find((l) => l.includes("&#60;img"));
    expect(row?.split("|").length).toBe(7);
  });

  it("links only plain https sources", () => {
    const md = toStepSummary(
      result([
        finding({
          event: event({
            sources: [
              {
                url: "https://acme.example/a)b",
                kind: "changelog",
                fetchedAt: "2026-01-01T00:00:00Z",
                sha256: "c".repeat(64),
              },
            ],
          }),
        }),
      ]),
      TODAY,
      "harbyn",
    );
    expect(md).not.toContain("[source]");
  });

  it("encodes everything outside the safe set", () => {
    expect(mdText("a|b<c>`d`*e*_f_[g]")).toBe(
      "a&#124;b&#60;c&#62;&#96;d&#96;&#42;e&#42;&#95;f&#95;&#91;g&#93;",
    );
  });
});
