import { z } from "zod";
import { displayText, literalToken } from "./primitives.ts";
import { parseRange } from "./semver.ts";
import { ecosystem } from "./vendor.ts";

const PLACEHOLDER =
  /[.]{3}[$][1-9]|[$][1-9](?:[.][A-Za-z_$][A-Za-z0-9_$]*|-[A-Za-z_$][A-Za-z0-9_$]*|~)?|[$][0*]/g;

export const validTemplate = (to: string): boolean => {
  const rest = to.replace(PLACEHOLDER, "").replace(/"[A-Za-z0-9 _/-]{0,40}"/g, "");
  return (
    /^[A-Za-z0-9_$.(){}[\]:, ]*$/.test(rest) &&
    !/\b(?:import|require|eval|Function|process|globalThis|constructor|prototype|__proto__)\b/.test(
      rest,
    )
  );
};

const template = z
  .string()
  .min(2)
  .max(200)
  .refine(validTemplate, "must use only the recipe template vocabulary");
const memberPath = z
  .string()
  .max(80)
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.][A-Za-z_$][A-Za-z0-9_$]*)*$/,
    "must be a member name or a dotted path",
  );

export const callRecipe = z.strictObject({
  member: memberPath,
  arity: z.number().int().min(0).max(9).optional(),
  when: z
    .enum(["arg1-number", "arg2-number", "arg1-not-object", "arg1-identifier-string"])
    .optional(),
  to: template,
});

export const propertyRecipe = z.strictObject({
  property: z
    .string()
    .max(60)
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
  to: template,
});

export const migrationNote = z.strictObject({
  symbol: memberPath,
  text: displayText(300),
});

export const migration = z.strictObject({
  package: z.strictObject({
    ecosystem,
    name: literalToken,
    from: z
      .string()
      .min(1)
      .max(64)
      .refine((r) => parseRange(r) !== undefined, "must be a range the scanner can evaluate"),
    to: z
      .string()
      .min(1)
      .max(32)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "must be an exact version"),
  }),
  notes: z.array(migrationNote).max(20).default([]),
  calls: z.array(callRecipe).max(40).default([]),
  properties: z.array(propertyRecipe).max(10).default([]),
});

export type Migration = z.infer<typeof migration>;
export type CallRecipe = z.infer<typeof callRecipe>;
export type PropertyRecipe = z.infer<typeof propertyRecipe>;
