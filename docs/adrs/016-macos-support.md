# ADR 016 — macOS support (Apple Silicon, unsigned)

## Status

Accepted (2026-07-31).

## Context

Workstreams shipped Windows-only. The release workflow built NSIS/MSI
installers on `windows-latest`, and a number of runtime defaults were
hardcoded to Windows values.

Two separate questions had to be answered before adding macOS:

1. **Can it compile?** Largely yes, already. Every Rust dependency is
   cross-platform (`portable-pty`, `rusqlite` with `bundled`, `dirs`,
   `notify`), Windows-only code was already `cfg`-gated, and `is_pid_alive`
   already had a `#[cfg(not(windows))]` implementation using `libc::kill`.
   Critically, CI already runs `cargo test --lib` on `ubuntu-latest`, so the
   Unix code paths were compiling and passing tests on every push.

2. **Would it *work*?** No. Several defaults were Windows-bound and would
   have produced a `.dmg` that builds but fails at runtime:
   - `pty.rs` defaulted the shell to `pwsh.exe`, which does not exist on
     macOS. Worse, the tile-restore path *persisted* `pwsh.exe` into tile
     config and replayed it on the next launch.
   - `C:\` was used as the fallback `cwd` in several places.
   - `SessionMetaTile` built paths by concatenating with `\`.
   - The WSL tile and the "PowerShell" label are meaningless on macOS.

Path *reading* was already portable — the codebase consistently splits on
`[\\/]` — so only construction and defaults needed work.

## Decision

**Ship macOS as an experimental, Apple-Silicon-only, unsigned build**, and fix
the portability blockers behind a single platform module.

### Platform module

`src/domain/platform.ts` centralises platform branching for the frontend:

| Helper | Windows | macOS / Linux |
| --- | --- | --- |
| `pathSeparator()` | `\` | `/` |
| `defaultRootDir()` | `C:\` | `/` |
| `defaultTerminalCommand()` | `pwsh.exe` | `null` |
| `supportsWsl()` | `true` | `false` |
| `terminalTileLabel()` | `PowerShell` | `Terminal` |
| `shortcutLabel(k)` | `Alt+<k>` | `⌥<k>` |
| `joinPath(base, ...segs)` | joins with `\` | joins with `/` |

Detection reads the WebView user agent, which works across WebView2,
WKWebView and WebKitGTK without adding a Tauri plugin or permission. When the
user agent is unreadable it reports **Windows**, preserving historical
behaviour rather than silently switching separators.

`joinPath` normalises separators *inside* each segment, because relative paths
are persisted in SQLite and may have been captured on a different platform — a
stored `features\a` must not leak a backslash into a Unix path.

### Shell resolution

`defaultTerminalCommand()` returns `null` on Unix so that **nothing is
persisted**, and the Rust side resolves the shell at spawn time:

```rust
#[cfg(unix)]
fn default_shell() -> String { resolve_unix_shell(std::env::var("SHELL").ok()) }
```

`resolve_unix_shell` only trusts an absolute path, falling back to `/bin/zsh`
(the macOS default since Catalina). It is split out from `default_shell` so the
fallback logic is unit-testable without mutating process-global env state.

Persisting the shell would have been replayed verbatim on restore, so keeping
it unset is what makes tile restore work across platforms.

### Keyboard shortcuts

App shortcuts are `Alt+<letter>`, typed as `Option+<letter>` on a Mac. macOS
applies its special-character layer *before* dispatching the event, so
`Option+T` arrives as `key === "†"`, `Option+C` as `"ç"`, and so on — matching
on `event.key` meant **every tile shortcut silently did nothing** on macOS.

`parseKeyAction` now resolves the letter through `shortcutKey`, which prefers
the layout-independent `event.code` (`"KeyT"`) whenever Alt is held and falls
back to `event.key` otherwise. Windows/Linux matching is unchanged, and the
Monaco-focus guard keys off the same resolved letter so `Option+T` still does
not create a tile while the user is typing in the editor.

Displayed shortcut hints go through `shortcutLabel`, because a Mac keyboard
has no key labelled "Alt".

### Release pipeline

A `build-macos` job on `macos-latest` builds `--target aarch64-apple-darwin`
and publishes a `.dmg` plus a zipped `.app`. `publish-release` now depends on
both platform jobs.

## Consequences

- macOS runners are **free** for this public repo, so the extra job costs
  nothing but wall-clock time on a manual, infrequent workflow.
- The build is **not code-signed or notarised**, so Gatekeeper blocks first
  launch; the release notes and README document the right-click → Open and
  `xattr -dr com.apple.quarantine` workarounds. Signing needs a paid Apple
  Developer account and secrets, which is out of scope.
- **Apple Silicon only.** Intel Macs would need `x86_64-apple-darwin` (or a
  universal binary), which roughly doubles build time; Apple Silicon covers
  every Mac sold since 2020.
- **No macOS job was added to `ci.yml`.** The existing `ubuntu-latest` Rust
  job already compiles and tests the `cfg(unix)` paths on every push, so the
  marginal value did not justify doubling CI wall time. A macOS-specific
  compile break would surface at release time.
- The Copilot CLI itself must be installed on the Mac; the app orchestrates it
  but does not bundle it.
- Windows behaviour is byte-identical: every helper returns the previous
  hardcoded value when `isWindowsPlatform()` is true.
