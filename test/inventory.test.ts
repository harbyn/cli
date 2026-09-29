import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { InventoryCollector } from "../src/inventory.ts";
import { scan } from "../src/index.ts";

const collect = (files: Record<string, string>) => {
  const c = new InventoryCollector();
  for (const [path, text] of Object.entries(files)) c.add(path, text);
  return c.result();
};
const names = (r: ReturnType<typeof collect>) =>
  r.dependencies.map(
    (d) =>
      `${d.ecosystem}:${d.name}@${d.version}${d.direct ? " direct" : ""}${d.dev ? " dev" : ""}`,
  );

describe("npm lockfiles", () => {
  it("package-lock v3: public packages with direct and dev flags; workspace, link and private registry dropped", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { stripe: "^16.0.0", "@acme/ui": "workspace:*" },
          devDependencies: { vitest: "^5.0.0" },
        },
        "node_modules/stripe": {
          version: "16.2.0",
          resolved: "https://registry.npmjs.org/stripe/-/stripe-16.2.0.tgz",
        },
        "node_modules/vitest": {
          version: "5.0.1",
          resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.1.tgz",
          dev: true,
        },
        "node_modules/vitest/node_modules/debug": {
          version: "4.4.0",
          resolved: "https://registry.npmjs.org/debug/-/debug-4.4.0.tgz",
          dev: true,
        },
        "node_modules/@acme/ui": { resolved: "packages/ui", link: true },
        "packages/ui": { version: "0.0.0" },
        "node_modules/@acme/secret-sdk": {
          version: "2.0.0",
          resolved: "https://npm.acme.internal/@acme/secret-sdk/-/secret-sdk-2.0.0.tgz",
        },
      },
    });
    const r = collect({ "package-lock.json": lock });
    expect(names(r)).toEqual([
      "npm:debug@4.4.0 dev",
      "npm:stripe@16.2.0 direct",
      "npm:vitest@5.0.1 direct dev",
    ]);
    expect(r.skippedNonPublic).toBe(3);
    expect(JSON.stringify(r.dependencies)).not.toContain("acme");
  });

  it("pnpm-lock v9: importers give direct deps; tarball and link resolutions are dropped", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      openai:",
      "        specifier: ^6.0.0",
      "        version: 6.1.0",
      "      shared:",
      "        specifier: workspace:*",
      "        version: link:packages/shared",
      "    devDependencies:",
      "      '@types/node':",
      "        specifier: ^26.0.0",
      "        version: 26.6.2",
      "",
      "packages:",
      "",
      "  '@types/node@26.6.2':",
      "    resolution: {integrity: sha512-abc}",
      "",
      "  openai@6.1.0:",
      "    resolution: {integrity: sha512-def}",
      "",
      "  internal-tool@1.0.0:",
      "    resolution: {integrity: sha512-x, tarball: https://npm.corp.example/internal-tool-1.0.0.tgz}",
      "",
      "snapshots:",
      "",
      "  openai@6.1.0: {}",
    ].join("\n");
    const r = collect({ "pnpm-lock.yaml": lock });
    expect(names(r)).toEqual(["npm:@types/node@26.6.2 direct dev", "npm:openai@6.1.0 direct"]);
    expect(r.skippedNonPublic).toBe(1);
  });

  it("yarn v1 and berry: registry entries kept, patches and workspaces dropped", () => {
    const v1 = [
      '"@babel/core@^7.0.0", "@babel/core@^7.1.0":',
      '  version "7.25.2"',
      '  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.25.2.tgz#abc"',
      "",
      "left-pad@git+https://github.com/x/left-pad.git:",
      '  version "1.3.0"',
      '  resolved "git+https://github.com/x/left-pad.git#abc"',
    ].join("\n");
    const berry = [
      "__metadata:",
      "  version: 8",
      "",
      '"react@npm:^19.0.0":',
      "  version: 19.1.0",
      '  resolution: "react@npm:19.1.0"',
      "",
      '"typescript@patch:typescript@npm%3A5.9.3#~builtin<compat/typescript>":',
      "  version: 5.9.3",
      '  resolution: "typescript@patch:typescript@npm%3A5.9.3#~builtin<compat/typescript>::version=5.9.3"',
      "",
      '"app@workspace:.":',
      "  version: 0.0.0-use.local",
      '  resolution: "app@workspace:."',
    ].join("\n");
    expect(
      names(
        collect({
          "a/yarn.lock": v1,
          "a/package.json": JSON.stringify({ dependencies: { "@babel/core": "^7.0.0" } }),
        }),
      ),
    ).toEqual(["npm:@babel/core@7.25.2 direct"]);
    const r = collect({ "b/yarn.lock": berry });
    expect(names(r)).toEqual(["npm:react@19.1.0"]);
    expect(r.skippedNonPublic).toBe(2);
  });
});

