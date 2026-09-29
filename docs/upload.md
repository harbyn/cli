# Upload format

With `upload: true` the Action sends one JSON document per run to `https://api.harbyn.com/ingest/manifest`. The
document is printed in the job summary before it is sent. Nothing else is sent, and the CLI never uploads.

```json
{
  "version": 1,
  "scanner": "0.1.0",
  "filesScanned": 425,
  "vendors": ["openai", "anthropic"],
  "findings": [
    {
      "eventId": "openai/2025-09-26-legacy-gpt-model-snapshots-shutdown",
      "identifier": "gpt-3.5-turbo-instruct",
      "via": "model-id",
      "context": "code",
      "count": 2
    }
  ]
}
```

| Field                   | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `version`               | format version, always `1`                                             |
| `scanner`               | scanner version                                                        |
| `filesScanned`          | number of files read                                                   |
| `vendors`               | vendor ids from the public feed that the repository uses (at most 200) |
| `findings`              | one entry per affected change and match kind (at most 1000)            |
| `findings[].eventId`    | id of the change in the public feed                                    |
| `findings[].identifier` | the model id or API version that matched, when the change lists it     |
| `findings[].via`        | `model-id`, `api-version`, `package` or `endpoint`                     |
| `findings[].context`    | `code`, `test`, `docs` or `catalog`                                    |
| `findings[].count`      | number of matches                                                      |
| `packages`              | only with `inventory: true`: the dependency list, at most 5000         |
| `packages[].ecosystem`  | `npm` or `pypi`                                                        |
| `packages[].name`       | package name on the public registry                                    |
| `packages[].version`    | exact version from the lockfile                                        |
| `packages[].direct`     | declared by the project, not only pulled in by another package         |
| `packages[].dev`        | used only in development                                               |

`packages` comes from lockfiles (package-lock, npm-shrinkwrap, pnpm-lock, yarn.lock, poetry.lock, uv.lock, pinned
requirements). Only packages resolved from the public npm registry or PyPI are listed: private registries,
workspace, link, file and git dependencies are never included. The server also checks each name against the public
registry and deletes any it cannot find.

Every other string is a term from the public feed. The server rejects the document if any vendor, event or identifier is
not in the feed, so nothing taken from the repository itself can be stored. Paths, line numbers and code are never
part of it.

The request carries a GitHub OIDC token (audience `https://api.harbyn.com`) that identifies the repository and the
run. It is accepted once, and only for the repository connected in the dashboard. The schema is
`src/schema/repo-manifest.ts`; the code that builds and sends it is `src/upload.ts`.
