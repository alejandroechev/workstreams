# Contributing to Workstreams

This file covers **how to get a change accepted**. For how to build, run and
test the app, see the [contributor guide](docs/contributor-guide.md); for why
the app is shaped the way it is, see the [decision records](docs/adrs/).

## Expectations first

Workstreams is a personal tool developed in the open. It is not a community
project with a roadmap or a support commitment, and it is maintained by one
person alongside other work.

That has a practical consequence worth stating plainly: **issues and pull
requests may not be reviewed, and may be closed without a detailed
explanation.** That is not a judgement on your contribution. If you need a
change for your own use, forking is a perfectly reasonable answer and you do not
need permission.

## Before opening a pull request

**Open an issue first for anything non-trivial.** For a bug, reproduction steps
are always welcome. For a feature, describe the problem you hit before proposing
a solution — it may already be solvable, or may not fit the app's shape. A
rejected PR is a worse outcome for you than a short conversation.

Small, obviously-correct changes — a typo, a broken link, a crash with a clear
cause — can go straight to a pull request.

## What is unlikely to be merged

- Anything achievable with a repository script or an existing skill instead of
  app code.
- Features whose complexity outweighs the number of people who would use them.
  This is a subjective call, and the maintainer makes it.
- Large refactors, or reformatting that does not change behaviour.
- Non-trivial changes with no tests.
- New dependencies that duplicate something already in the tree.
- Changes that contradict an accepted [ADR](docs/adrs/) without engaging with
  the decision. Disagreeing with an ADR is legitimate; ignoring it is not.

## Using AI to write contributions

**AI-assisted contributions are welcome.** This app exists to run coding agents,
so a rule against agent-written code would be self-defeating.

The expectations are the same as for anything else: you understand the change,
you can explain why it is correct, and it carries tests. Submitting a diff you
have not read is the one thing that will get a PR closed quickly, because
reviewing it then costs more than writing it would have.

Please mention in the PR description if an agent wrote most of it. That is
useful context, not a mark against it.

The caveat above applies with extra force here. Generating a PR is now cheap and
reviewing one is not, so **there is no guarantee your PR will be reviewed or
considered** — and volume makes that more likely, not less.

## Making the change

Most of this is enforced automatically by the git hooks:

- **Tests are not optional.** Every source file needs a matching test — see the
  [test pyramid](docs/contributor-guide.md#test-pyramid). Write the failing test
  first where you can.
- **Keep the diff scoped.** One change per pull request. Unrelated fixes,
  however correct, make review harder and will be asked for separately.
- **Follow the file you are editing.** Match its existing patterns rather than
  introducing a new style.
- **User-visible text is English**, and icons come from Heroicons rather than
  emoji.
- **Never signal state through colour alone.**
- **Write an ADR** for a decision that constrains later work, and update the
  README or `docs/` when behaviour changes.
- **Add a `CHANGELOG.md` entry** under `[Unreleased]` for anything a user would
  notice. Release notes are built from it.

Do not weaken, skip or delete a test to make the suite pass, and do not lower
the coverage threshold. If you think a check is wrong, say so in the PR — that
is a legitimate finding, not an excuse.

`git commit --no-verify` and `git push --no-verify` bypass the hooks. Do not use
them without explaining why in the pull request.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/),
because the release version is computed from them:

```
feat(repo): add Diff tab filter
fix(window): grant allow-destroy permission
docs: update the tutorial
feat!: rewrite tile persistence schema
```

`feat:` produces a minor bump, most other prefixes a patch, and `!` or a
`BREAKING CHANGE:` body a major. The full table is in the
[contributor guide](docs/contributor-guide.md#bump-rules-when-auto-computing).

## Pull request hygiene

- Describe what changed and why. Link the issue if there is one.
- Include a screenshot or short clip for a visible change.
- Say how you tested it beyond the automated suite.
- **Keep at most two open pull requests at a time.** A stack of simultaneous
  PRs tends to rot against a moving `master`.

CI is the authoritative gate and runs every check the local hooks run, plus the
full browser suite and the Rust tests. A red run will not be merged.

## Reporting bugs

Use the [issue templates](https://github.com/alejandroechev/workstreams/issues/new/choose).
The app version, your OS, and the relevant log output are the three things that
make a report actionable; without them a report usually cannot be acted on.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
