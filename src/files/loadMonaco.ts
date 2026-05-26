import type * as MonacoNs from "monaco-editor";

type MonacoModule = typeof MonacoNs;

interface MonacoEnvironmentHost extends Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}

let loadPromise: Promise<MonacoModule> | null = null;
let loadedMonaco: MonacoModule | null = null;

// Tiny inline no-op worker: returned for every Monaco language. Monaco needs
// `getWorker` to return SOMETHING, but if our only use case is plain-text
// editing (no JSON/TS/CSS IntelliSense), the worker doesn't need to do
// anything. This avoids the Vite `?worker` imports which:
//   1. Spawn shared_worker targets that Playwright's older CDP-connect chokes
//      on, breaking CDP visual validation.
//   2. Add ~1 MB of language-server code per worker that we'd ship to disk
//      but never use.
// If we add IntelliSense later, swap this for the proper worker bundle.
const createNoopWorkerSource = (): string => `
  self.onmessage = function(e) {
    // Reply to Monaco's "create worker" handshake with empty results so it
    // doesn't keep retrying. Real language workers respond with structured
    // results; we just acknowledge to avoid console noise.
    if (e.data && e.data.method === "$initialize") {
      self.postMessage({ id: e.data.id, result: null });
    }
  };
`;

const configureMonacoEnvironment = (): void => {
  const monacoHost = self as MonacoEnvironmentHost;
  if (monacoHost.MonacoEnvironment) return;
  monacoHost.MonacoEnvironment = {
    getWorker(): Worker {
      const blob = new Blob([createNoopWorkerSource()], { type: "application/javascript" });
      return new Worker(URL.createObjectURL(blob));
    },
  };
};

/**
 * Lazy-load Monaco. The dynamic import is started on first call and cached.
 * Subsequent calls return the same promise immediately.
 *
 * Throws if Monaco fails to load (network, bundler error). Callers should
 * surface this in the UI.
 */
export function loadMonaco(): Promise<MonacoModule> {
  if (loadPromise === null) {
    loadPromise = (async () => {
      configureMonacoEnvironment();
      const monaco = await import("monaco-editor");
      loadedMonaco = monaco;
      return monaco;
    })();
  }

  return loadPromise;
}

/**
 * Returns the Monaco module if it has already been loaded, else null.
 * Useful for synchronous code paths that need to no-op when Monaco isn't ready.
 */
export function getMonacoIfLoaded(): MonacoModule | null {
  return loadedMonaco;
}

/** Test-only: reset the cached promise so a fresh import is triggered. */
export function _resetMonacoLoaderForTests(): void {
  loadPromise = null;
  loadedMonaco = null;
}
