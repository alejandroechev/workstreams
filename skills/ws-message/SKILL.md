---
name: ws-message
description: 'Send the user a message in the Workstreams Inbox once something happens, from a Copilot session running inside Workstreams. Uses the `workstreams agent` CLI over a local socket; no MCP, no secrets. Only works inside a Workstreams session tile, gated on $WORKSTREAMS_SOCKET. Trigger phrases - "/ws-message", "send me a ws-message", "message me in the inbox when…", "tell me in Workstreams when…", "ping me in the inbox when this finishes".'
---

# Message the user's Inbox (agent side)

The user asked you to tell them, through the **Workstreams Inbox**, when
something happens: tests finish, a deploy lands, a long job ends, a condition
becomes true. You send the message with one command; it shows up in the Inbox
under this session's workstream, and clicking it brings the user back here.
You never name the session, and you need no URL, token or secret.

## First: are you inside Workstreams?

```sh
[ -n "$WORKSTREAMS_SOCKET" ] && echo inside || echo outside
```

If that prints `outside`, you cannot reach the Inbox. Say so, do the task, and
give the result in the terminal.

## The one rule

**Every request ends in exactly one message.** Send it when:

- the thing happened — say what happened and the outcome;
- it failed — say what failed and why;
- you stopped waiting (gave up, timed out, hit something you can't get past) —
  say that you stopped and why.

Never leave the user waiting in silence, and don't send progress updates: one
final message per request.

How you wait is up to you: use your own background waits, polling or
scheduling. Keep working on anything else you were asked meanwhile.

## What to send

- **`level`** — `done` (it happened, all good), `needs-you` (it happened and the
  user must decide or act), `error` (it failed or you gave up), or `info`.
- **`title`** — one line, at most 120 characters. Lead with the outcome:
  "Benchmarks finished: p95 38 → 21 ms", not "Update".
- **`body`** — optional markdown, at most 20000 characters: details, numbers,
  file paths, what you recommend next. If it would be longer, summarize and
  point to a file in the workspace.

## How to send

Pass the body on stdin with `body=@-` and a quoted heredoc, so quotes, `$` and
newlines arrive exactly as written:

```sh
workstreams agent call inbox.message level=done title='Benchmarks finished: p95 38 → 21 ms' body=@- <<'END_OF_MESSAGE'
## Results

- p50: 12 → 9 ms
- p95: 38 → 21 ms

Full report in `bench/out.md`.
END_OF_MESSAGE
```

A message without a body:

```sh
workstreams agent call inbox.message level=error title='CI failed on 3c6a722: clippy in agent_registry.rs'
```

A successful send prints `{"ok":true,...}` with the stored message on stdout.

## When sending fails

Nothing is queued: a refused message is lost. Fix it and send again, or give
the message in the terminal.

| Code | Meaning |
| --- | --- |
| `BAD_MESSAGE` | Unknown level, missing or over-long title, or a body over 20000 characters. Fix it and send again. |
| `RATE_LIMITED` | This session sent 20 messages in the last hour. Wait, or combine them into one. |
| `NOT_A_SESSION` | The caller isn't a Copilot session in Workstreams. Answer in the terminal. |
| exit code 3 or 4 | Workstreams is not running, or this is not a Workstreams session. Answer in the terminal. |
