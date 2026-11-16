---
id: "042"
status: Accepted
date: 2026-11-16
---

# ADR 042: The Rust Pocket learning service

## Status

Accepted (2026-11-16).

## Context

Rust Pocket is a phone micro-learning app for Rust (its own repository,
`alejandroechev/rust-pocket`). Its exercises need a real compiler, which the
phone doesn't have. The learner chose Workstreams on the Mac as the place that
compiles and tests answers, through a service of its own — not ordinary
companion conversations (ADR 033), which stop and resume Copilot sessions and
would let a chat prompt run commands. The first build used a development Node
bridge on localhost; this replaces it.

## Decision

**A native learning module in Workstreams.**

- `learning_runner`: compiles and tests one answer. It runs only fixed
  commands — `rustc --edition=2021 --test` for std cards, `cargo test --offline
  --locked` with a pinned Serde manifest and lockfile (bundled at build time) for
  Serde cards — in a new per-job directory that is removed afterwards. Compile
  timeouts are 30 s (std) and 120 s (Serde), runs 10 s, output 16,000
  characters, answers 20,000 characters. A timeout kills the job's whole process
  group. The content's toolchain (default Rust 1.98.0) is checked first; any
  other toolchain is an error, not a result.
- **The harness travels with each request.** A check carries the card's harness
  (before/after code, named test cases, declared constraints, Serde flag), the
  answer and the content version. Workstreams keeps no copy of the content, so a
  generated pack needs nothing on the Mac, and every result is graded by the
  version it names.
- **Results are itemized.** Each named test and each declared constraint
  (`forbid` patterns over the answer) has its own outcome. Only an advertised
  constraint can fail behaviorally correct code (`constraint_failed`).
- **A job ledger** (`learning_jobs` in `workstreams.db`), keyed by the attempt
  id: a retried request returns the same job; the same id with other content is
  refused. One worker thread claims queued jobs and compiles **without** holding
  the database lock. A job left running when the app stopped is marked
  `interrupted` on the next start and never rerun on its own; the learner sends
  a new attempt.
- **Trusted local execution.** The per-job directories are not a sandbox: code
  runs with the user's permissions, as the learner chose.
- **Agents**: `learning.check request=@-` queues a check and returns the job;
  `learning.jobs [id=]` lists jobs or returns one with its result. There is no
  desktop learning UI.

Pairing and the relay transport are added by later amendments.

### Amendment (2026-11-17): the tutor

- **Help requests are jobs too.** The ledger holds two kinds, `check` and
  `help`, with the same attempt-id keying, retry and interruption rules. Older
  rows without a kind are read as checks.
- **`learning_ai`** answers a help request (level `nudge`, `hint` or
  `solution`; the exercise, the learner's answer, the card summary and the last
  compiler diagnostic) with one `copilot -p` call that has **no tools**: no
  shell, no file writes, no built-in MCP servers, no custom instructions, and no
  questions back. It runs in an empty temporary folder that is removed
  afterwards, with a 90 s timeout. The job's result is `{reply, error}`; a
  failure is an error the phone can show, never a thrown job.
- **Agents**: `learning.help request=@-` queues a help request; its reply is
  read with `learning.jobs`, like a check.

## Consequences

- The development Node bridge stays in rust-pocket for its own tests only.
- Serde checks need the pinned crates in the local cargo cache; without them the
  check reports an infrastructure error rather than a compile error.
- Its tests run in Workstreams CI; the Serde build test is ignored there.
- The tutor needs the Copilot CLI on the Mac's `PATH`; tests use a fake
  assistant, never a real model.

## References

- [ADR 033: Phone companion](033-phone-companion.md)
