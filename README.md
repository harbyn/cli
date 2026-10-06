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

| Input                                      | Default   |                                                                           |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------- |
| `path`                                     | `.`       | directory to scan, inside the repository                                  |
| `ignore`                                   |           | extra ignore patterns, one per line                                       |
| `fail-on`                                  | `none`    | `findings` fails the step when code is affected                           |
| `on-feed-error`                            | `warn`    | `fail` fails the step when the feed cannot be verified                    |
| `upload`                                   | `false`   | `true` sends the result to your Harbyn dashboard                          |
| `connection`                               |           | the connection id from your dashboard, used with `upload` and `remediate` |
| `inventory`                                | `false`   | `true` adds the dependency list to the upload (public packages only)      |
| `on-upload-error`                          | `warn`    | `fail` fails the step when the upload fails                               |
| `remediate`                                | `false`   | `true` opens fix pull requests (Harbyn Pro and Team, see below)           |
| `llm-provider`, `llm-model`, `llm-api-key` |           | optional with `remediate`: your model and key for what no recipe covers   |
| `github-token`                             | job token | the token `remediate` opens its pull requests with                        |

Outputs: `findings` (number of affected lines), `report` (path of the JSON report on the runner) and `pull-requests`.

### Dashboard upload

Off by default. With `upload: true` and `permissions: id-token: write`, the Action sends the scanner version, the
number of files scanned, the vendors the repository uses and, per affected change, the feed event, the term that
matched, where it matched (code, tests, docs) and a count. No paths, no line numbers, no code. The exact body is
printed in the job summary before it is sent, to `https://api.harbyn.com/ingest/manifest` only.

There is no secret to store: GitHub signs a short-lived token that says which repository the run belongs to, and the
upload is accepted only for the repository you connected. Pull requests from forks never get that token, so they never
upload.

## Automatic fixes

This CLI and Action find what will break and where, for free. Automatic fixes and SDK migrations, opened as pull
requests, are part of Harbyn Pro and Team (https://harbyn.com/pricing) and are switched on from the dashboard.

They run in your own CI, so your code never leaves it, and the pull requests are opened by your workflow with your
job's own token; Harbyn never holds write access to your repository. With `remediate: true` (and `harbyn migrate` in
a workflow with `HARBYN_CONNECTION` set) this open-source code:

1. asks the runner for a GitHub OIDC token (`permissions: id-token: write`) and sends it with your connection id, and
   nothing else, to `https://api.harbyn.com/ingest/engine` (plus, when the workflow keeps the engine between runs, the
   SHA-256 of the copy it kept, so the same bytes are not sent again);
2. receives the fix engine and its migration recipes, or "cached" when the kept copy is the current release;
3. downloads the release manifest from `https://feed.harbyn.com/v1/engine-release.json`, checks its signature against
   the engine key pinned in `src/engine.ts` (separate from the feed key), its expiry, and the SHA-256 and size of both
   files;
4. only then runs the engine on the runner. If any check fails it runs nothing, prints a warning, and the scan result
   stands.

To keep the engine between runs (about 10 MB less per run), restore and save the runner's `harbyn-engine-cache`
directory around the Action with `actions/cache/restore` and `actions/cache/save`, keyed by the Action's
`engine-cache-key` output; the dashboard writes this workflow for you. A kept copy goes through step 3 like a
downloaded one: a changed cache fails verification and never runs. With `upload: true`, the upload also says whether
the repository let the fix open pull requests (see `docs/upload.md`), so the dashboard can tell you when GitHub's
"Allow GitHub Actions to create and approve pull requests" is off.

The engine is closed source and requires a paid plan. On a free plan the Action prints where to upgrade and opens
nothing.

### On your machine: `harbyn login`

```sh
npx harbyn login          # sign this CLI in from your browser (device code, no password in the terminal)
npx harbyn fix            # show the fixes the paid engine makes here
npx harbyn fix --write    # apply them to your files; review them with your own git
npx harbyn logout         # sign out, and revoke the sign-in
```

`login` prints a page and a code; approve the code on that page while signed in to Harbyn. The sign-in it saves
(`credentials.json` in `%APPDATA%\harbyn`, `$XDG_CONFIG_HOME/harbyn` or `~/.config/harbyn`, readable by you only) can
only fetch the engine, say whose it is, and revoke itself; it cannot read or change your account. Settings > Command
line in the dashboard lists every sign-in with its last use and signs any of them out. `fix` and `migrate` then fetch
the engine from `https://api.harbyn.com/cli/engine` with that sign-in, verify it exactly as above, and run it here:
nothing about your code leaves your machine. `scan` never reads the sign-in.

## What it does and does not do

- `scan` never writes to your project. The only file it writes is its feed cache (`%LOCALAPPDATA%\harbyn`,
  `$XDG_CACHE_HOME/harbyn` or `~/.cache/harbyn`). Only `fix --write`, which you run on purpose after `login`, edits
  your files; `login` writes its sign-in to your config directory.
- A scan makes one network request: the change feed from `https://feed.harbyn.com/v1/feed.json` and its signature.
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
