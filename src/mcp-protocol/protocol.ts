import { z } from "zod";

export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const HEADERLESS_VERSION = "2025-03-26";

export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

export const LIST_TTL_MS = 3_600_000;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ToolResult {
  structured: JsonObject;
  text: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  call: (args: unknown, today: string) => ToolResult | Promise<ToolResult>;
}

export interface ServerSpec {
  name: string;
  title: string;
  version: string;
  websiteUrl: string;
  instructions: string;
  tools: readonly Tool[];
}

export interface Reply {
  status: number;
  body: JsonObject | null;
}

type Id = string | number;

export const id = z.union([
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x20-\x7e]+$/),
  z.number().int().safe(),
]);
export const envelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: id.optional(),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const initializeParams = z.object({
  protocolVersion: z.string().max(64),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  clientInfo: z.record(z.string(), z.unknown()).optional(),
});
export const listParams = z.object({ cursor: z.string().max(256).optional() });
export const callParams = z.object({
  name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const errorBody = (
  requestId: Id | null,
  code: number,
  message: string,
  data?: JsonObject,
): JsonObject => ({
  jsonrpc: "2.0",
  id: requestId,
  error: data ? { code, message, data } : { code, message },
});

export const errorReply = (
  status: number,
  requestId: Id | null,
  code: number,
  message: string,
  data?: JsonObject,
): Reply => ({
  status,
  body: errorBody(requestId, code, message, data),
});

const unsupported = (requestId: Id | null, requested: string): Reply =>
  errorReply(400, requestId, ERR.unsupportedVersion, "Unsupported protocol version", {
    supported: [...SUPPORTED_VERSIONS],
    requested: requested.slice(0, 64),
  });

export const negotiate = (requested: string): string =>
  (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];

export const decodeHeaderValue = (value: string): string | undefined => {
  const sentinel = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (sentinel) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(sentinel[1] ?? "", "base64"),
      );
    } catch {
      return undefined;
    }
  }
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) ? value : undefined;
};

export const serverInfo = (spec: ServerSpec): JsonObject => ({
  name: spec.name,
  title: spec.title,
  version: spec.version,
  websiteUrl: spec.websiteUrl,
});

export const capabilities: JsonObject = { tools: { listChanged: false } };

export const toolList = (spec: ServerSpec): Json[] =>
  spec.tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));

export const callResult = (r: ToolResult): JsonObject => ({
  content: [{ type: "text", text: r.text }],
  structuredContent: r.structured,
  isError: r.isError === true,
});

export interface Incoming {
  body: unknown;
  header: (name: string) => string | undefined;
  today: string;
}

export const handle = async (
  spec: ServerSpec,
  { body, header, today }: Incoming,
): Promise<Reply> => {
  if (Array.isArray(body))
    return errorReply(400, null, ERR.invalidRequest, "Batch requests are not supported");
  const parsed = envelope.safeParse(body);
  if (!parsed.success) {
    const maybeId = id.safeParse((body as { id?: unknown } | null)?.id);
    return errorReply(
      400,
      maybeId.success ? maybeId.data : null,
      ERR.invalidRequest,
      "Invalid request",
    );
  }
  const { method, params = {} } = parsed.data;
  const requestId = parsed.data.id;
  if (requestId === undefined) return { status: 202, body: null };

  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const metaVersion = typeof meta === "object" && meta !== null ? meta[META_VERSION] : undefined;
  const headerVersion = header("mcp-protocol-version");
  const modern = method !== "initialize" && metaVersion !== undefined;

  if (modern) {
    if (typeof metaVersion !== "string")
      return errorReply(400, requestId, ERR.invalidParams, "Invalid _meta protocol version");
    if (!(MODERN_VERSIONS as readonly string[]).includes(metaVersion))
      return unsupported(requestId, metaVersion);
    const caps = meta[META_CAPABILITIES];
    if (typeof caps !== "object" || caps === null || Array.isArray(caps)) {
      return errorReply(400, requestId, ERR.invalidParams, `Missing ${META_CAPABILITIES} in _meta`);
    }
    if (headerVersion !== metaVersion)
      return errorReply(
        400,
        requestId,
        ERR.headerMismatch,
        "Header mismatch: MCP-Protocol-Version",
      );
    if (header("mcp-method") !== method)
      return errorReply(400, requestId, ERR.headerMismatch, "Header mismatch: Mcp-Method");
    if (method === "tools/call") {
      const sent = header("mcp-name");
      if (sent === undefined || decodeHeaderValue(sent) !== params.name)
        return errorReply(400, requestId, ERR.headerMismatch, "Header mismatch: Mcp-Name");
    }
  } else if (method !== "initialize") {
    const version = headerVersion ?? HEADERLESS_VERSION;
    if ((MODERN_VERSIONS as readonly string[]).includes(version)) {
      return errorReply(400, requestId, ERR.invalidParams, `Missing ${META_VERSION} in _meta`);
    }
    if (!(LEGACY_VERSIONS as readonly string[]).includes(version))
      return unsupported(requestId, version);
  }

  const ok = (result: JsonObject, cacheable = false): Reply => ({
    status: 200,
    body: {
      jsonrpc: "2.0",
      id: requestId,
      result: modern
        ? {
            resultType: "complete",
            ...result,
            ...(cacheable ? { ttlMs: LIST_TTL_MS, cacheScope: "public" } : {}),
            _meta: { [META_SERVER_INFO]: serverInfo(spec) },
          }
        : result,
    },
  });
  const invalidParams = (message: string): Reply =>
    errorReply(200, requestId, ERR.invalidParams, message);

  switch (method) {
    case "initialize": {
      const p = initializeParams.safeParse(params);
      if (!p.success) return invalidParams("Invalid initialize params");
      return ok({
        protocolVersion: negotiate(p.data.protocolVersion),
        capabilities,
        serverInfo: serverInfo(spec),
        instructions: spec.instructions,
      });
    }
    case "server/discover":
      return ok(
        {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities,
          instructions: spec.instructions,
        },
        true,
      );
    case "ping":
      return ok({});
    case "tools/list": {
      const p = listParams.safeParse(params);
      if (!p.success) return invalidParams("Invalid tools/list params");
      if (p.data.cursor !== undefined) return invalidParams("Invalid cursor");
      return ok({ tools: toolList(spec) }, true);
    }
    case "tools/call": {
      const p = callParams.safeParse(params);
      if (!p.success) return invalidParams("Invalid tools/call params");
      const tool = spec.tools.find((t) => t.name === p.data.name);
      if (!tool) return invalidParams("Unknown tool");
      return ok(callResult(await tool.call(p.data.arguments ?? {}, today)));
    }
    default:
      return errorReply(modern ? 404 : 200, requestId, ERR.methodNotFound, "Method not found");
  }
};