describe("Python lockfiles", () => {
  it("poetry.lock: PyPI packages kept, custom sources dropped, direct from pyproject", () => {
    const lock = [
      "[[package]]",
      'name = "Requests"',
      'version = "2.32.3"',
      "",
      "[[package]]",
      'name = "corp-auth"',
      'version = "1.0.0"',
      "",
      "[package.source]",
      'type = "legacy"',
      'url = "https://pypi.corp.example/simple"',
      'reference = "corp"',
    ].join("\n");
    const pyproject = ["[tool.poetry.dependencies]", 'python = "^3.12"', 'requests = "^2.32"'].join(
      "\n",
    );
    const r = collect({ "svc/poetry.lock": lock, "svc/pyproject.toml": pyproject });
    expect(names(r)).toEqual(["pypi:requests@2.32.3 direct"]);
    expect(r.skippedNonPublic).toBe(1);
  });

  it("uv.lock: only the PyPI registry counts; the project itself is not a dependency", () => {
    const lock = [
      "[[package]]",
      'name = "app"',
      'version = "0.1.0"',
      'source = { virtual = "." }',
      "dependencies = [",
      '    { name = "httpx" },',
      "]",
      "",
      "[[package]]",
      'name = "httpx"',
      'version = "0.28.1"',
      'source = { registry = "https://pypi.org/simple" }',
      "",
      "[[package]]",
      'name = "internal"',
      'version = "3.0.0"',
      'source = { registry = "https://pypi.corp.example/simple" }',
    ].join("\n");
    const r = collect({ "uv.lock": lock });
    expect(names(r)).toEqual(["pypi:httpx@0.28.1 direct"]);
    expect(r.skippedNonPublic).toBe(1);
  });

  it("requirements: pinned public lines only; a private index drops the whole file", () => {
    expect(
      names(
        collect({
          "requirements.txt":
            "django==5.2.1\nflask>=3\n-e ./local\ngit+https://github.com/x/y.git\n",
        }),
      ),
    ).toEqual(["pypi:django@5.2.1 direct"]);
    const r = collect({
      "requirements.txt": "--extra-index-url https://pypi.corp.example/simple\ncorp-lib==1.0.0\n",
    });
    expect(r.dependencies).toEqual([]);
  });
});

describe("abuse", () => {
  it("names and versions that are not real package coordinates are dropped", () => {
    const lock = JSON.stringify({
      packages: {
        "": {},
        "node_modules/$(rm -rf ~)": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/x.tgz",
        },
        "node_modules/ok": {
          version: "1.0.0; curl evil",
          resolved: "https://registry.npmjs.org/ok.tgz",
        },
        "node_modules/good": { version: "1.0.0", resolved: "https://registry.npmjs.org/good.tgz" },
      },
    });
    const r = collect({ "package-lock.json": lock });
    expect(names(r)).toEqual(["npm:good@1.0.0"]);
    expect(r.skippedInvalid).toBe(2);
    expect(collect({ "package-lock.json": "{not json" }).dependencies).toEqual([]);
  });

  it("scan reads lockfiles outside node_modules and ignored paths, and reports the inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "inv-"));
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    const lock = (name: string) =>
      JSON.stringify({
        packages: {
          "": { dependencies: { [name]: "1" } },
          [`node_modules/${name}`]: {
            version: "1.0.0",
            resolved: `https://registry.npmjs.org/${name}.tgz`,
          },
        },
      });
    write("package-lock.json", lock("kept"));
    write("node_modules/dep/package-lock.json", lock("vendored"));
    write("ignored/package-lock.json", lock("ignored"));
    write(".harbynignore", "ignored/\n");
    const result = scan(root, {
      schemaVersion: 1,
      generatedAt: "2026-09-29T00:00:00Z",
      expiresAt: "2026-10-13T00:00:00Z",
      vendors: [],
      events: [],
    } as never);
    expect(result.inventory?.dependencies.map((d) => d.name)).toEqual(["kept"]);
    expect(result.inventory?.files).toEqual(["package-lock.json"]);
  });
});
