---
feature: demo
status: draft
created_at: 2026-10-14T11:25:00-03:00
---

# Demo — Acceptance Tests

> Intro blockquote.

## AT-1 — Saving shows a toast
**Validates:** US-1, Round-1 A2
**Automation:** agent
**Review:** ok

**Given** an open form
with two fields
**When** you press Save
**Then** a toast says "Saved"

**Frame:** acceptance-assets/AT-1/1.html "The form" (given)
**Frame:** acceptance-assets/AT-1/2.png "Pressing Save" (when)
**Frame:** acceptance-assets/AT-1/3.html "The toast" (then)

**Verify (human):** Fill the form and press Save.

**Verify (agent):** Drive the form in the harness:
```sh
**Then** inside a fence is not a field
---
```
**Passes when:** a toast with text Saved is visible.

**Status:** ☐ not run

---

## AT-2 — The CLI prints the version
**Validates:** US-2
**Automation:** agent
**Review:** change: also check the exit code

**Given** the CLI installed
**When** you run `demo --version`
**Then** it prints the version

**Visual requested:** a flow of the CLI

**Verify (agent):** run it.
**Passes when:** stdout matches the version.

**Status:** ☐ not run

---

## AT-3 — Untouched
**Validates:** US-3
**Automation:** human-only

**Given** x
**When** y
**Then** z

**Passes when:** z.

---

## Missing tests (review)
- nothing checks undo

## Coverage
| Story | Tests |
|---|---|
| US-1 | AT-1 |
