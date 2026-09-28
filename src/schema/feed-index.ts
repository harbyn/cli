import { z } from "zod";
import { changeEvent } from "./change-event.ts";
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

export const signatureEnvelope = z.strictObject({
  schemaVersion: z.literal(1),
  alg: z.literal("ed25519"),
  keyId: z.string().regex(/^[a-f0-9]{16}$/),
  sha256,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "must be a base64 ed25519 signature"),
});
export type SignatureEnvelope = z.infer<typeof signatureEnvelope>;
