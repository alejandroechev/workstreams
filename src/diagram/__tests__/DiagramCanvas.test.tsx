import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Props = {
  excalidrawAPI: (api: unknown) => void;
  onChange: (elements: Array<{ id: string; version: number }>, appState: unknown, files: Record<string, unknown>) => void;
  initialData: { elements: unknown[] };
};
const { state, loadExcalidraw } = vi.hoisted(() => ({ state: { props: null as Props | null }, loadExcalidraw: vi.fn() }));
vi.mock("../excalidraw-loader", () => ({ loadExcalidraw }));

import { DiagramCanvas } from "../DiagramCanvas";

const fakeModule = {
  Excalidraw: (props: Props) => {
    state.props = props;
    return <div data-testid="excalidraw" />;
  },
  hashElementsVersion: (els: Array<{ version: number }>) => els.reduce((n, e) => n * 31 + e.version, els.length),
};
const api = { id: "api" };

describe("DiagramCanvas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.props = null;
    loadExcalidraw.mockResolvedValue(fakeModule);
    delete window.__WS_DIAGRAMS__;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function mount(onSceneChange = vi.fn()) {
    const view = render(<DiagramCanvas registryKey="t:b" initialScene={{ elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 1, height: 1, version: 1 }], files: {} }} onSceneChange={onSceneChange} />);
    await act(async () => { await Promise.resolve(); });
    act(() => state.props!.excalidrawAPI(api));
    return { view, onSceneChange };
  }

  it("lists the open canvas for checks, and unlists it when it goes", async () => {
    const { view } = await mount();
    expect(screen.getByTestId("diagram-canvas").getAttribute("data-diagram-key")).toBe("t:b");
    expect(window.__WS_DIAGRAMS__?.["t:b"]).toBe(api);
    view.unmount();
    expect(window.__WS_DIAGRAMS__?.["t:b"]).toBeUndefined();
  });

  it("reports drawing changes once, debounced, and ignores view-only updates", async () => {
    const { onSceneChange } = await mount();
    // Same elements and versions as the initial scene: a selection or scroll.
    act(() => state.props!.onChange([{ id: "a", version: 1 }], {}, {}));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onSceneChange).not.toHaveBeenCalled();
    act(() => state.props!.onChange([{ id: "a", version: 2 }], {}, {}));
    act(() => state.props!.onChange([{ id: "a", version: 3 }], {}, {}));
    act(() => { vi.advanceTimersByTime(299); });
    expect(onSceneChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onSceneChange).toHaveBeenCalledTimes(1);
    expect(onSceneChange.mock.calls[0][0].elements).toEqual([{ id: "a", version: 3 }]);
  });

  it("saves a pending change straight away when it closes", async () => {
    const { view, onSceneChange } = await mount();
    act(() => state.props!.onChange([{ id: "a", version: 5 }], {}, { f: {} }));
    view.unmount();
    expect(onSceneChange).toHaveBeenCalledWith({ elements: [{ id: "a", version: 5 }], files: { f: {} } });
  });

  it("says so when the editor cannot load", async () => {
    loadExcalidraw.mockRejectedValue(new Error("chunk failed"));
    render(<DiagramCanvas registryKey="k" initialScene={{ elements: [], files: {} }} onSceneChange={vi.fn()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("diagram-canvas-error").textContent).toContain("chunk failed");
  });
});
