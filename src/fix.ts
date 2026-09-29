import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ChangeEvent, literalToken, type Vendor } from "./schema/index.ts";
import type { Finding } from "./match.ts";
import type { ScanResult } from "./report.ts";

export const MAX_EDITS_PER_EVENT = 200;

export interface Edit {
  path: string;
  line: number;
  before: string;
  after: string;
}

export interface FixPlan {
  event: ChangeEvent;
  from: string;
  to: string;
  edits: Edit[];
  skipped: Array<{ path: string; line: number; reason: string }>;
}

export interface Unfixable {
  event: ChangeEvent;
  reason: string;
}

const SENSITIVE_WORDS = new Set([
  "payment",
  "payments",
  "pay",
  "billing",
  "bill",
  "checkout",
  "invoice",
  "invoices",
  "charge",
  "charges",
  "subscription",
  "subscriptions",
  "stripe",
  "braintree",
  "adyen",
  "paypal",
  "mercadopago",
  "pagarme",
  "pagseguro",
  "iugu",
  "asaas",
  "cielo",
  "pix",
  "boleto",
  "auth",
  "authn",
  "authz",
  "authentication",
  "authorization",
  "oauth",
  "oauth2",
  "openid",
  "oidc",
  "saml",
  "sso",
  "login",
  "logout",
  "signin",
  "signup",
  "session",
  "sessions",
  "password",
  "passwords",
  "passwd",
  "credential",
  "credentials",
  "mfa",
  "totp",
  "otp",
  "crypto",
  "cryptography",
  "cipher",
  "encrypt",
  "encryption",
  "decrypt",
  "security",
  "secret",
  "secrets",
  "key",
  "keys",
  "jwt",
  "token",
  "tokens",
]);
const SENSITIVE_CONTENT = new RegExp(
  [
    "bcrypt",
    "argon2",
    "scrypt",
    "pbkdf2",
    "jsonwebtoken",
    "jose",
    "passport",
    "next-auth",
    "@auth/",
    "auth0",
    "@clerk/",
    "firebase/auth",
    "supabase\\.auth",
    "crypto\\.subtle",
    "createCipheriv",
    "createDecipheriv",
    "createSign",
    "createHmac",
    "createHash",
    "randomBytes",
    "webcrypto",
    "node:crypto",
    "require\\(.crypto.\\)",
    "cryptography\\.hazmat",
    "hashlib",
    "hmac\\.new",
    "jwt\\.encode",
    "javax\\.crypto",
    "MessageDigest",
    '"crypto/',
    "golang\\.org/x/crypto",
    "stripe",
    "braintree",
    "adyen",
    "paypal",
    "mercadopago",
    "pagarme",
    "pagseguro",
    "paymentIntents",
    "checkout\\.sessions",
  ].join("|"),
  "i",
);
const CI_PATH =
  /^(?:\.github\/|\.gitlab-ci\.ya?ml$|\.circleci\/|\.buildkite\/|Jenkinsfile|azure-pipelines\.ya?ml$|bitbucket-pipelines\.ya?ml$|\.drone\.ya?ml$)/;

export const pathWords = (path: string): string[] =>
  path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export const isSensitive = (path: string, text: string): boolean =>
  CI_PATH.test(path) ||
  pathWords(path).some((w) => SENSITIVE_WORDS.has(w)) ||
  SENSITIVE_CONTENT.test(text);

export const splitLines = (text: string): { lines: string[]; endings: string[] } => {
  const parts = text.split(/(\r\n|\n)/);
  const lines: string[] = [];
  const endings: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts[i] as string);
    endings.push(parts[i + 1] ?? "");
  }
  return { lines, endings };
};
export const joinLines = ({ lines, endings }: { lines: string[]; endings: string[] }): string =>
  lines.map((l, i) => l + (endings[i] ?? "")).join("");

export const utf8Text = (bytes: Buffer): string | undefined => {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
};

export const safeToken = (token: string): boolean =>
  literalToken.safeParse(token).success && !/:\/\/|\/\/|\.\.|^\/|\/$/.test(token);

const reviewed = (event: ChangeEvent): boolean =>
  event.review.state === "human-reviewed" || event.review.extractedBy === "deterministic";

const valuesOf = (event: ChangeEvent, type: string, side: "affects" | "replacement"): string[] => {
  const targets = side === "affects" ? event.affects : (event.replacement?.targets ?? []);
  return [
    ...new Set(
      targets.filter((t) => t.type === type).flatMap((t) => ("values" in t ? t.values : [])),
    ),
  ];
};

const QUOTES = ['"', "'", "`"];

const commentStart = (line: string): number => {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (QUOTES.includes(ch)) quote = ch;
    else if (ch === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) return i;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) return i;
  }
  return line.length;
};

