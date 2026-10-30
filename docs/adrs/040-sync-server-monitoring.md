---
id: "040"
status: Accepted
date: 2026-10-30
---

# ADR 040: Monitoring the sync server from Workstreams

## Status

Accepted (2026-10-30).

## Context

Every local-first app (the phone companion, Pagos+, ScratchPad, …) syncs
through one self-hosted SyncEngine server on a 1 GB VPS. On 2026-10-30 it went
down in four ways in one day:
- a client re-uploaded a document with 15M operations, and the server sat at
  400% CPU with `/health` timing out;
- `devices.json` was emptied, so every login was refused while `/health` still
  answered;
- the box was deep in swap;
- the companion document had grown to 5 MB.

Nothing noticed until the phone showed the laptop offline. Of the four, the
public `/health` shows only the first.

## Decision

**The server reports vitals.** SyncEngine gains `GET /health/vitals` behind its
own `MONITOR_KEY`, separate from `ADMIN_KEY`; it opens nothing else and answers
503 when unset. It returns:
- the box's CPU and memory/swap (from `/proc`), and the server process's own
  CPU and memory;
- disk free on the data volume;
- WebSocket logins rejected in the last 5 minutes;
- storage totals;
- the 20 largest documents, with their app (from `apps.json`) and growth over
  the last day (sampled hourly).

**Workstreams watches while it runs.** Every 2 minutes, when a sync server is
configured (the companion's server URL), the native side (`sync_monitor.rs`)
checks `/health`, with a 10 s timeout. With a monitor key it also reads the
vitals. It keeps 24 hours of checks in SQLite.

The rules live in TypeScript (`src/domain/sync-monitor.ts`), so the in-memory
backend and the E2E tests use the same rules. These are the problems:

| Problem | When (defaults, editable) | Severity |
| --- | --- | --- |
| unreachable | `/health` fails or takes over 5 s on 2 checks in a row | critical |
| cpu | over 80% on 3 checks in a row | critical |
| memory | under 100 MB available, or swap over 50% | critical |
| disk | under 2 GB free | critical |
| logins | over 20 refused in 5 minutes | critical |
| doc_size | a document over 2 MB, naming its app | warning |
| doc_growth | a document that grew over 1 MB in a day | warning |

A gap of over 6 minutes between checks (the laptop slept) breaks a run, so
sleep isn't counted as failure. Values exactly at a threshold don't alert.

**Alerts happen once.** A problem that starts records a *started* event, and one
that clears records a *resolved* event. Each event becomes an Inbox entry under
**Sync server**, with a "what to check" hint, and a desktop notification
(`tauri-plugin-notification`). Nothing repeats while the problem lasts. A kind
can be muted for 24 hours: while it's muted the problem is still tracked, but
nothing is recorded or notified.

**What you see:**
- A dot in the sidebar footer shows the state: grey when no server is
  configured, green when healthy, yellow for a warning, red for a critical
  problem.
- The dot opens the **Sync server** panel: reachability, vitals, 24-hour
  sparklines, the largest documents by app, open problems with *Mute 24 h*,
  recent alerts, and the settings (monitor key and thresholds).
- Agents get `sync.status`, `sync.history [hours]` and
  `sync.mute kind=<kind> hours=<n>`.

## Consequences

- **Watched only while Workstreams runs:** nothing watches while the laptop is
  closed (no server-side history, no external uptime check).
- **Never the phone:** it depends on the same server it would warn about.
- **No remediation:** the app explains what to check; it doesn't restart
  anything.
- **Two CPU figures:** in Docker, `/proc/stat` shows the whole box, while the
  process figure is the server alone, as a share of one core. The rules use
  the box figure.
- **Growth baseline:** document growth needs a day of samples. Until then it is
  measured from the server's first sample since it started.

## References

- [ADR 033: Phone companion](033-phone-companion.md) (the sync server it relies on)
- [ADR 038: Pipeline notifications](038-pipeline-notifications.md) (the Inbox)
