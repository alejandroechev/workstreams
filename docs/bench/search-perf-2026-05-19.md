# Search performance benchmark — A/B numbers

Probe: `e2e/features/repo-explorer-search-perf.mjs`
Method: 9 unawaited `search_in_files` invocations (one per character of
"interface") against `C:\Local\Code\ai-tools\workstreams` (~thousands of
files). In parallel, a `ping` IPC fires every 50 ms; we record round-trip
time per call. Each search call is preceded by `cancel_searches`
(simulating the React effect-cleanup path).

## Results — IPC ping RTT (milliseconds)

|                      | n  | mean | p50 | p95   | max    |
|----------------------|----|------|-----|-------|--------|
| **BEFORE** baseline  | 10 | 33.8 | 4.5 | 5.7   | 296.3  |
| **BEFORE** during    | 38 | 197.5| 7.8 | 1255.2| **3165.8** |
| **AFTER**  baseline  | 14 | 7.1  | 5.3 | 13.8  | 18.6   |
| **AFTER**  during    | 39 | 49.5 | 8.3 | 245.0 | **319.9** |

## Deltas

- **max RTT during typing: 3166 ms → 320 ms (10× faster, 2.8 s less freeze)**
- p95 RTT during typing: 1255 ms → 245 ms (5× faster)
- mean RTT during typing: 197 ms → 50 ms (4× faster)

## How the BEFORE was simulated

The bench-pre-fix patch (local to this run, restored via `git restore`)
disabled two parts of the fix in `search_in_files_impl`:

- The `is_cancelled` checks (cancellation walked to completion).
- The `is_text_extension` extension whitelist (file open()s for every blob).

`SEARCH_SKIP_DIRS` was left intact for both runs, so the difference
above is purely from cancellation + whitelist (the third lever in the
fix is the wider skip-dirs set, which would make the gap larger still).

## Interpretation

The user-visible "freeze" was the IPC channel being starved by
in-flight searches. A 3-second p95 stall on adjacent operations like
`write_to_pty` / `resize_pty` looks and feels like an app hang. After
the fix, the worst single stall is ~320 ms (still noticeable, but no
longer a freeze) and the median during typing is 8 ms — same as idle.

The remaining 320 ms tail comes from the still-in-flight search for the
LAST character not being cancelled (there's nothing after it to bump
the epoch). The frontend `cancelSearches` on cleanup catches the
earlier 8 characters; only the final one runs to completion. If we
wanted to push that further, we could:

1. Move the search to a Tauri command-level background task with an
   explicit handle so cancel_searches also aborts the OS read calls,
   not just the loop. (Marginal gain on Windows; `read_dir` doesn't
   block long.)
2. Use rayon to parallelize file reading across cores.

Neither was needed to fix the reported UX problem.
