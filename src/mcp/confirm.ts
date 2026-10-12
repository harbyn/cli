import { createHash, randomBytes } from "node:crypto";
import type { JsonObject, ToolSession } from "../mcp-protocol/index.ts";

export const TOKEN_TTL_MS = 10 * 60_000;
export const ELICIT_TIMEOUT_MS = 10 * 60_000;
const MAX_OPEN_TOKENS = 32;
export const MAX_ELICIT_CHARS = 8000;

export const bindingOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class Confirmations {
  private readonly tokens = new Map<string, { binding: string; expires: number }>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  issue(binding: string): { token: string; expiresAt: string } {
    const at = this.now();
    for (const [t, v] of this.tokens) if (v.expires <= at) this.tokens.delete(t);
    while (this.tokens.size >= MAX_OPEN_TOKENS)
      this.tokens.delete(this.tokens.keys().next().value as string);
    const token = `hc_${randomBytes(16).toString("hex")}`;
    const expires = at + TOKEN_TTL_MS;
    this.tokens.set(token, { binding, expires });
    return { token, expiresAt: new Date(expires).toISOString() };
  }

  consume(token: string, binding: string): boolean {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    return entry !== undefined && entry.expires > this.now() && entry.binding === binding;
  }
}

export const elicitationOf = (session: ToolSession | undefined): "form" | "legacy" | null => {
  const e = session?.capabilities.elicitation;
  if (typeof e !== "object" || e === null || Array.isArray(e)) return null;
  const keys = Object.keys(e);
  if (keys.length === 0) return "legacy";
  return "form" in e ? "form" : null;
};

export const elicit = async (
  session: ToolSession,
  mode: "form" | "legacy",
  message: string,
  label: string,
): Promise<"yes" | "no"> => {
  if (message.length > MAX_ELICIT_CHARS) return "no";
  const params: JsonObject = {
    ...(mode === "form" ? { mode: "form" } : {}),
    message,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: label,
          description: "Yes only if you read the summary above and want this done.",
        },
      },
      required: ["confirm"],
    },
  };
  try {
    const answer = (await session.request("elicitation/create", params, ELICIT_TIMEOUT_MS)) as {
      action?: unknown;
      content?: { confirm?: unknown };
    } | null;
    return answer?.action === "accept" && answer.content?.confirm === true ? "yes" : "no";
  } catch {
    return "no";
  }
};
