import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "release", "package.json"), "utf8")) as {
  version: string;
  bin: Record<string, string>;
};
const cliFile = Object.values(manifest.bin)[0];
if (!cliFile) throw new Error("release/package.json needs a bin entry");

interface Target {
  entry: string;
  outDir: string;
  file: string;
  shebang: boolean;
  copy: Array<[string, string]>;
  notices?: string;
  requireShim?: boolean;
}

const targets: Target[] = [
  {
    entry: "src/cli.ts",
    outDir: "dist/package",
    file: cliFile,
    shebang: true,
    copy: [
      ["release/package.json", "package.json"],
      ["release/README.md", "README.md"],
      ["release/LICENSE", "LICENSE"],
    ],
  },
  {
    entry: "src/action.ts",
    outDir: "dist/action",
    file: "harbyn-action.mjs",
    shebang: false,
    copy: [],
  },
];

const zodEnglishOnly: Plugin = {
  name: "zod-english-only",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) =>
      /[\\/]zod[\\/]v4[\\/](?:classic|core)[\\/]/.test(args.importer)
        ? {
            path: relative(root, join(dirname(args.importer), "..", "locales", "en.js")).replaceAll(
              "\\",
              "/",
            ),
            namespace: "zod-locales",
          }
        : undefined,
    );
    pluginBuild.onLoad({ filter: /.*/, namespace: "zod-locales" }, (args) => ({
      contents: `export { default as en } from "./en.js";`,
      resolveDir: join(root, dirname(args.path)),
      loader: "js",
    }));
  },
};

const licenseFileIn = (dir: string): string | undefined =>
  ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"]
    .map((f) => join(dir, f))
    .find((f) => existsSync(f));

rmSync(join(root, "dist"), { recursive: true, force: true });

for (const target of targets) {
  const out = join(root, target.outDir);
  mkdirSync(out, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, target.entry)],
    outfile: join(out, target.file),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: false,
    sourcemap: false,
    charset: "ascii",
    legalComments: "none",
    ...(target.shebang ? { banner: { js: "#!/usr/bin/env node" } } : {}),
    ...(target.requireShim
      ? {
          banner: {
            js: [
              'import { createRequire as __harbynCreateRequire } from "node:module";',
              'import { fileURLToPath as __harbynFileURLToPath } from "node:url";',
              'import { dirname as __harbynDirname } from "node:path";',
              "const require = __harbynCreateRequire(import.meta.url);",
              "const __filename = __harbynFileURLToPath(import.meta.url);",
              "const __dirname = __harbynDirname(__filename);",
            ].join("\n"),
          },
        }
      : {}),
    define: { HARBYN_VERSION: JSON.stringify(manifest.version) },
    metafile: true,
    logLevel: "warning",
    plugins: [zodEnglishOnly],
  });

  const packages = new Map<string, string>();
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = `/${input.replaceAll("\\", "/")}`;
    const at = path.lastIndexOf("/node_modules/");
    if (at < 0) continue;
    const rest = path.slice(at + "/node_modules/".length).split("/");
    const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : (rest[0] ?? "");
    packages.set(name, join(root, path.slice(1, at + "/node_modules/".length) + name));
  }
  const notices = [
    "# Third-party notices",
    "",
    `This file lists the open-source packages bundled into ${target.file}, with their licenses.`,
    "",
  ];
  for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version: string;
      license?: string;
    };
    const licenseFile = licenseFileIn(dir);
    if (!licenseFile)
      throw new Error(`no license file for bundled package ${name} (${relative(root, dir)})`);
    notices.push(
      `## ${name} ${pkg.version} (${pkg.license ?? "see below"})`,
      "",
      "```",
      readFileSync(licenseFile, "utf8").trim(),
      "```",
      "",
    );
  }
  writeFileSync(join(out, target.notices ?? "THIRD_PARTY_NOTICES.md"), notices.join("\n"));
  for (const [from, to] of target.copy) copyFileSync(join(root, from), join(out, to));
  console.log(
    `built ${relative(process.cwd(), join(out, target.file))} ${manifest.version}; bundled: ${[...packages.keys()].join(", ") || "none"}`,
  );
}
