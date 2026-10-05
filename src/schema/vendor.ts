import { z } from "zod";
import {
  displayText,
  hostname,
  hostOf,
  httpsUrl,
  isWithinDomain,
  literalToken,
  slug,
} from "./primitives.ts";

export const ecosystem = z.enum([
  "npm",
  "pypi",
  "go",
  "maven",
  "nuget",
  "rubygems",
  "packagist",
  "cargo",
]);

export const sourceFormat = z.enum(["rss", "atom", "openapi", "json", "html", "git"]);

export const vendorSource = z.strictObject({
  url: httpsUrl,
  format: sourceFormat,
  purpose: z.enum(["changelog", "deprecations", "spec", "pricing", "releases", "status"]),
});

export const detection = z.strictObject({
  packages: z
    .array(z.strictObject({ ecosystem, name: literalToken }))
    .max(64)
    .default([]),
  apiHosts: z.array(hostname).max(32).default([]),
  versionHeaders: z.array(literalToken).max(8).default([]),
  modelIdPrefixes: z.array(literalToken).max(64).default([]),
  modelIdVariantSuffixes: z
    .array(z.string().regex(/^:[a-z0-9-]{1,32}$/))
    .max(16)
    .default([]),
  envVars: z
    .array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/))
    .max(16)
    .default([]),
});

export const vendor = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: slug,
    name: displayText(80),
    homepage: httpsUrl,
    category: z.enum([
      "ai",
      "payments",
      "messaging",
      "devtools",
      "cloud",
      "commerce",
      "fiscal",
      "erp",
      "logistics",
      "other",
    ]),
    region: z.enum(["global", "br"]).default("global"),
    alertOnly: z.boolean().default(false),
    allowedDomains: z.array(hostname).min(1).max(16),
    sources: z.array(vendorSource).min(1).max(32),
    detection,
  })
  .superRefine((v, ctx) => {
    const inAllowed = (url: string) => v.allowedDomains.some((d) => isWithinDomain(hostOf(url), d));
    if (!inAllowed(v.homepage)) {
      ctx.addIssue({
        code: "custom",
        path: ["homepage"],
        message: "homepage is outside allowedDomains",
      });
    }
    v.sources.forEach((s, i) => {
      if (!inAllowed(s.url)) {
        ctx.addIssue({
          code: "custom",
          path: ["sources", i, "url"],
          message: "source is outside allowedDomains",
        });
      }
    });
    if (v.category === "payments" && !v.alertOnly) {
      ctx.addIssue({
        code: "custom",
        path: ["alertOnly"],
        message: "payments vendors must be alertOnly",
      });
    }
  });

export type Vendor = z.infer<typeof vendor>;
