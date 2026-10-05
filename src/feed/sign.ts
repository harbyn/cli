import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import {
  type EngineRelease,
  engineRelease,
  type FeedIndex,
  feedIndex,
  type SignatureEnvelope,
  signatureEnvelope,
} from "../schema/index.ts";
import { canonicalJson } from "./build.ts";

export type TrustedKeys = Readonly<Record<string, string>>;

export class FeedVerificationError extends Error {
  override name = "FeedVerificationError";
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const assertEd25519 = (key: KeyObject): void => {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("only ed25519 keys are supported");
};

export const publicKeyBase64 = (key: KeyObject): string =>
  (key.type === "public" ? key : createPublicKey(key))
    .export({ type: "spki", format: "der" })
    .toString("base64");

export const keyIdOf = (publicKeyB64: string): string =>
  sha256Hex(Buffer.from(publicKeyB64, "base64")).slice(0, 16);

export const signFeed = (bytes: Uint8Array, privateKeyPem: string): SignatureEnvelope =>
  signWith(bytes, bytes, privateKeyPem);

const signWith = (
  bytes: Uint8Array,
  message: Uint8Array,
  privateKeyPem: string,
): SignatureEnvelope => {
  const key = createPrivateKey(privateKeyPem);
  assertEd25519(key);
  return signatureEnvelope.parse({
    schemaVersion: 1,
    alg: "ed25519",
    keyId: keyIdOf(publicKeyBase64(key)),
    sha256: sha256Hex(bytes),
    signature: sign(null, message, key).toString("base64"),
  });
};

export interface VerifyOptions {
  now: Date;
  notOlderThan?: string;
}

export const verifyFeed = (
  bytes: Uint8Array,
  envelopeJson: unknown,
  trustedKeys: TrustedKeys,
  options: VerifyOptions,
): FeedIndex => {
  const index = feedIndex.safeParse(verifiedJson(bytes, envelopeJson, trustedKeys));
  if (!index.success) throw new FeedVerificationError("feed does not match the schema");
  checkFreshness(index.data, options);
  return index.data;
};

export const ENGINE_RELEASE_DOMAIN = "harbyn-engine-release/v1:";
const engineMessage = (bytes: Uint8Array): Uint8Array =>
  Buffer.concat([Buffer.from(ENGINE_RELEASE_DOMAIN, "utf8"), bytes]);

export const buildEngineRelease = (input: {
  commit: string;
  engine: Uint8Array;
  knowledge: Uint8Array;
  now: Date;
  ttlDays?: number;
}): Uint8Array => {
  const release = engineRelease.parse({
    schemaVersion: 1,
    purpose: "harbyn-engine-release",
    commit: input.commit,
    generatedAt: toIsoSeconds(input.now),
    expiresAt: toIsoSeconds(new Date(input.now.getTime() + (input.ttlDays ?? 14) * 86_400_000)),
    engine: { sha256: sha256Hex(input.engine), bytes: input.engine.byteLength },
    knowledge: { sha256: sha256Hex(input.knowledge), bytes: input.knowledge.byteLength },
  });
  return new TextEncoder().encode(canonicalJson(release));
};

export const signEngineRelease = (bytes: Uint8Array, privateKeyPem: string): SignatureEnvelope =>
  signWith(bytes, engineMessage(bytes), privateKeyPem);

export const verifyEngineRelease = (
  bytes: Uint8Array,
  envelopeJson: unknown,
  trustedKeys: TrustedKeys,
  options: VerifyOptions,
): EngineRelease => {
  const release = engineRelease.safeParse(
    verifiedJson(bytes, envelopeJson, trustedKeys, engineMessage(bytes)),
  );
  if (!release.success) throw new FeedVerificationError("engine release does not match the schema");
  checkFreshness(release.data, options);
  return release.data;
};

export const checkEnginePayload = (
  release: EngineRelease,
  engine: Uint8Array,
  knowledge: Uint8Array,
): void => {
  for (const [name, bytes, expected] of [
    ["engine", engine, release.engine],
    ["knowledge", knowledge, release.knowledge],
  ] as const) {
    if (bytes.byteLength !== expected.bytes || sha256Hex(bytes) !== expected.sha256) {
      throw new FeedVerificationError(`the served ${name} is not the one the signed release names`);
    }
  }
};

const toIsoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

const checkFreshness = (
  index: { generatedAt: string; expiresAt: string },
  options: VerifyOptions,
): void => {
  if (Date.parse(index.expiresAt) <= options.now.getTime())
    throw new FeedVerificationError("feed has expired");
  if (options.notOlderThan && Date.parse(index.generatedAt) < Date.parse(options.notOlderThan)) {
    throw new FeedVerificationError("feed is older than one already accepted (rollback)");
  }
};

const verifiedJson = (
  bytes: Uint8Array,
  envelopeJson: unknown,
  trustedKeys: TrustedKeys,
  message: Uint8Array = bytes,
): unknown => {
  const envelope = signatureEnvelope.safeParse(envelopeJson);
  if (!envelope.success) throw new FeedVerificationError("malformed signature envelope");

  const trusted = Object.hasOwn(trustedKeys, envelope.data.keyId)
    ? trustedKeys[envelope.data.keyId]
    : undefined;
  if (!trusted || keyIdOf(trusted) !== envelope.data.keyId)
    throw new FeedVerificationError("feed is signed by an untrusted key");

  const key = createPublicKey({ key: Buffer.from(trusted, "base64"), format: "der", type: "spki" });
  assertEd25519(key);
  if (!verify(null, message, key, Buffer.from(envelope.data.signature, "base64"))) {
    throw new FeedVerificationError("feed signature does not match");
  }
  if (sha256Hex(bytes) !== envelope.data.sha256)
    throw new FeedVerificationError("feed digest does not match");

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new FeedVerificationError("feed is not valid UTF-8 JSON");
  }
};
