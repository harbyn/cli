import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { safe } from "../report.ts";

export const CHECKS = ["typecheck", "test"] as const;
export type CheckName = (typeof CHECKS)[number];
export const SETTINGS_FILE = "mcp-settings.json";

const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_SCRIPT_CHARS = 2000;
const NPM_DEFAULT_TEST = /no test specified/;

const argv = z
  .array(
    z
      .string()
      .min(1)
      .max(1024)
      .refine((a) => !a.includes("\0"), "no NUL"),
  )
  .min(1)
  .max(32);
const settingsSchema = z.object({
  projects: z
    .record(z.string().max(4096), z.object({ typecheck: argv.optional(), test: argv.optional() }))
    .default({}),
  allowEnv: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
    .max(32)
    .default([]),
  tokenConfirmation: z.boolean().default(false),
});
export type McpSettings = z.output<typeof settingsSchema>;

export const readSettings = (configDir: string): McpSettings => {
  try {
    const file = join(configDir, SETTINGS_FILE);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return settingsSchema.parse({});
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : settingsSchema.parse({});
  } catch {
    return settingsSchema.parse({});
  }
};

export interface ResolvedCheck {
  check: CheckName;
  argv: string[];
  display: string;
  origin: "user-config" | "package.json" | "tsconfig.json" | "python-project";
  scriptBody: string | null;
  notes: string[];
  inputs: Record<string, string>;
}

export const findNpmCli = (
  execPath: string,
  env: Record<string, string | undefined>,
): string | undefined => {
  const candidates = [
    env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath) ? env.npm_execpath : undefined,
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((c): c is string => typeof c === "string" && existsSync(c));
};

const quote = (a: string): string => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : JSON.stringify(a));
const shown = (args: readonly string[]): string => safe(args.map(quote).join(" "));
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export const visibleScript = (body: string): string =>
  safe(
    body.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/ {2,}/g, " "),
  );

export interface ResolveOptions {
  root: string;
  config: McpSettings;
  execPath: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

export const resolveCheck = (
  check: CheckName,
  o: ResolveOptions,
): ResolvedCheck | { error: string } => {
  const own = o.config.projects[o.root]?.[check];
  if (own)
    return {
      check,
      argv: [...own],
      display: shown(own),
      origin: "user-config",
      scriptBody: null,
      notes: [],
      inputs: {},
    };

  let scripts: Record<string, unknown> = {};
  try {
    const pkg = join(o.root, "package.json");
    if (lstatSync(pkg).isFile() && lstatSync(pkg).size <= 1024 * 1024) {
      const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === "object")
        scripts = parsed.scripts as Record<string, unknown>;
    }
  } catch {
    scripts = {};
  }
  const body = scripts[check];
  if (
    typeof body === "string" &&
    body.trim() !== "" &&
    !(check === "test" && NPM_DEFAULT_TEST.test(body))
  ) {
    const around = [`pre${check}`, `post${check}`].filter((name) => scripts[name] !== undefined);
    if (around.length > 0) {
      const listed = around
        .map((name) => `${name}: ${visibleScript(String(scripts[name])).slice(0, 300)}`)
        .join("; ");
      return {
        error: `package.json also defines ${around.join(" and ")}, which npm would run around ${check}. Harbyn does not run checks with hidden scripts around them: remove them, or set the ${check} command in ${SETTINGS_FILE} in your Harbyn config directory. (${listed})`,
      };
    }
    if (body.length > MAX_SCRIPT_CHARS) {
      return {
        error: `the ${check} script is ${body.length} characters, over the ${MAX_SCRIPT_CHARS} Harbyn shows in full: set the command in ${SETTINGS_FILE} in your Harbyn config directory`,
      };
    }
    const npmCli = findNpmCli(o.execPath, o.env);
    const run = npmCli
      ? [o.execPath, npmCli, "run", check, "--ignore-scripts"]
      : o.platform === "win32"
        ? undefined
        : ["npm", "run", check, "--ignore-scripts"];
    if (!run)
      return {
        error: `npm's CLI was not found next to Node; set the ${check} command in ${SETTINGS_FILE} in your Harbyn config directory`,
      };
    const npmrc = join(o.root, ".npmrc");
    let npmrcBytes: Buffer | undefined;
    try {
      npmrcBytes = lstatSync(npmrc).isFile()
        ? readFileSync(npmrc)
        : Buffer.from("not a regular file");
    } catch {
      npmrcBytes = undefined;
    }
    const notes = [
      "npm runs the script through its own shell, with this project's node_modules/.bin first in PATH; --ignore-scripts keeps it from running anything around it.",
      ...(npmrcBytes
        ? [
            "This project has an .npmrc, which npm reads: it can change how the script runs (for example script-shell).",
          ]
        : []),
    ];
    const inputs = {
      scripts: sha256(JSON.stringify(scripts)),
      ...(npmrcBytes ? { npmrc: sha256(npmrcBytes) } : {}),
    };
    return {
      check,
      argv: run,
      display: `npm run ${check} --ignore-scripts`,
      origin: "package.json",
      scriptBody: visibleScript(body),
      notes,
      inputs,
    };
  }
  if (check === "typecheck") {
    const tsc = join(o.root, "node_modules", "typescript", "bin", "tsc");
    if (existsSync(join(o.root, "tsconfig.json")) && existsSync(tsc)) {
      const notes = ["This runs the TypeScript compiler installed in this project's node_modules."];
      return {
        check,
        argv: [o.execPath, tsc, "--noEmit"],
        display: "tsc --noEmit (node_modules/typescript/bin/tsc)",
        origin: "tsconfig.json",
        scriptBody: null,
        notes,
        inputs: { tsc: sha256(readFileSync(tsc)) },
      };
    }
  }
  if (
    check === "test" &&
    ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((f) =>
      existsSync(join(o.root, f)),
    )
  ) {
    const python = o.platform === "win32" ? "python" : "python3";
    const notes = [
      "pytest imports this project's tests, conftest.py files and configured plugins: that is code from the repository.",
    ];
    return {
      check,
      argv: [python, "-m", "pytest"],
      display: `${python} -m pytest`,
      origin: "python-project",
      scriptBody: null,
      notes,
      inputs: {},
    };
  }
  return {
    error: `no ${check} command found: add a "${check}" script to package.json, or set one in ${SETTINGS_FILE} in your Harbyn config directory`,
  };
};

const CREDENTIAL =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|^KEY$|APIKEY|API_KEY|PRIVATE_KEY|_PAT$|AUTH|^DATABASE_URL$|_DSN$|^AWS_|_PWD$|COOKIE|SESSION/i;

export const scrubEnv = (
  env: Record<string, string | undefined>,
  allow: readonly string[] = [],
): { env: Record<string, string>; removed: string[] } => {
  const kept: Record<string, string> = {};
  const removed: string[] = [];
  const allowed = new Set(allow);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CREDENTIAL.test(name) && !allowed.has(name)) removed.push(name);
    else kept[name] = value;
  }
  return { env: kept, removed: removed.sort() };
};
