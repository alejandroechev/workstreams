import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

import DebugWalkthroughTile from "../DebugWalkthroughTile";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import {
  subscribeWalkthroughNavigate,
  type WalkthroughNavigatePayload,
} from "../../domain/walkthrough-nav";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const TRACE_PATH = "/traces/demo.json";

function traceFile(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    test: "pty::tests::resolves_shell",
    repoRoot: "/repo",
    commitSha: "abc1234",
    recordedAt: "2026-08-10T00:00:00.000Z",
    truncated: false,
    steps: [
      { file: "src/pty.rs", line: 10, function: "mycrate::pty::outer" },
      { file: "src/pty.rs", line: 20, function: "mycrate::pty::inner", hits: 3 },
      { file: "src/other.rs", line: 30, function: "mycrate::other::last" },
    ],
    ...overrides,
  };
}

async function setup(opts: {
  traceOverrides?: Record<string, unknown>;
  headCommitSha?: string | null;
  explorers?: Array<{ id: string; title: string | null }>;
  boundExplorerId?: string | null;
  onBindExplorer?: (id: string) => void;
} = {}) {
  const backend = new MemoryBackend();
  backend._seedTraceFile(TRACE_PATH, traceFile(opts.traceOverrides));
  await backend.indexCodeTrace(TRACE_PATH, "ws-1");

  const explorers = opts.explorers ?? [{ id: "explorer-1", title: "Repo" }];

  render(
    <BackendProvider backend={backend}>
      <DebugWalkthroughTile
        tileId="wt-1"
        workstreamId="ws-1"
        explorerCandidates={explorers}
        boundExplorerId={opts.boundExplorerId ?? null}
        onBindExplorer={opts.onBindExplorer}
        headCommitSha={opts.headCommitSha ?? null}
      />
    </BackendProvider>,
  );

  // Wait for the trace list to arrive, then select it.
  const picker = await screen.findByLabelText("Trace");
  await waitFor(() => expect(picker.querySelectorAll("option").length).toBeGreaterThan(1));
  fireEvent.change(picker, { target: { value: TRACE_PATH } });
  await screen.findByTestId("walkthrough-step-current");
  return { backend };
}

