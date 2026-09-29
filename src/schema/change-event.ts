import { z } from "zod";
import {
  displayText,
  hostOf,
  httpsUrl,
  isoDate,
  isoDateTime,
  isWithinDomain,
  literalToken,
  sha256,
  slug,
} from "./primitives.ts";
import { parseRange } from "./semver.ts";
import { ecosystem, type Vendor } from "./vendor.ts";

export const changeKind = z.enum([
  "breaking",
  "deprecation",
  "retirement",
  "pricing",
  "behavior",
  "rate-limit",
  "security",
  "policy",
  "feature",
  "notice",
]);

export const severity = z.enum(["critical", "high", "medium", "low", "info"]);

const identifier = literalToken.refine(
  (t) => !/:\/\/|\/\/|\.\.|^\/|\/$/.test(t),
  "must not look like a URL or a path",
);

export const target = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("model-id"), values: z.array(identifier).min(1).max(64) }),
  z.strictObject({
    type: z.literal("api-version"),
    header: literalToken.optional(),
    values: z.array(identifier).min(1).max(64),
  }),
  z.strictObject({
    type: z.literal("endpoint"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"]),
    path: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\/[A-Za-z0-9._~\-/{}:]*$/, "must be a plain URL path template"),
  }),
  z.strictObject({
    type: z.literal("package"),
    ecosystem,
    name: literalToken,
    range: z
      .string()
      .min(1)
      .max(64)
      .refine((r) => parseRange(r) !== undefined, "must be a range the scanner can evaluate"),
  }),
  z.strictObject({ type: z.literal("symbol"), values: z.array(literalToken).min(1).max(64) }),
]);

export const source = z.strictObject({
  url: httpsUrl,
  kind: z.enum([
    "changelog",
    "deprecations",
    "docs",
    "spec",
    "release",
    "blog",
    "pricing",
    "email",
  ]),
  fetchedAt: isoDateTime,
  sha256,
});

export const pricePoint = z.strictObject({
  item: literalToken,
  unit: z.enum([
    "per-1m-input-tokens",
    "per-1m-output-tokens",
    "per-request",
    "per-unit",
    "per-month",
  ]),
  currency: z.enum(["USD", "BRL", "EUR"]),
  before: z.number().nonnegative().finite().nullable(),
  after: z.number().nonnegative().finite().nullable(),
});

export const changeEvent = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .max(160)
      .regex(/^[a-z0-9-]+\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/),
    vendor: slug,
    product: slug.optional(),
    kind: changeKind,
    severity,
    status: z.enum(["announced", "in-effect", "cancelled", "retracted"]),
    title: displayText(140),
    summary: displayText(600),
    announcedAt: isoDate,
    announcedAtBasis: z.enum(["vendor", "first-seen", "first-crawl"]).default("vendor"),
    addedAt: isoDate,
    effectiveAt: isoDate.optional(),
    effectiveMonth: z
      .string()
      .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "must be YYYY-MM")
      .optional(),
    affects: z.array(target).max(32).default([]),
    replacement: z
      .strictObject({
        note: displayText(300).optional(),
        targets: z.array(target).max(16).default([]),
      })
      .optional(),
    pricing: z.array(pricePoint).max(64).optional(),
    sources: z.array(source).min(1).max(8),
    link: httpsUrl.optional(),
    review: z.strictObject({
      state: z.enum(["automated", "human-reviewed"]),
      extractedBy: z.enum(["deterministic", "llm", "human"]),
    }),
    supersedes: z.string().max(160).optional(),
    retractionReason: displayText(300).optional(),
  })
  .superRefine((e, ctx) => {
    if (!e.id.startsWith(`${e.vendor}/`)) {
      ctx.addIssue({
        code: "custom",
        path: ["id"],
        message: "id must be prefixed by the vendor slug",
      });
    }
    if (e.id.split("/")[1]?.slice(0, 10) !== e.announcedAt) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "date in id must equal announcedAt" });
    }
    if (e.effectiveAt && e.effectiveAt < e.announcedAt && e.status === "announced") {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "effectiveAt is in the past of announcedAt; status cannot be 'announced'",
      });
    }
    if (e.effectiveAt && e.effectiveMonth) {
      ctx.addIssue({
        code: "custom",
        path: ["effectiveMonth"],
        message: "use effectiveAt or effectiveMonth, not both",
      });
    }
    if (
      e.effectiveMonth &&
      e.effectiveMonth < e.announcedAt.slice(0, 7) &&
      e.status === "announced"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "effectiveMonth is before announcedAt; status cannot be 'announced'",
      });
    }
    if (e.addedAt < e.announcedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["addedAt"],
        message: "addedAt cannot be before announcedAt",
      });
    }
    if (e.kind === "pricing" && !e.pricing?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["pricing"],
        message: "pricing events need at least one price point",
      });
    }
    if (e.kind === "notice" && e.severity !== "info" && e.severity !== "low") {
      ctx.addIssue({
        code: "custom",
        path: ["severity"],
        message: "unclassified notices cannot claim more than low severity",
      });
    }
    if (e.status === "retracted" && !e.retractionReason) {
      ctx.addIssue({
        code: "custom",
        path: ["retractionReason"],
        message: "retracted events must say why",
      });
    }
    const highImpact =
      e.severity === "critical" ||
      e.severity === "high" ||
      e.kind === "security" ||
      e.kind === "breaking" ||
      e.kind === "retirement";
    if (highImpact && e.review.extractedBy === "llm" && e.review.state !== "human-reviewed") {
      ctx.addIssue({
        code: "custom",
        path: ["review"],
        message: "high-impact LLM-extracted events require human review",
      });
    }
  });

export type ChangeEvent = z.infer<typeof changeEvent>;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

type Dated = Pick<ChangeEvent, "effectiveAt" | "effectiveMonth">;

export const deadlineOf = (e: Dated): { date: string; precision: "day" | "month" } | undefined => {
  if (e.effectiveAt) return { date: e.effectiveAt, precision: "day" };
  if (e.effectiveMonth) return { date: `${e.effectiveMonth}-01`, precision: "month" };
  return undefined;
};

export const leadTimeDays = (e: Pick<ChangeEvent, "addedAt"> & Dated): number | undefined => {
  const d = deadlineOf(e);
  return d === undefined ? undefined : daysBetween(e.addedAt, d.date);
};

export const isBackfill = (e: Pick<ChangeEvent, "addedAt"> & Dated): boolean =>
  (leadTimeDays(e) ?? 0) < 0;

const deadlineOpen = (e: Dated, today: string): boolean => {
  if (e.effectiveAt) return e.effectiveAt >= today;
  if (e.effectiveMonth) return e.effectiveMonth >= today.slice(0, 7);
  return true;
};

export const isAlertable = (e: ChangeEvent, today: string): boolean =>
  (e.status === "announced" || e.status === "in-effect") &&
  !isBackfill(e) &&
  deadlineOpen(e, today);

export const checkEventAgainstVendor = (e: ChangeEvent, v: Vendor): string[] => {
  const problems: string[] = [];
  if (e.vendor !== v.id)
    problems.push(`event vendor '${e.vendor}' does not match vendor file '${v.id}'`);
  for (const url of [...e.sources.map((s) => s.url), ...(e.link ? [e.link] : [])]) {
    if (!v.allowedDomains.some((d) => isWithinDomain(hostOf(url), d))) {
      problems.push(`source ${url} is outside allowedDomains of ${v.id}`);
    }
  }
  return problems;
};
