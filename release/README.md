# harbyn

Finds the places in your code that a vendor's upcoming change will break. It looks for retired or retiring model IDs,
pinned API versions, vendor SDKs and API hosts, then matches them against a signed feed of vendor changes:

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

Dependabot tracks package versions. This tracks what your code _does_ with the vendor: the model it asks for, the
API version it pins, the endpoint it calls.

## Use

```sh
npx harbyn scan            # scan the current directory
npx harbyn scan path/to/repo --json
npx harbyn scan --ci       # exit code 1 when code is affected, for CI
```

| Option             |                                                                 |
| ------------------ | --------------------------------------------------------------- |
| `--json`           | machine-readable output                                         |
| `--ci`             | exit 1 when there are findings in code                          |
| `--all`            | also list low-confidence findings (tests, docs, model catalogs) |
| `--ignore <glob>`  | extra ignore pattern, repeatable                                |
| `--include-nested` | also scan nested git repositories                               |
| `--no-gitignore`   | do not honour `.gitignore` files                                |
| `--offline`        | use the cached feed, make no network request                    |
| `--version`        | print the version                                               |

`.gitignore` and `.harbynignore` (same syntax) are honoured.

Exit codes: `0` done, `1` findings with `--ci`, `2` the feed could not be verified (nothing is reported), usage errors.

## What it does and does not do

- **Read-only.** It never writes to your project. The only file it writes is its feed cache (`%LOCALAPPDATA%\harbyn`,
  `$XDG_CACHE_HOME/harbyn` or `~/.cache/harbyn`).
- **Nothing about your code leaves your machine.** The one network request is the download of the change feed from
  `https://feed.harbyn.com/v1/feed.json` and its signature. There is no telemetry.
- **Secrets are never opened.** `.env` files (except `.env.example` and similar), private keys, `.npmrc`, `.netrc` and
  credential files are skipped without being read.
- **The feed is verified before it is used.** It is signed, and the signature is checked against keys pinned inside
  this file. It carries an expiry date, and a feed older than one already accepted on this machine is rejected. If
  anything fails, the scan reports nothing and exits 2, because a report built on data we cannot trust is worse than
  no report.
- **One file, no dependencies, no install scripts.** Everything is bundled into `harbyn.mjs` and left unminified so
  you can read it. The bundled open-source packages are listed in `THIRD_PARTY_NOTICES.md`.

## License

Apache-2.0. The change feed it downloads is a separate service with its own terms.
