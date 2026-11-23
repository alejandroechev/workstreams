---
name: companion-reply
description: 'Send progress updates and the final result to the user''s phone, from any Copilot session in a Workstreams tile — one the phone companion started or messaged, one started on the laptop, or a periodic (scheduled) run. Uses the `workstreams agent` CLI over a local socket; no MCP, no network setup, no secrets. Works inside any Workstreams session tile while the phone companion is on, gated on $WORKSTREAMS_SOCKET. Trigger phrases - "send me the result", "use the companion-reply skill", "reply to my phone", "send it to my phone", "/companion-reply".'
---

# Reply to the phone (agent side)

The user wants the result on their phone, in the **Workstreams companion
app**. This works from any Copilot session in a Workstreams tile: one the phone
started or messaged, one started on the laptop, or a periodic (scheduled) run.
You send messages with one command; Workstreams delivers them to the phone,
which shows them under this session. A session the phone never saw gets its
own thread on its first message, named after its tile, and the user can reply
to it from the phone. You never name the session, and you need no URL, token
or secret: the app knows which session is calling.

This is for the phone only. For the Workstreams Inbox on the laptop, use the
`ws-message` skill instead.

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
| `COMPANION_OFF` | The user turned the phone companion off. Answer in the terminal. |
| `SESSION_RELINKED` | The user linked this tile to another Copilot session while you kept running; you can no longer reach the phone. Answer in the terminal. |
| `NOT_A_SESSION` | This is not a Copilot session tile (a plain terminal, say). Answer in the terminal. |
| `RATE_LIMITED` | This session already sent 20 messages to the phone in the last hour. Put the rest in the terminal, or wait. |
| `BAD_MESSAGE` | Wrong kind, empty text, or more than 20000 characters. Fix it and send again. |
| `MISSING_PARAM` | `kind` was not given. Add `kind=result` or `kind=progress`. |
| exit code 3 or 4 | Workstreams is not running, or this is not a Workstreams session. Answer in the terminal. |
