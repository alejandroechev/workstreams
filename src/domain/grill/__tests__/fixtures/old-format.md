# Grill-Me: Agent → phone messages (Workstreams companion)

> **Instructions:** Answer inline under each question (a letter, "reco", or free
> text). Use the **Recommendation** as the default if you don't want to decide.
> Tell me **"review"** when a batch is ready.
>
> **Status:** Converged.
>
> **Grounding:**
> - **Agent channel exists (ADR 019-ish, `agent_socket.rs` + `agent_registry.rs`).** Every Copilot session tile gets
>   `$WORKSTREAMS_SOCKET` and an app-issued token; `workstreams agent call <command>` reaches named
>   commands (`ws.get`, `ws.create`, `diff.order.set`, …). The app already knows **which tile** is calling,
>   so the agent never has to name its session — the same pattern the `diff-order` skill uses.
> - **Skills live in `~/.copilot/skills/<name>/SKILL.md`** (`ws`, `diff-order` exist). A prompt can
>   reference one by name or `/skill-name`.
> - **Phone sessions are created by the laptop executor** (`startSessionForCompanion` in `App.tsx`): it
>   creates the tile, so the laptop can record "this tile came from phone request X" at that moment. The
>   Copilot session id is only linked to the tile later.
> - **Companion document (ADR 033):** `laptop` and `outcome` have a single writer (the laptop); the phone
>   only adds signed `requests`. Both apps check `schemaVersion === 1` strictly, so a bump to 2 locks out
>   every installed phone until it updates. An additive optional key can stay at v1.
> - The phone already shows per-request outcomes (toasts, badges); there is no per-session view yet.

---

## A. Shape of the feature

### A1. Direction for the MVP
(a) **Agent → phone only.** The agent sends results; the phone reads them. Replying from the phone is
"start another session" or a later feature.
(b) Two-way: the phone can also reply into the running session (types into the terminal).

**Recommendation:** (a). Two-way means writing into a live PTY from a remote device — a much bigger
security and UX question. Your stated MVP is "do x and send me back the result".

**Answer:** a)

---

### A2. Who writes messages into the shared document
(a) **The laptop app**, on the agent's behalf: the agent calls `workstreams agent call companion.send …`
over the local socket; the app writes the message into the document.
(b) The agent writes to the sync server directly (it would need the doc URL, token and its own Automerge
client).

**Recommendation:** (a). It keeps the laptop the document's only writer outside `requests`, needs no
secrets in the agent's environment, and reuses the channel that already knows which session is calling.

**Answer:**

---

### A3. Which sessions may send
(a) **Only sessions the phone started** (tiles created by a phone `create`/`session` request). Any other
session calling the command gets a clear "this session wasn't started from the phone" error.
(b) Any session, shown on the phone under its workstream.

**Recommendation:** (a) for the MVP. It matches "read the messages for a session created by the app",
keeps the phone's view small, and means a stray agent elsewhere can't push to your phone.

**Answer:** a)

---

## B. Tracking phone sessions

### B1. What identifies a "phone session"
(a) **The tile**: when the executor creates the Copilot tile for a phone request, it records
`{ tileId, workstreamId, requestId, prompt, createdAt }`. The agent's token already maps to the tile.
(b) The Copilot session id (linked later, may be missing for a while, changes on `--resume` of a different
session).

**Recommendation:** (a). It exists the moment the session starts and is what the agent channel already
authenticates.

**Answer:** a)

---

### B2. Where the laptop keeps that record
(a) **SQLite** (a small `companion_sessions` table, or a flag in the tile's config), published into the
document as part of `laptop`.
(b) Only in the document.

**Recommendation:** (a). The laptop needs it to authorise `companion.send` even if the document is
offline or wiped; the document is just the published copy.

**Answer:** a)

---

### B3. What the phone shows for each phone session
Pick what the list/detail needs: prompt (first line as title), workstream name, started time, status
(running / exited), message count, unread dot.

**Recommendation:** Title = first line of the prompt, plus workstream name, started time, unread count.
Running/exited status is nice but needs tile-lifecycle tracking — defer unless you want it.

**Answer:** reco

---

### B4. Where sessions live in the phone UI
(a) **A session list inside each workstream**: tapping a row opens the workstream's detail screen
(sessions + "New session" button) instead of the prompt sheet directly.
(b) A separate **Messages** tab listing all phone sessions across workstreams, newest first.
(c) Both.

**Recommendation:** (b) for the MVP: one inbox-style list is what you'll check after "do x and send me
back the result", and it doesn't change how tapping a workstream works today.

**Answer:** b)

---

## C. The message itself

### C1. Message content
(a) **Markdown text**, rendered on the phone, capped (e.g. 20 000 chars, like prompts).
(b) Plain text only.
(c) Text plus attachments (files, images).

**Recommendation:** (a). Agents naturally answer in markdown; attachments need the blob store and are a
later feature.

**Answer:** a)

---

