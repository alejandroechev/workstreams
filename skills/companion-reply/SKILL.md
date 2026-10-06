---
name: companion-reply
description: 'Send progress updates and the final result to the user''s phone, from a Copilot session that the Workstreams phone companion started. Uses the `workstreams agent` CLI over a local socket; no MCP, no network setup, no secrets. Only works inside a Workstreams session tile started from the phone, gated on $WORKSTREAMS_SOCKET. Trigger phrases - "send me the result", "use the companion-reply skill", "reply to my phone", "send it to my phone", "/companion-reply".'
---

# Reply to the phone (agent side)

The user started this session from the **Workstreams companion app** on their
phone and asked you to send the result back. You send messages with one
command; Workstreams delivers them to the phone, which shows them under this
session. You never name the session, and you need no URL, token or secret:
the app knows which session is calling.

## First: are you inside Workstreams?

```sh
[ -n "$WORKSTREAMS_SOCKET" ] && echo inside || echo outside
```

If that prints `outside`, you cannot reach the phone. Do the task and give the
result in the terminal.

## What to send

- **`result`** — the answer to what the user asked. Send exactly **one**, when
  you are done, written so it reads well on a phone: lead with the answer,
  then the details. Markdown is rendered (headings, lists, code, links).
- **`progress`** — optional short updates for long tasks ("Tests are running,
  about 5 minutes"). At most a few; none for quick tasks.

Each message is at most **20000 characters**. If the full result is longer,
send a summary as the `result` and say where the rest is (a file path in the
workspace).

## How to send

Always pass the text on stdin with `text=@-` and a quoted heredoc, so quotes,
`$` and newlines arrive exactly as written:

```sh
workstreams agent call companion.send kind=result text=@- <<'END_OF_RESULT'
## 3 open PRs need you

1. **#812** Fix the encoder crash — approved, waiting on CI
2. **#815** Telemetry rename — 2 comments to answer
3. **#820** New dashboard — not started
END_OF_RESULT
```

A progress update:

```sh
workstreams agent call companion.send kind=progress text=@- <<'END_OF_UPDATE'
Reading the PRs, 2 of 3 done.
END_OF_UPDATE
```

A successful send prints `{"ok":true,...,"sent":true}` on stdout.

## When sending fails

Nothing is ever queued: a message that was refused is lost. If the command
fails, **give your result in the terminal instead**, and mention why the phone
did not get it.

| Code | Meaning |
| --- | --- |
| `NOT_A_PHONE_SESSION` | This session was not started from the phone. Answer in the terminal. |
| `COMPANION_OFF` | The user turned the phone companion off. Answer in the terminal. |
| `BAD_MESSAGE` | Wrong kind, empty text, or more than 20000 characters. Fix it and send again. |
| `MISSING_PARAM` | `kind` was not given. Add `kind=result` or `kind=progress`. |
| exit code 3 or 4 | Workstreams is not running, or this is not a Workstreams session. Answer in the terminal. |
