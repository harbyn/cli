import {
  callParams,
  callResult,
  capabilities,
  envelope,
  ERR,
  id as requestIdSchema,
  initializeParams,
  type JsonObject,
  listParams,
  META_CAPABILITIES,
  META_SERVER_INFO,
  META_VERSION,
  MODERN_VERSIONS,
  negotiate,
  type ServerSpec,
  serverInfo,
  SUPPORTED_VERSIONS,
  toolList,
} from "./protocol.ts";

export const MAX_LINE_BYTES = 1024 * 1024;
export const CLIENT_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_CALLS_IN_FLIGHT = 8;
export const ERR_BUSY = -32000;

type Id = string | number;

export interface StdioClient {
  capabilities: Record<string, unknown>;
  request: (method: string, params?: JsonObject) => Promise<unknown>;
}

export interface StdioOptions {
  spec: ServerSpec;
  input: AsyncIterable<string | Uint8Array>;
  write: (line: string) => void;
  today?: () => string;
  onInitialized?: (client: StdioClient) => void;
  onError?: (error: unknown) => void;
  clientRequestTimeoutMs?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const serveStdio = async (options: StdioOptions): Promise<void> => {
  const { spec, write } = options;
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const send = (message: JsonObject): void => write(JSON.stringify(message));
  const error = (requestId: Id | null, code: number, message: string, data?: JsonObject): void =>
    send({
      jsonrpc: "2.0",
      id: requestId,
      error: data ? { code, message, data } : { code, message },
    });

  let initialized = false;
  let ready = false;
  let clientCapabilities: Record<string, unknown> = {};
  let nextId = 1;
  const pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const inFlight = new Set<Promise<void>>();
  let calls = 0;

  const request = (method: string, params?: JsonObject): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const requestId = `harbyn-${nextId++}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`the client did not answer ${method}`));
      }, options.clientRequestTimeoutMs ?? CLIENT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id: requestId, method, ...(params ? { params } : {}) });
    });

  const becomeReady = (): void => {
    if (ready) return;
    ready = true;
    options.onInitialized?.({ capabilities: clientCapabilities, request });
  };

  const onResponse = (message: Record<string, unknown>): void => {
    const waiting = typeof message.id === "string" ? pending.get(message.id) : undefined;
    if (!waiting || typeof message.id !== "string") return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if ("error" in message) waiting.reject(new Error("the client answered with an error"));
    else waiting.resolve(message.result);
  };

  const onMessage = async (body: unknown): Promise<void> => {
    if (Array.isArray(body))
      return error(null, ERR.invalidRequest, "Batch requests are not supported");
    if (
      isObject(body) &&
      !("method" in body) &&
      "id" in body &&
      ("result" in body || "error" in body)
    )
      return onResponse(body);
    const parsed = envelope.safeParse(body);
    if (!parsed.success) {
      const maybeId = requestIdSchema.safeParse(isObject(body) ? body.id : undefined);
      return error(maybeId.success ? maybeId.data : null, ERR.invalidRequest, "Invalid request");
    }
    const { method, params = {} } = parsed.data;
    const requestId = parsed.data.id;
    if (requestId === undefined) {
      if (method === "notifications/initialized" && initialized) becomeReady();
      return;
    }

    const meta = isObject(params._meta) ? params._meta : {};
    const metaVersion = meta[META_VERSION];
    const modern = method !== "initialize" && metaVersion !== undefined;
    if (modern) {
      if (typeof metaVersion !== "string")
        return error(requestId, ERR.invalidParams, "Invalid _meta protocol version");
      if (!(MODERN_VERSIONS as readonly string[]).includes(metaVersion)) {
        return error(requestId, ERR.unsupportedVersion, "Unsupported protocol version", {
          supported: [...SUPPORTED_VERSIONS],
          requested: metaVersion.slice(0, 64),
        });
      }
      const caps = meta[META_CAPABILITIES];
      if (!isObject(caps))
        return error(requestId, ERR.invalidParams, `Missing ${META_CAPABILITIES} in _meta`);
      if (!ready) {
        clientCapabilities = caps;
        becomeReady();
      }
    } else if (method !== "initialize" && method !== "ping" && !initialized) {
      return error(requestId, ERR.invalidRequest, "Not initialized: send initialize first");
    }

    const ok = (result: JsonObject): void =>
      send({
        jsonrpc: "2.0",
        id: requestId,
        result: modern
          ? { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: serverInfo(spec) } }
          : result,
      });

    switch (method) {
      case "initialize": {
        const p = initializeParams.safeParse(params);
        if (!p.success) return error(requestId, ERR.invalidParams, "Invalid initialize params");
        if (initialized) return error(requestId, ERR.invalidRequest, "Already initialized");
        initialized = true;
        clientCapabilities = isObject(p.data.capabilities) ? p.data.capabilities : {};
        return ok({
          protocolVersion: negotiate(p.data.protocolVersion),
          capabilities,
          serverInfo: serverInfo(spec),
          instructions: spec.instructions,
        });
      }
      case "server/discover":
        return ok({
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities,
          instructions: spec.instructions,
        });
      case "ping":
        return ok({});
      case "tools/list": {
        const p = listParams.safeParse(params);
        if (!p.success) return error(requestId, ERR.invalidParams, "Invalid tools/list params");
        if (p.data.cursor !== undefined)
          return error(requestId, ERR.invalidParams, "Invalid cursor");
        return ok({ tools: toolList(spec) });
      }
      case "tools/call": {
        const p = callParams.safeParse(params);
        if (!p.success) return error(requestId, ERR.invalidParams, "Invalid tools/call params");
        const tool = spec.tools.find((t) => t.name === p.data.name);
        if (!tool) return error(requestId, ERR.invalidParams, "Unknown tool");
        if (calls >= MAX_CALLS_IN_FLIGHT)
          return error(
            requestId,
            ERR_BUSY,
            "Too many tool calls in flight: wait for an answer, then retry",
          );
        calls += 1;
        try {
          return ok(callResult(await tool.call(p.data.arguments ?? {}, today())));
        } catch (e) {
          options.onError?.(e);
          return error(requestId, ERR.internal, "Internal error");
        } finally {
          calls -= 1;
        }
      }
      default:
        return error(requestId, ERR.methodNotFound, "Method not found");
    }
  };

  const dispatch = (line: string): void => {
    if (line.trim() === "") return;
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      return error(null, ERR.parse, "Parse error");
    }
    const task = onMessage(body).catch((e: unknown) => options.onError?.(e));
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dropping = false;
  for await (const chunk of options.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) error(null, ERR.parse, "Message too large");
      else dispatch(line);
    }
    if (dropping) buffer = "";
    else if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      error(null, ERR.parse, "Message too large");
      buffer = "";
      dropping = true;
    }
  }
  if (!dropping && buffer.trim() !== "") dispatch(buffer);
  await Promise.all([...inFlight]);
  for (const [, waiting] of pending) {
    clearTimeout(waiting.timer);
    waiting.reject(new Error("the client closed the connection"));
  }
  pending.clear();
};
