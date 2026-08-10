/**
 * Point `@monaco-editor/react` at the locally-bundled Monaco.
 *
 * `@monaco-editor/react` defaults to loading Monaco from
 * `cdn.jsdelivr.net` at runtime. For a desktop app that is wrong twice over:
 * the editors silently fail with no network (or behind a firewall that blocks
 * the CDN), and we already ship the whole of Monaco in the bundle, so the
 * download is redundant.
 *
 * Symptom when it bites: `Editor`/`DiffEditor` never mount, the surrounding
 * tile renders its chrome but no code, and the console shows
 * `ERR_SOCKET_NOT_CONNECTED` followed by "Monaco initialization: error".
 * Components that go through {@link loadMonaco} are unaffected, which is why
 * only the diff-based views break — a confusing split that this removes.
 *
 * ## Where this is (and is not) wired
 *
 * Currently applied only on the **harness** path, which mounts an editor
 * immediately and is therefore the one place that reliably breaks without a
 * reachable CDN.
 *
 * It is deliberately *not* called during app bootstrap: `loadMonaco()` pulls
 * in ~3.7 MB, and doing that eagerly measurably slows dev startup (enough to
 * push the Repo Explorer content-search E2E past its timeout). Wiring the real
 * app off the CDN wants a lazier hook — configuring just before the first
 * `Editor`/`DiffEditor` renders — which is a separate change to those tiles.
 */
import { loader } from "@monaco-editor/react";

import { loadMonaco } from "./loadMonaco";

let configurePromise: Promise<void> | null = null;

export function ensureLocalMonacoLoader(): Promise<void> {
  if (configurePromise === null) {
    configurePromise = loadMonaco()
      .then((monaco) => {
        loader.config({ monaco });
      })
      .catch(() => {
        // Leave the default CDN path in place rather than breaking the editors
        // outright; this is a best-effort improvement, not a hard requirement.
      });
  }
  return configurePromise;
}

/** Test-only: forget that configuration was attempted. */
export function _resetMonacoLoaderConfigForTests(): void {
  configurePromise = null;
}
