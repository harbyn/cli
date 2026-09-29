# harbyn

Finds the places in your code that a vendor's upcoming change will break. It looks for retired or retiring model IDs,
pinned API versions, vendor SDKs and API hosts, then matches them against a signed feed of vendor changes.

```
$ npx harbyn scan
[HIGH] OpenAI: Legacy GPT model snapshots - shutdown 2026-09-28
  when:   in 4 days (2026-09-28)
  use:    gpt-5.6-terra
  source: https://platform.openai.com/docs/deprecations
    src/ai/summarize.ts:4  gpt-3.5-turbo-instruct

1 finding(s), 1 file scanned
```

Every finding links to the vendor's own announcement.

Dependabot tracks package versions. This tracks what your code does with the vendor: the model it asks for, the API
version it pins, the endpoint it calls.

## CLI

```sh
npx harbyn scan
npx harbyn scan path/to/repo --json
npx harbyn scan --ci
npx harbyn scan --deps
```

| Option             |                                                                   |
| ------------------ | ----------------------------------------------------------------- |
| `--json`           | machine-readable output                                           |
| `--ci`             | exit 1 when there are findings in code                            |
| `--all`            | also list low-confidence findings (tests, docs, model catalogs)   |
| `--deps`           | list every dependency found in lockfiles (public registries only) |
| `--ignore <glob>`  | extra ignore pattern, repeatable                                  |
| `--include-nested` | also scan nested git repositories                                 |
| `--no-gitignore`   | do not honour `.gitignore` files                                  |
| `--offline`        | use the cached feed, make no network request                      |
| `--version`        | print the version                                                 |

`.gitignore` and `.harbynignore` (same syntax) are honoured.

Exit codes: `0` done, `1` findings with `--ci`, `2` the feed could not be verified (nothing is reported) or a usage
error.

## GitHub Action

```yaml
permissions: {}

jobs:
  harbyn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<commit sha>
        with:
          persist-credentials: false
      - uses: harbyn/cli@<commit sha>
        with:
          fail-on: none
```

Annotations appear on the affected lines in pull requests, and the job summary lists every affected line with the
deadline, the replacement and the vendor's announcement. Pin the action by commit SHA.

| Input             | Default |                                                                      |
| ----------------- | ------- | -------------------------------------------------------------------- |
| `path`            | `.`     | directory to scan, inside the repository                             |
| `ignore`          |         | extra ignore patterns, one per line                                  |
| `fail-on`         | `none`  | `findings` fails the step when code is affected                      |
| `on-feed-error`   | `warn`  | `fail` fails the step when the feed cannot be verified               |
| `upload`          | `false` | `true` sends the result to your Harbyn dashboard                     |
| `connection`      |         | the connection id from your dashboard, used only with `upload`       |
| `inventory`       | `false` | `true` adds the dependency list to the upload (public packages only) |
| `on-upload-error` | `warn`  | `fail` fails the step when the upload fails                          |

Outputs: `findings` (number of affected lines) and `report` (path of the JSON report on the runner).

### Dashboard upload

Off by default. With `upload: true` and `permissions: id-token: write`, the Action sends the scanner version, the
number of files scanned, the vendors the repository uses and, per affected change, the feed event, the term that
matched, where it matched (code, tests, docs) and a count. No paths, no line numbers, no code. The exact body is
printed in the job summary before it is sent, to `https://api.harbyn.com/ingest/manifest` only.

There is no secret to store: GitHub signs a short-lived token that says which repository the run belongs to, and the
upload is accepted only for the repository you connected. Pull requests from forks never get that token, so they never
upload.

## What it does and does not do

- It never writes to your project. The only file it writes is its feed cache (`%LOCALAPPDATA%\harbyn`,
  `$XDG_CACHE_HOME/harbyn` or `~/.cache/harbyn`).
- The CLI makes one network request: the change feed from `https://feed.harbyn.com/v1/feed.json` and its signature.
  There is no telemetry.
- `.env` files (except `.env.example` and similar), private keys, `.npmrc`, `.netrc` and credential files are skipped
  without being read.
- The feed is signed, and the signature is checked against keys pinned in the code. It carries an expiry date, and a
  feed older than one already accepted on this machine is rejected. If anything fails, nothing is reported and the
  exit code is 2.
- One file, no dependencies, no install scripts. Everything is bundled into `harbyn.mjs` and left unminified so you
  can read it. Bundled packages and their licenses are listed in `THIRD_PARTY_NOTICES.md`.

## Verifying a release

npm packages are published from this repository's release workflow with provenance, and each release carries a
build attestation:

```sh
npm audit signatures
gh attestation verify harbyn-<version>.tgz --repo harbyn/cli
```

`dist/action/harbyn-action.mjs` is committed so the Action can be pinned by SHA. CI rebuilds it on every push and
fails if the committed file differs.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

## License

Apache-2.0. The change feed it downloads is a separate service with its own terms.
