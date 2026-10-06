import { MANIFEST_LIMITS, type RepoManifest, repoManifest } from "./schema/index.ts";
import type { ScanResult } from "./report.ts";
import { safe } from "./report.ts";

export const INGEST_URL = "https://api.harbyn.com/ingest/manifest";
export const OIDC_AUDIENCE = "https://api.harbyn.com";

export const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const toManifest = (
  result: ScanResult,
  scannerVersion: string,
  options: { inventory?: boolean; fixes?: RepoManifest["fixes"] } = {},
): RepoManifest => {
  const groups = new Map<string, RepoManifest["findings"][number]>();
  const vendors = new Set<string>(result.usage.map((u) => u.vendor.id));
  for (const f of result.findings) {
    vendors.add(f.event.vendor);
    const listed = new Set(f.event.affects.flatMap((a) => ("values" in a ? a.values : [])));
    const identifier = listed.has(f.token) ? f.token : undefined;
    const key = `${f.event.id}|${identifier ?? ""}|${f.via}|${f.context}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else
      groups.set(key, {
        eventId: f.event.id,
        ...(identifier ? { identifier } : {}),
        via: f.via,
        context: f.context,
        count: 1,
      });
  }
  const findings = [...groups.values()]
    .sort(
      (a, b) =>
        a.eventId.localeCompare(b.eventId) ||
        (a.identifier ?? "").localeCompare(b.identifier ?? ""),
    )
    .slice(0, MANIFEST_LIMITS.findings)
    .map((g) => ({ ...g, count: Math.min(g.count, MANIFEST_LIMITS.count) }));
  return repoManifest.parse({
    version: 1,
    scanner: scannerVersion,
    filesScanned: result.stats.scanned,
    vendors: [...vendors].sort().slice(0, MANIFEST_LIMITS.vendors),
    findings,
    ...(options.inventory && result.inventory
      ? {
          packages: [...result.inventory.dependencies]
            .sort((a, b) => Number(b.direct) - Number(a.direct))
            .slice(0, MANIFEST_LIMITS.packages)
            .map(({ ecosystem, name, version, direct, dev }) => ({
              ecosystem,
              name,
              version,
              direct,
              dev,
            })),
        }
      : {}),
    ...(options.fixes ? { fixes: options.fixes } : {}),
  });
};

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface UploadResult {
  ok: boolean;
  message: string;
}

export const requestOidcToken = async (env: NodeJS.ProcessEnv, fetcher: Fetch): Promise<string> => {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer)
    throw new Error(
      "the job has no OIDC token: add `permissions: id-token: write` to it (see the Action's README)",
    );
  if (!url.startsWith("https://")) throw new Error("the runner's OIDC endpoint is not https");
  const res = await fetcher(`${url}&audience=${encodeURIComponent(OIDC_AUDIENCE)}`, {
    headers: { authorization: `bearer ${bearer}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the runner refused an OIDC token (HTTP ${res.status})`);
  const value = ((await res.json()) as { value?: unknown }).value;
  if (typeof value !== "string" || value.length < 20)
    throw new Error("the runner returned no OIDC token");
  return value;
};

export const uploadBody = (connection: string, manifest: RepoManifest): string =>
  JSON.stringify({ connection, manifest });

export const uploadManifest = async (
  body: string,
  token: string,
  fetcher: Fetch,
): Promise<UploadResult> => {
  try {
    const res = await fetcher(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 202) return { ok: true, message: "scan sent to Harbyn" };
    let detail = "";
    try {
      detail = String(((await res.json()) as { error?: unknown }).error ?? "");
    } catch {
      detail = "";
    }
    return {
      ok: false,
      message: `Harbyn refused the upload (HTTP ${res.status})${detail ? `: ${safe(detail).slice(0, 200)}` : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `could not reach Harbyn (${safe((error as Error).message).slice(0, 200)})`,
    };
  }
};
