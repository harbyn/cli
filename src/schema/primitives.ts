import { z } from "zod";

const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const hasForbiddenChar = (s: string): boolean => {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (FORBIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  }
  return false;
};
const MARKUP_CHARS = /[<>`]/;

export const displayText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s === s.trim(), "must not have leading/trailing whitespace")
    .refine((s) => !hasForbiddenChar(s), "must not contain control or bidi characters")
    .refine((s) => !MARKUP_CHARS.test(s), "must not contain markup characters");

export const slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case slug");

export const literalToken = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9@][A-Za-z0-9._:@/+-]*$/, "must be a plain identifier token");

export const hostname = z
  .string()
  .min(4)
  .max(253)
  .regex(
    /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a lowercase DNS hostname (no IPs, no ports)",
  );

export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: false });
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase hex sha256");

export const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === "" &&
      hostname.safeParse(url.hostname).success &&
      url.href === value
    );
  }, "must be a canonical https URL without credentials, port, IP literal or fragment");

export const hostOf = (url: string): string => new URL(url).hostname;

export const isWithinDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);
