import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import {
  type FeedIndex,
  feedIndex,
  type SignatureEnvelope,
  signatureEnvelope,
} from "../schema/index.ts";

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

export const signFeed = (bytes: Uint8Array, privateKeyPem: string): SignatureEnvelope => {
  const key = createPrivateKey(privateKeyPem);
  assertEd25519(key);
  return signatureEnvelope.parse({
    schemaVersion: 1,
    alg: "ed25519",
    keyId: keyIdOf(publicKeyBase64(key)),
    sha256: sha256Hex(bytes),
    signature: sign(null, bytes, key).toString("base64"),
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
  const envelope = signatureEnvelope.safeParse(envelopeJson);
  if (!envelope.success) throw new FeedVerificationError("malformed signature envelope");

  const trusted = Object.hasOwn(trustedKeys, envelope.data.keyId)
    ? trustedKeys[envelope.data.keyId]
    : undefined;
  if (!trusted || keyIdOf(trusted) !== envelope.data.keyId)
    throw new FeedVerificationError("feed is signed by an untrusted key");

  const key = createPublicKey({ key: Buffer.from(trusted, "base64"), format: "der", type: "spki" });
  assertEd25519(key);
  if (!verify(null, bytes, key, Buffer.from(envelope.data.signature, "base64"))) {
    throw new FeedVerificationError("feed signature does not match");
  }
  if (sha256Hex(bytes) !== envelope.data.sha256)
    throw new FeedVerificationError("feed digest does not match");

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new FeedVerificationError("feed is not valid UTF-8 JSON");
  }
  const index = feedIndex.safeParse(json);
  if (!index.success) throw new FeedVerificationError("feed does not match the schema");

  if (Date.parse(index.data.expiresAt) <= options.now.getTime())
    throw new FeedVerificationError("feed has expired");
  if (
    options.notOlderThan &&
    Date.parse(index.data.generatedAt) < Date.parse(options.notOlderThan)
  ) {
    throw new FeedVerificationError("feed is older than one already accepted (rollback)");
  }
  return index.data;
};
