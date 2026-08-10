import { describe, it, expect, vi, afterEach } from "vitest";

import {
  WALKTHROUGH_NAVIGATE_EVENT,
  dispatchWalkthroughNavigate,
  subscribeWalkthroughNavigate,
  selectExplorerBinding,
  type WalkthroughNavigatePayload,
} from "../walkthrough-nav";

afterEach(() => {
  vi.restoreAllMocks();
});

const payload: WalkthroughNavigatePayload = {
  explorerTileId: "explorer-1",
  path: "/repo/src/a.rs",
  line: 42,
  workstreamId: "ws-1",
};

describe("walkthrough navigation events", () => {
  it("delivers a payload to a subscriber", () => {
    const seen: WalkthroughNavigatePayload[] = [];
    const unsubscribe = subscribeWalkthroughNavigate((p) => seen.push(p));

    dispatchWalkthroughNavigate(payload);

    expect(seen).toEqual([payload]);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const seen: WalkthroughNavigatePayload[] = [];
    const unsubscribe = subscribeWalkthroughNavigate((p) => seen.push(p));
    unsubscribe();

    dispatchWalkthroughNavigate(payload);

    expect(seen).toEqual([]);
  });

  it("uses a namespaced event name", () => {
    expect(WALKTHROUGH_NAVIGATE_EVENT).toMatch(/^workstreams:/);
  });

  it("delivers to every listener", () => {
    // Several Repo Explorers can be mounted; each filters by tile id itself.
    const a = vi.fn();
    const b = vi.fn();
    const ua = subscribeWalkthroughNavigate(a);
    const ub = subscribeWalkthroughNavigate(b);

    dispatchWalkthroughNavigate(payload);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    ua();
    ub();
  });
});

describe("selectExplorerBinding", () => {
  const explorer = (id: string, title: string | null = null) => ({ id, title });

  it("auto-binds when exactly one explorer is open", () => {
    // With a single candidate there is nothing to choose, so the UI shows no
    // chrome at all.
    const result = selectExplorerBinding(null, [explorer("e1")]);
    expect(result).toEqual({ boundId: "e1", needsChoice: false });
  });

  it("asks the user to choose when several are open", () => {
    const result = selectExplorerBinding(null, [explorer("e1"), explorer("e2")]);
    expect(result).toEqual({ boundId: null, needsChoice: true });
  });

  it("keeps an explicit choice even when other explorers exist", () => {
    // Binding is deliberately explicit and sticky. Re-deriving it from focus
    // would move the step target as the user clicks around -- fighting the
    // wander-freely behaviour the whole design exists to support.
    const result = selectExplorerBinding("e2", [explorer("e1"), explorer("e2")]);
    expect(result).toEqual({ boundId: "e2", needsChoice: false });
  });

  it("falls back to a choice when the bound explorer was closed", () => {
    const result = selectExplorerBinding("gone", [explorer("e1"), explorer("e2")]);
    expect(result).toEqual({ boundId: null, needsChoice: true });
  });

  it("re-binds silently when the bound explorer was closed and only one remains", () => {
    const result = selectExplorerBinding("gone", [explorer("e1")]);
    expect(result).toEqual({ boundId: "e1", needsChoice: false });
  });

  it("reports nothing to bind when no explorer is open", () => {
    // The controller should tell the user to open a Repo Explorer rather than
    // silently doing nothing when they press Next.
    const result = selectExplorerBinding(null, []);
    expect(result).toEqual({ boundId: null, needsChoice: false });
  });
});
