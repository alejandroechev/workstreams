import { beforeEach, describe, expect, it, vi } from "vitest";

class EditorWorkerMock {}
class JsonWorkerMock {}
class CssWorkerMock {}
class HtmlWorkerMock {}
class TypeScriptWorkerMock {}

const monacoMock = {
  editor: {
    create: vi.fn(),
    createModel: vi.fn(),
  },
};

vi.mock("monaco-editor", () => monacoMock);
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: EditorWorkerMock }));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: JsonWorkerMock }));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({ default: CssWorkerMock }));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({ default: HtmlWorkerMock }));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({ default: TypeScriptWorkerMock }));

import { _resetMonacoLoaderForTests, getMonacoIfLoaded, loadMonaco } from "../loadMonaco";

interface MonacoEnvironmentHost extends Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}

const monacoHost = self as MonacoEnvironmentHost;

describe("loadMonaco", () => {
  beforeEach(() => {
    _resetMonacoLoaderForTests();
    vi.clearAllMocks();
    delete monacoHost.MonacoEnvironment;
  });

  it("returns null before Monaco has loaded", () => {
    expect(getMonacoIfLoaded()).toBeNull();
  });

  it("shares one in-flight promise across concurrent callers", async () => {
    const firstPromise = loadMonaco();
    const thenSpy = vi.spyOn(firstPromise, "then");

    const secondPromise = loadMonaco();

    expect(secondPromise).toBe(firstPromise);
    secondPromise.then(() => undefined);
    expect(thenSpy).toHaveBeenCalledTimes(1);
    await firstPromise;
  });

  it("returns the Monaco module after the lazy load resolves", async () => {
    const loaded = await loadMonaco();

    expect(loaded.editor).toBe(monacoMock.editor);
    expect(getMonacoIfLoaded()?.editor).toBe(monacoMock.editor);
  });

  it("resets the cached promise and loaded module for tests", async () => {
    const firstPromise = loadMonaco();
    await firstPromise;

    _resetMonacoLoaderForTests();

    expect(getMonacoIfLoaded()).toBeNull();
    expect(loadMonaco()).not.toBe(firstPromise);
  });

  it("configures synchronous Monaco web worker construction", async () => {
    await loadMonaco();

    expect(monacoHost.MonacoEnvironment?.getWorker("json-worker", "json")).toBeInstanceOf(JsonWorkerMock);
    expect(monacoHost.MonacoEnvironment?.getWorker("css-worker", "scss")).toBeInstanceOf(CssWorkerMock);
    expect(monacoHost.MonacoEnvironment?.getWorker("html-worker", "handlebars")).toBeInstanceOf(HtmlWorkerMock);
    expect(monacoHost.MonacoEnvironment?.getWorker("ts-worker", "javascript")).toBeInstanceOf(TypeScriptWorkerMock);
    expect(monacoHost.MonacoEnvironment?.getWorker("editor-worker", "plaintext")).toBeInstanceOf(EditorWorkerMock);
  });
});