### C2. Message kinds
(a) **Just "message"** — free text.
(b) A small set: `result` (final answer), `progress` (intermediate update), `question` (agent is blocked
and needs you — but with one-way messaging you can't answer from the phone yet).

**Recommendation:** (b) with only `result` and `progress` in the MVP: the skill tells the agent to send
one `result` at the end and optional `progress` updates; the phone marks the session "done" on a result.
Skip `question` until replies exist.

**Answer:** reco

---

### C3. Notifications on the phone
(a) **None in the MVP**: unread badges inside the app.
(b) Android system notifications when a message arrives (only while the app is running/backgrounded).
(c) Push notifications even when the app is closed (needs a push service — FCM — not just the sync server).

**Recommendation:** (a) now, (b) as the immediate follow-up. (c) is a separate infrastructure decision.

**Answer:** reco

---

### C4. Retention
How long messages stay in the document (it syncs to the phone and grows its history).

**Recommendation:** Same as requests: prune sessions and their messages 3 days after the last message;
keep at most the latest 50 messages per session.

**Answer:** reco

---

## D. The skill and the prompt

### D1. How the skill gets into the prompt
(a) **You type it**: e.g. "Summarise the open PRs. /companion-reply" — the skill is only used when you
reference it.
(b) **The laptop adds it automatically** to every phone-started session (a short preamble telling the
agent it can reply to your phone).
(c) A toggle on the phone's prompt sheet, "Send me the result", on by default, that appends the reference.

**Recommendation:** (c). Explicit, one tap, and the laptop never silently rewrites your prompt; the phone
appends a fixed suffix like `\n\nWhen done, use the companion-reply skill to send me the result.`

**Answer:** c)

---

### D2. Skill name and home
(a) **`companion-reply`** in `~/.copilot/skills/`, versioned in the Workstreams repo like `diff-order`
(installed alongside it).
(b) Another name.

**Recommendation:** (a). Same distribution as the existing agent skills.

**Answer:** a)

---

### D3. What happens if the agent calls it outside a phone session, or the companion is off
**Recommendation:** The command fails with a clear message ("this session wasn't started from your
phone" / "the phone companion is turned off"), and the skill tells the agent to tell you in the terminal
instead. Messages are never queued silently for later.

**Answer:** reco

---

## E. Protocol and compatibility

### E1. Document versioning
(a) **Additive at schemaVersion 1**: a new optional `sessions` key the laptop writes; the 0.2 phone app
ignores it, the new phone app reads it.
(b) Bump to schemaVersion 2 (old phones show "Update the companion app").

**Recommendation:** (a). Nothing existing changes meaning, so there's no reason to lock out the current
APK; update ADR 033 and the shared protocol module (with fixtures) in both repos.

**Answer:** reco

---

### E2. Read state ("unread")
(a) **Phone-local** (stored on the phone only).
(b) Synced in the document (the phone writes "read up to message N") — breaks "the phone only writes
signed requests".

**Recommendation:** (a). One phone, and it keeps the document's writer rules intact.

**Answer:** reco

---

## Z. Non-functional requirements

### Z1. Any non-functional requirements?
Performance, scale, security, accessibility, compatibility, operability.
Leave blank if none matter — most features genuinely have none worth stating.

**Recommendation:** none unless something specific worries you. One candidate: "a message appears on the
phone within 10 s of the agent sending it while both are online".

**Answer:** reco

---

## When you're done
Tell me **"review"** (or **"review and after-grill"** to act immediately after).

## Decisions (converged)

- **A1** One-way, agent → phone. No replies from the phone in the MVP.
- **A2** (blank → recommendation) The laptop writes messages on the agent's behalf: the agent calls
  `workstreams agent call companion.send …` over the local socket. No secrets in the agent's environment.
- **A3** Only sessions the phone started may send; any other session gets a clear error.
- **B1** A phone session is identified by its tile, recorded when the executor creates it:
  `{ tileId, workstreamId, requestId, prompt, createdAt }`.
- **B2** Kept in SQLite on the laptop, published into the document.
- **B3** The phone shows title (first line of the prompt), workstream name, started time, unread count.
  Running/exited status deferred.
- **B4** A separate **Messages** list of all phone sessions, newest first.
- **C1** Markdown text, rendered on the phone, capped at 20 000 characters.
- **C2** Kinds `result` and `progress`; a `result` marks the session done on the phone. No `question`.
- **C3** No notifications in the MVP; unread badges in the app. Android notifications next.
- **C4** Prune sessions and their messages 3 days after the last message; at most 50 messages per session.
- **D1** A "Send me the result" toggle on the phone's prompt sheet, on by default, appends a fixed
  reference to the skill. The laptop never rewrites prompts.
- **D2** Skill `companion-reply` in `~/.copilot/skills/`, versioned in the Workstreams repo like `diff-order`.
- **D3** Outside a phone session or with the companion off, the command fails with a clear message and
  the skill tells the agent to answer in the terminal. Nothing is queued.
- **E1** Additive at schemaVersion 1 (new optional `sessions` key); ADR 033 and the shared protocol module
  and fixtures updated in both repos.
- **E2** Read state is phone-local.
- **Z1** None.
