# Contributing

## Commit message convention

This repo uses **[Conventional Commits](https://www.conventionalcommits.org/)** to drive automated SemVer bumps. Every push to `master` runs CI (`.github/workflows/ci-release.yml`), which reads the commit log since the last `v*` tag and decides what to do.

### Bump rules

| Commit prefix | Bump kind | Example |
|---|---|---|
| `feat:` / `feat(scope):` | **minor** | `feat(repo): add Diff tab filter` |
| `fix:` / `perf:` / `refactor:` / `chore:` / `test:` / `style:` / `build:` / `ci:` / `revert:` | **patch** | `fix(window): grant allow-destroy permission` |
| `docs:` | **none** — release is skipped entirely | `docs: update tutorial` |
| `<any-type>!:` or body contains `BREAKING CHANGE:` | **major** | `feat!: rewrite tile persistence schema` |
| Anything else (no recognised prefix) | **patch** (safe default) | — |

The **strongest** bump across the range wins. If multiple commits are batched (`fix:` + `feat:` + `docs:`), the result is a **minor** bump.

### Examples

```
v0.1.0 → fix: …                      → v0.1.1
v0.1.1 → feat: …                     → v0.2.0
v0.2.0 → docs: …                     → (no release)
v0.2.0 → docs: …    + fix: …         → v0.2.1
v0.2.0 → feat: …    + fix: …         → v0.3.0
v0.2.0 → feat!: …                    → v1.0.0
```

### What if I forget the prefix?

Unprefixed commits fall through to **patch**. That's intentional — it's safer to over-release than to miss a fix. But please use the prefixes.

### What if I'm doing a manual release?

Manual `workflow_dispatch` runs from `master` execute the test suites + build but **skip** the tag/release step. To force a specific tag, push a commit that triggers the desired bump and let CI do it.

## Source-of-truth files

- `package.json` `"version"` and `src-tauri/tauri.conf.json` `"version"` are **decorative** — they're stamped at build time from the computed tag. Don't bother bumping them by hand; the CI workflow overwrites them in the build job. Their committed value (`0.1.0` baseline) is what the dev binary reports until the first release.
- Git tags `v<major>.<minor>.<patch>` are the actual source of truth.

## Local testing

Before pushing:

```bash
npm test               # vitest (unit)
npm run test:e2e       # Playwright (in-memory backend)
npx tsc --noEmit       # type check
```

The pre-push git hook also runs Rust clippy, smart doc gate, and CDP visual validation when a Tauri dev instance is running.
