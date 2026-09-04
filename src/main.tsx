import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BackendProvider } from "./backend/context";
import { TauriBackend } from "./backend/tauri-backend";
import { MemoryBackend } from "./backend/memory-backend";
import { applyDemoSeed, type DemoMemorySeed } from "./backend/demo-seed";
import type { Backend } from "./backend/types";
import { _setFeatureFlagOverrideForTests } from "./domain/feature-flags";
import { ensureLocalMonacoLoader } from "./files/monacoLoaderConfig";
import "@xterm/xterm/css/xterm.css";
import "./styles/theme.css";

// In E2E browser mode (Vite served without Tauri host), use MemoryBackend
// pre-seeded with a demo project so the create form has a Repo to pick.
const isE2E = import.meta.env.VITE_E2E === "1";

async function makeBackend(): Promise<Backend> {
  if (!isE2E) return new TauriBackend();
  const memory = new MemoryBackend();
  const seed =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { __WS_DEMO_SEED__?: DemoMemorySeed })
          .__WS_DEMO_SEED__;
  if (seed) await applyDemoSeed(memory, seed);
  else await memory.createProject("Demo", "C:\\repos\\demo", "#89b4fa");
  return memory;
}

const backend = await makeBackend();

if (isE2E && typeof window !== "undefined") {
  (window as unknown as { __WS_BACKEND__?: unknown }).__WS_BACKEND__ = backend;
  // E2E seam for flag-gated features. A spec sets __WS_FEATURE_FLAGS__ in an
  // init script (before this module runs) to exercise a feature that ships
  // disabled. Kept behind isE2E so a production build can never flip flags
  // from the page.
  const forced = (window as unknown as { __WS_FEATURE_FLAGS__?: boolean }).__WS_FEATURE_FLAGS__;
  if (typeof forced === "boolean") _setFeatureFlagOverrideForTests(forced);
}

// Dev/E2E-only component harness: `?harness=<caseId>` mounts a single component
// under test in isolation (real Monaco) for fast, reliable UI-bug repro. The
// dynamic import keeps harness code out of the production static graph.
const harnessEnabled = isE2E || import.meta.env.DEV;
const harnessParam =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("harness");

if (harnessEnabled && harnessParam) {
  // The harness mounts an editor immediately, with no workstream/tile
  // selection in between, so it is the one path that can lose the
  // fire-and-forget race above. Awaiting here keeps it deterministic — the
  // whole point of the harness is a faithful mount of real Monaco.
  await ensureLocalMonacoLoader();
  const { HarnessRoot } = await import("./harness/HarnessRoot");
  // No StrictMode here: the harness mounts real Monaco editors, and StrictMode's
  // intentional double-mount races the async editor-creation/dispose lifecycle
  // (the point of the harness is a faithful single mount of the component).
  ReactDOM.createRoot(document.getElementById("root")!).render(<HarnessRoot />);
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BackendProvider backend={backend}>
        <App />
      </BackendProvider>
    </React.StrictMode>,
  );
}
