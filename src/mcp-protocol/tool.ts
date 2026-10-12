import { z } from "zod";
import type { JsonObject, Tool, ToolResult } from "./protocol.ts";

export const MAX_ITEMS = 50;
export const MAX_TEXT_BYTES = 20 * 1024;

const withoutSafeRange = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutSafeRange);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k, v]) =>
          !(
            (k === "minimum" && v === Number.MIN_SAFE_INTEGER) ||
            (k === "maximum" && v === Number.MAX_SAFE_INTEGER)
          ),
      )
      .map(([k, v]) => [k, withoutSafeRange(v)]),
  );
};

const jsonSchemaOf = (schema: z.ZodType, io: "input" | "output"): JsonObject => {
  const { $schema: _dialect, ...rest } = withoutSafeRange(
    z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }),
  ) as JsonObject;
  return rest;
};

export const capText = (text: string, maxBytes = MAX_TEXT_BYTES): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const note = "\n[truncated: narrow the query or lower the limit]";
  let cut = maxBytes - Buffer.byteLength(note);
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString("utf8") + note;
};

const argumentProblem = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join(".") : "arguments"}: ${i.message}`)
    .join("; ")
    .slice(0, 500);

export const toolError = (message: string): ToolResult => ({
  structured: { error: message },
  text: message,
  isError: true,
});

type ToolAnswer<O extends z.ZodType> = { data: z.output<O>; text: string } | { error: string };

export const defineTool = <I extends z.ZodType, O extends z.ZodType>(def: {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  run: (args: z.output<I>, today: string) => ToolAnswer<O> | Promise<ToolAnswer<O>>;
}): Tool & { output: O } => ({
  name: def.name,
  title: def.title,
  description: def.description,
  inputSchema: jsonSchemaOf(def.input, "input"),
  outputSchema: jsonSchemaOf(def.output, "output"),
  output: def.output,
  call: async (args, today) => {
    const parsed = def.input.safeParse(args);
    if (!parsed.success) return toolError(`Invalid arguments. ${argumentProblem(parsed.error)}`);
    const r = await def.run(parsed.data, today);
    if ("error" in r) return toolError(r.error);
    return { structured: r.data as JsonObject, text: capText(r.text) };
  },
});
