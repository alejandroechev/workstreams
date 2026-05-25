import type * as MonacoNs from "monaco-editor";

type MonacoModule = typeof MonacoNs;
type WorkerConstructor = new () => Worker;

interface WorkerConstructors {
  editor: WorkerConstructor;
  json: WorkerConstructor;
  css: WorkerConstructor;
  html: WorkerConstructor;
  typescript: WorkerConstructor;
}

interface MonacoEnvironmentHost extends Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}

let loadPromise: Promise<MonacoModule> | null = null;
let loadedMonaco: MonacoModule | null = null;

const loadWorkerConstructors = async (): Promise<WorkerConstructors> => {
  const [editor, json, css, html, typescript] = await Promise.all([
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    import("monaco-editor/esm/vs/language/json/json.worker?worker"),
    import("monaco-editor/esm/vs/language/css/css.worker?worker"),
    import("monaco-editor/esm/vs/language/html/html.worker?worker"),
    import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
  ]);

  return {
    editor: editor.default,
    json: json.default,
    css: css.default,
    html: html.default,
    typescript: typescript.default,
  };
};

const pickWorkerConstructor = (workers: WorkerConstructors, label: string): WorkerConstructor => {
  switch (label) {
    case "json":
      return workers.json;
    case "css":
    case "scss":
    case "less":
      return workers.css;
    case "html":
    case "handlebars":
    case "razor":
      return workers.html;
    case "typescript":
    case "javascript":
      return workers.typescript;
    default:
      return workers.editor;
  }
};

const configureMonacoEnvironment = (workers: WorkerConstructors): void => {
  const monacoHost = self as MonacoEnvironmentHost;

  monacoHost.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      const WorkerClass = pickWorkerConstructor(workers, label);
      return new WorkerClass();
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
      const workers = await loadWorkerConstructors();
      configureMonacoEnvironment(workers);

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