export const replaceLiteral = (full: string, from: string, to: string): string | undefined => {
  const trimmed = full.trimStart();
  if (/^(?:\/\/|#|\*|\/\*|<!--|--)/.test(trimmed)) return undefined;
  const cut = commentStart(full);
  const line = full.slice(0, cut);
  const tail = full.slice(cut);
  let out = "";
  let changed = false;
  let i = 0;
  while (i < line.length) {
    const at = line.indexOf(from, i);
    if (at === -1) break;
    const open = line[at - 1] ?? "";
    const close = line[at + from.length] ?? "";
    if (QUOTES.includes(open) && close === open) {
      out += line.slice(i, at) + to;
      changed = true;
    } else {
      out += line.slice(i, at + from.length);
    }
    i = at + from.length;
  }
  if (!changed) return undefined;
  return out + line.slice(i) + tail;
};

export interface PlanOptions {
  root: string;
  vendors: ReadonlyMap<string, Vendor>;
  read?: (path: string) => string | undefined;
}

export const planFixes = (
  result: ScanResult,
  options: PlanOptions,
): { plans: FixPlan[]; unfixable: Unfixable[] } => {
  const read =
    options.read ??
    ((path: string) => {
      try {
        const full = join(options.root, path);
        return lstatSync(full).isFile() ? utf8Text(readFileSync(full)) : undefined;
      } catch {
        return undefined;
      }
    });
  const byEvent = new Map<string, Finding[]>();
  for (const f of result.findings) {
    if (f.via !== "model-id" && f.via !== "api-version") continue;
    byEvent.set(f.event.id, [...(byEvent.get(f.event.id) ?? []), f]);
  }

  const plans: FixPlan[] = [];
  const unfixable: Unfixable[] = [];
  for (const findings of byEvent.values()) {
    const event = (findings[0] as Finding).event;
    const type = (findings[0] as Finding).via;
    if (!reviewed(event)) {
      unfixable.push({
        event,
        reason: "not reviewed yet: only reviewed events are fixed automatically",
      });
      continue;
    }
    if (options.vendors.get(event.vendor)?.alertOnly) {
      unfixable.push({
        event,
        reason: "alert-only vendor (payments, auth): Harbyn does not edit this code",
      });
      continue;
    }
    const replacements = valuesOf(event, type, "replacement");
    if (replacements.length !== 1) {
      unfixable.push({
        event,
        reason:
          replacements.length === 0
            ? "the vendor names no replacement"
            : "the vendor names several replacements: a person has to choose",
      });
      continue;
    }
    const to = replacements[0] as string;
    const affected = new Set(valuesOf(event, type, "affects"));
    if (!safeToken(to)) {
      unfixable.push({ event, reason: "the replacement is not a plain identifier" });
      continue;
    }

    const plan: FixPlan = { event, from: "", to, edits: [], skipped: [] };
    const fileText = new Map<string, string | undefined>();
    for (const f of findings) {
      if (f.context !== "code") {
        plan.skipped.push({
          path: f.path,
          line: f.line,
          reason:
            f.context === "test"
              ? "test file"
              : f.context === "docs"
                ? "documentation"
                : "model catalog",
        });
        continue;
      }
      if (!affected.has(f.token) || f.token === to || !safeToken(f.token)) {
        plan.skipped.push({
          path: f.path,
          line: f.line,
          reason: "matched a variant, not the exact retired identifier",
        });
        continue;
      }
      if (!fileText.has(f.path)) fileText.set(f.path, read(f.path));
      const text = fileText.get(f.path);
      if (text === undefined) {
        plan.skipped.push({
          path: f.path,
          line: f.line,
          reason: "file could not be read, or is not UTF-8",
        });
        continue;
      }
      if (isSensitive(f.path, text)) {
        plan.skipped.push({
          path: f.path,
          line: f.line,
          reason: "payments, authentication, cryptography or CI code: alert only",
        });
        continue;
      }
      const before = splitLines(text).lines[f.line - 1];
      const after = before === undefined ? undefined : replaceLiteral(before, f.token, to);
      if (before === undefined || after === undefined) {
        plan.skipped.push({
          path: f.path,
          line: f.line,
          reason: "not a plain string literal (a comment, or part of a longer value)",
        });
        continue;
      }
      if (plan.edits.some((e) => e.path === f.path && e.line === f.line)) continue;
      if (plan.edits.length >= MAX_EDITS_PER_EVENT) {
        plan.skipped.push({
          path: f.path,
          line: f.line,
          reason: "too many places in one change: fix the rest by hand",
        });
        continue;
      }
      plan.from = plan.from || f.token;
      plan.edits.push({ path: f.path, line: f.line, before, after });
    }
    if (plan.edits.length === 0)
      unfixable.push({ event, reason: plan.skipped[0]?.reason ?? "nothing to change" });
    else plans.push(plan);
  }
  return { plans, unfixable };
};

export const applyFixes = (
  root: string,
  plans: FixPlan[],
): { written: string[]; conflicts: string[] } => {
  const base = realpathSync(resolve(root));
  const byFile = new Map<string, Edit[]>();
  for (const plan of plans)
    for (const e of plan.edits) byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
  const written: string[] = [];
  const conflicts: string[] = [];
  for (const [path, edits] of byFile) {
    const full = resolve(base, path);
    const rel = relative(base, full);
    if (isAbsolute(rel) || rel.split(sep).includes("..")) {
      conflicts.push(path);
      continue;
    }
    let text: string | undefined;
    try {
      if (!lstatSync(full).isFile() || realpathSync(full) !== full)
        throw new Error("not a regular file");
      text = utf8Text(readFileSync(full));
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      conflicts.push(path);
      continue;
    }
    const split = splitLines(text);
    if (edits.some((e) => split.lines[e.line - 1] !== e.before)) {
      conflicts.push(path);
      continue;
    }
    for (const e of edits) split.lines[e.line - 1] = e.after;
    writeFileSync(full, joinLines(split));
    written.push(path);
  }
  return { written, conflicts };
};