describe("DebugWalkthroughTile", () => {
  let navEvents: WalkthroughNavigatePayload[];
  let unsubscribe: () => void;

  beforeEach(() => {
    navEvents = [];
    unsubscribe = subscribeWalkthroughNavigate((p) => navEvents.push(p));
  });

  afterEach(() => {
    unsubscribe();
    cleanup();
  });

  it("lists the steps of a selected trace", async () => {
    await setup();
    expect(screen.getByText(/src\/pty\.rs:10/)).toBeTruthy();
    expect(screen.getByText(/src\/other\.rs:30/)).toBeTruthy();
  });

  it("shows a collapsed location's hit count", async () => {
    // Dropping this would quietly lose the fact that a line was re-entered.
    await setup();
    expect(screen.getByText(/x3/)).toBeTruthy();
  });

  it("starts on the first step", async () => {
    await setup();
    expect(screen.getByTestId("walkthrough-progress").textContent).toBe("1 / 3");
  });

  it("steps forward and drives the bound explorer", async () => {
    await setup();
    fireEvent.click(screen.getByLabelText("Next step"));

    await waitFor(() => expect(screen.getByTestId("walkthrough-progress").textContent).toBe("2 / 3"));
    expect(navEvents[navEvents.length - 1]).toEqual({
      explorerTileId: "explorer-1",
      path: "/repo/src/pty.rs",
      line: 20,
      workstreamId: "ws-1",
    });
  });

  it("steps backward, which a live debugger cannot do", async () => {
    await setup();
    fireEvent.click(screen.getByLabelText("Next step"));
    await waitFor(() => expect(screen.getByTestId("walkthrough-progress").textContent).toBe("2 / 3"));
    fireEvent.click(screen.getByLabelText("Previous step"));
    await waitFor(() => expect(screen.getByTestId("walkthrough-progress").textContent).toBe("1 / 3"));
  });

  it("disables Previous on the first step and Next on the last", async () => {
    await setup();
    expect(screen.getByLabelText("Previous step").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText("Next step"));
    fireEvent.click(screen.getByLabelText("Next step"));
    await waitFor(() => expect(screen.getByTestId("walkthrough-progress").textContent).toBe("3 / 3"));
    expect(screen.getByLabelText("Next step").hasAttribute("disabled")).toBe(true);
  });

  it("jumps to a step clicked in the list", async () => {
    await setup();
    fireEvent.click(screen.getByText(/src\/other\.rs:30/));
    await waitFor(() => expect(screen.getByTestId("walkthrough-progress").textContent).toBe("3 / 3"));
    expect(navEvents[navEvents.length - 1]?.line).toBe(30);
  });

  it("re-emits the current step on Resync without moving", async () => {
    // This is what makes wandering off in the editor safe: the user reads
    // whatever they like, then comes back to where the trace is.
    await setup();
    const before = navEvents.length;
    fireEvent.click(screen.getByLabelText("Resync"));
    await waitFor(() => expect(navEvents.length).toBe(before + 1));
    expect(navEvents[navEvents.length - 1]?.line).toBe(10);
    expect(screen.getByTestId("walkthrough-progress").textContent).toBe("1 / 3");
  });

  it("warns when HEAD has moved past the recorded commit", async () => {
    // Replay is deliberately still allowed — an honest banner beats silently
    // pointing at the wrong line, which is what line remapping would risk.
    await setup({ headCommitSha: "9999999999999999" });
    expect(screen.getByTestId("walkthrough-stale-banner").textContent).toMatch(/abc1234/);
  });

  it("does not warn when HEAD matches the recorded commit", async () => {
    await setup({ headCommitSha: "abc1234567890" });
    expect(screen.queryByTestId("walkthrough-stale-banner")).toBeNull();
  });

  it("does not guess about staleness when HEAD is unknown", async () => {
    await setup({ headCommitSha: null });
    expect(screen.queryByTestId("walkthrough-stale-banner")).toBeNull();
  });

  it("says so when a trace was truncated", async () => {
    await setup({ traceOverrides: { truncated: true } });
    expect(screen.getByTestId("walkthrough-truncated-banner")).toBeTruthy();
  });

  it("explains an empty trace instead of rendering a blank panel", async () => {
    const backend = new MemoryBackend();
    backend._seedTraceFile(TRACE_PATH, traceFile({ steps: [] }));
    await backend.indexCodeTrace(TRACE_PATH, "ws-1");
    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[{ id: "e1", title: null }]} />
      </BackendProvider>,
    );
    const picker = await screen.findByLabelText("Trace");
    await waitFor(() => expect(picker.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(picker, { target: { value: TRACE_PATH } });
    expect(await screen.findByText(/never entered code in this repo/i)).toBeTruthy();
  });

  it("tells the user to open a Repo Explorer when none exists", async () => {
    const backend = new MemoryBackend();
    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[]} />
      </BackendProvider>,
    );
    expect(await screen.findByText(/open a repo explorer/i)).toBeTruthy();
  });

  it("offers a binding picker only when several explorers are open", async () => {
    await setup({ explorers: [{ id: "e1", title: "A" }] });
    expect(screen.queryByLabelText("Repo Explorer")).toBeNull();

    cleanup();
    await setup({ explorers: [{ id: "e1", title: "A" }, { id: "e2", title: "B" }], boundExplorerId: null });
    expect(screen.getByLabelText("Repo Explorer")).toBeTruthy();
  });

  it("reports a failure to read the trace file", async () => {
    const backend = new MemoryBackend();
    // Index a trace, then make its file unreadable by never seeding it back.
    backend._seedTraceFile(TRACE_PATH, traceFile());
    await backend.indexCodeTrace(TRACE_PATH, "ws-1");
    backend.readCodeTraceFile = async () => {
      throw new Error("Cannot read trace: no such file");
    };
    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[{ id: "e1", title: null }]} />
      </BackendProvider>,
    );
    const picker = await screen.findByLabelText("Trace");
    await waitFor(() => expect(picker.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(picker, { target: { value: TRACE_PATH } });
    expect((await screen.findByTestId("walkthrough-error")).textContent).toMatch(/cannot read/i);
  });
});
