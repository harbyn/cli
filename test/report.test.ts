import { changeEvent } from "../src/schema/index.ts";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/match.ts";
import { toJson, toText } from "../src/report.ts";

const base = {
  schemaVersion: 1,
  vendor: "npm",
  kind: "breaking",
  severity: "high",
  status: "announced",
  summary: "Tokens that bypass 2FA stop publishing directly.",
  announcedAt: "2026-07-08",
  addedAt: "2026-09-23",
  affects: [{ type: "symbol", values: ["NPM_TOKEN"] }],
  sources: [
    {
      url: "https://github.blog/changelog/x",
      kind: "changelog",
      fetchedAt: "2026-09-23T00:00:00Z",
      sha256: "a".repeat(64),
    },
  ],
  review: { state: "human-reviewed", extractedBy: "human" },
};
const monthOnly = changeEvent.parse({
  ...base,
  id: "npm/2026-07-08-month-only",
  title: "Month-only deadline",
  effectiveMonth: "2027-01",
});
const exact = changeEvent.parse({
  ...base,
  id: "npm/2026-07-08-exact-day",
  title: "Exact deadline",
  effectiveAt: "2026-12-01",
});
const undated = changeEvent.parse({ ...base, id: "npm/2026-07-08-undated", title: "No deadline" });

const finding = (event: typeof monthOnly): Finding => ({
  event,
  via: "package",
  token: "NPM_TOKEN",
  path: "ci.yml",
  line: 3,
  context: "code",
});
const result = (events: (typeof monthOnly)[]) => ({
  findings: events.map(finding),
  usage: [],
  stats: {
    scanned: 1,
    skippedSecret: 0,
    skippedIgnored: 0,
    skippedNestedRepos: [],
    truncated: false,
  },
});

describe("month-only deadlines in the report", () => {
  it("counts to the 1st of the month and says the day is not known", () => {
    const text = toText(result([monthOnly]), "2026-09-23");
    expect(text).toContain("in about 100 days (January 2027, no exact day announced)");
    expect(toText(result([monthOnly]), "2027-01-15")).toContain(
      "THIS MONTH (January 2027, no exact day announced)",
    );
    expect(toText(result([monthOnly]), "2027-02-02")).toContain(
      "ALREADY IN EFFECT since January 2027",
    );
  });

  it("orders by deadline with undated events last, and exposes the month in JSON", () => {
    const text = toText(result([undated, monthOnly, exact]), "2026-09-23");
    const order = ["Exact deadline", "Month-only deadline", "No deadline"].map((t) =>
      text.indexOf(t),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(toJson(result([monthOnly])).findings[0]).toMatchObject({
      effectiveAt: null,
      effectiveMonth: "2027-01",
    });
  });
});
