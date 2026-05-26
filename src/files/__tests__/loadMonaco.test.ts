import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const monacoMock = {
  editor: {
    create: vi.fn(),
    createModel: vi.fn(),
  },
};

vi.mock("monaco-editor", () => monacoMock);

// Stub Worker + URL.createObjectURL — jsdom doesn't fully implement them.
class WorkerStub {
  constructor(_url: string) {}
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  onmessage: ((e: MessageEvent) => void) | null = null;
}
const originalCreateObjectURL = URL.createObjectURL;
const originalWorker = (globalThis as unknown as { Worker?: typeof Worker }).Worker;
(globalThis as unknown as { Worker: typeof Worker }).Worker = WorkerStub as unknown as typeof Worker;
URL.createObjectURL = vi.fn(() => "blob:mock");

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

  it("installs a Monaco environment with a synchronous getWorker", async () => {
    await loadMonaco();
    const env = monacoHost.MonacoEnvironment;
    expect(env).toBeDefined();
    // getWorker must return a Worker-shaped object for any label without throwing.
    expect(env!.getWorker("any-id", "json")).toBeInstanceOf(WorkerStub);
    expect(env!.getWorker("any-id", "plaintext")).toBeInstanceOf(WorkerStub);
    expect(env!.getWorker("any-id", "css")).toBeInstanceOf(WorkerStub);
  });

  it("preserves a pre-existing MonacoEnvironment if one was already configured", async () => {
    const custom = { getWorker: vi.fn().mockReturnValue(new WorkerStub("x")) };
    monacoHost.MonacoEnvironment = custom;
    await loadMonaco();
    expect(monacoHost.MonacoEnvironment).toBe(custom);
  });
});

// Restore createObjectURL after the suite (vitest's globalThis lives across tests).
afterAll(() => {
  URL.createObjectURL = originalCreateObjectURL;
  if (originalWorker) {
    (globalThis as unknown as { Worker?: typeof Worker }).Worker = originalWorker;
  }
});
