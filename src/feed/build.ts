import type { FeedIndex } from "../schema/index.ts";
import { engineKnowledge, feedIndex } from "../schema/index.ts";
import type { LoadedFeed } from "./load.ts";

const DEFAULT_TTL_DAYS = 14;

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const toIsoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

export const buildIndex = (feed: LoadedFeed, now: Date, ttlDays = DEFAULT_TTL_DAYS): Uint8Array => {
  if (feed.problems.length > 0)
    throw new Error("refusing to build a feed that has validation problems");
  const index: FeedIndex = feedIndex.parse({
    schemaVersion: 1,
    generatedAt: toIsoSeconds(now),
    expiresAt: toIsoSeconds(new Date(now.getTime() + ttlDays * 86_400_000)),
    vendors: [...feed.vendors].sort((a, b) => a.id.localeCompare(b.id)),
    events: [...feed.events]
      .map(({ migration: _m, ...event }) => event)
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return new TextEncoder().encode(canonicalJson(index));
};

export const buildEngineKnowledge = (feed: LoadedFeed): Uint8Array => {
  if (feed.problems.length > 0)
    throw new Error("refusing to build engine knowledge from a feed that has validation problems");
  const knowledge = engineKnowledge.parse({
    schemaVersion: 1,
    migrations: feed.events
      .filter((e) => e.migration && e.status !== "retracted")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({ eventId: e.id, vendor: e.vendor, migration: e.migration })),
  });
  return new TextEncoder().encode(canonicalJson(knowledge));
};
