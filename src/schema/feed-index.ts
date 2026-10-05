import { z } from "zod";
import { changeEvent } from "./change-event.ts";
import { migration } from "./migration.ts";
import { isoDateTime, sha256 } from "./primitives.ts";
import { vendor } from "./vendor.ts";

export const feedIndex = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: isoDateTime,
  expiresAt: isoDateTime,
  vendors: z.array(vendor).max(5000),
  events: z.array(changeEvent).max(200000),
});
export type FeedIndex = z.infer<typeof feedIndex>;

export const engineKnowledge = z.strictObject({
  schemaVersion: z.literal(1),
  migrations: z
    .array(z.strictObject({ eventId: z.string().max(160), vendor: z.string().max(64), migration }))
    .max(5000),
});
export type EngineKnowledge = z.infer<typeof engineKnowledge>;

const releaseFile = z.strictObject({
  sha256,
  bytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
});

export const engineRelease = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("harbyn-engine-release"),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  generatedAt: isoDateTime,
  expiresAt: isoDateTime,
  engine: releaseFile,
  knowledge: releaseFile,
});
export type EngineRelease = z.infer<typeof engineRelease>;

export const signatureEnvelope = z.strictObject({
  schemaVersion: z.literal(1),
  alg: z.literal("ed25519"),
  keyId: z.string().regex(/^[a-f0-9]{16}$/),
  sha256,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "must be a base64 ed25519 signature"),
});
export type SignatureEnvelope = z.infer<typeof signatureEnvelope>;
