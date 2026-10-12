import type {
  EngineApplyInput,
  EngineModule,
  EnginePlanInput,
  EngineValidateInput,
} from "../src/engine.ts";

const lines = (text: string): string[] => text.split(/\r?\n/);

export const greedyEngine = (calls: string[] = []): EngineModule => ({
  ENGINE_ABI: 1,
  runAction: async () => undefined,
  runMigrate: async () => 0,
  plan: (input: EnginePlanInput) => {
    calls.push(`plan ${input.eventId}`);
    const edits = input.result.findings
      .filter((f) => f.event.id === input.eventId)
      .flatMap((f) => {
        const text = input.read(f.path);
        const before = text === undefined ? undefined : lines(text)[f.line - 1];
        return before === undefined
          ? []
          : [{ path: f.path, line: f.line, before, after: before.replace(f.token, "acme-2") }];
      });
    return { mode: "swap", recipeId: "test-swap", edits, skipped: [], reason: null, context: null };
  },
  validateEdits: (input: EngineValidateInput) => {
    calls.push(`validate ${input.eventId}`);
    return Array.isArray(input.edits)
      ? { ok: true, edits: input.edits as never }
      : { ok: false, reason: "not a list" };
  },
  apply: (input: EngineApplyInput) => {
    calls.push("apply");
    const byFile = new Map<string, typeof input.edits>();
    for (const e of input.edits) byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
    const files = [...byFile].flatMap(([path, edits]) => {
      const text = input.read(path);
      if (text === undefined) return [];
      const parts = text.split("\n");
      for (const e of edits)
        parts[e.line - 1] = e.after + (parts[e.line - 1]?.endsWith("\r") ? "\r" : "");
      return [{ path, text: parts.join("\n") }];
    });
    return { files, conflicts: [] };
  },
});

export const windowEngine = (calls: string[] = []): EngineModule => ({
  ...greedyEngine(calls),
  plan: (input: EnginePlanInput) => {
    const windows = input.result.findings
      .filter((f) => f.event.id === input.eventId && f.context === "code")
      .flatMap((f) => {
        const text = input.read(f.path);
        return text === undefined ? [] : [{ path: f.path, from: 1, lines: lines(text) }];
      });
    return {
      mode: "model-needed",
      recipeId: "test-agent",
      edits: [],
      skipped: [],
      reason: null,
      context: { notes: ["Use acme-y for chat."], windows },
    };
  },
});

export const sneakyEngine = (): EngineModule => ({
  ...greedyEngine(),
  apply: (input: EngineApplyInput) => {
    const real = greedyEngine().apply?.(input) ?? { files: [], conflicts: [] };
    return {
      files: real.files.map((f) => ({
        path: f.path,
        text: `${f.text}\nfetch("https://evil.example");`,
      })),
      conflicts: [],
    };
  },
});

export const oldEngine = (): EngineModule => ({
  ENGINE_ABI: 1,
  runAction: async () => undefined,
  runMigrate: async () => 0,
  runFix: async () => 0,
});
