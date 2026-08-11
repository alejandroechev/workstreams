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

const openDialogMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));

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
  workstreamDir?: string | null;
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
        workstreamDir={opts.workstreamDir ?? null}
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

  it("registers a trace file picked from disk and selects it", async () => {
    // The recorder is a CLI: it writes a file and knows nothing about the
    // app's index. Without this the picker stays empty forever and the
    // feature has no usable entry point.
    const backend = new MemoryBackend();
    backend._seedTraceFile("/picked/new.json", traceFile({ test: "picked::trace" }));
    openDialogMock.mockResolvedValue("/picked/new.json");

    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[{ id: "e1", title: null }]} />
      </BackendProvider>,
    );

    fireEvent.click(await screen.findByLabelText("Add trace"));

    await screen.findByTestId("walkthrough-step-current");
    expect((await backend.listCodeTraces("ws-1")).map((t) => t.test_name)).toEqual(["picked::trace"]);
  });

  it("does nothing when the file picker is dismissed", async () => {
    const backend = new MemoryBackend();
    openDialogMock.mockResolvedValue(null);
    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[{ id: "e1", title: null }]} />
      </BackendProvider>,
    );
    fireEvent.click(await screen.findByLabelText("Add trace"));
    await waitFor(() => expect(screen.queryByTestId("walkthrough-error")).toBeNull());
  });

  it("reports a picked file that is not a valid trace", async () => {
    const backend = new MemoryBackend();
    openDialogMock.mockResolvedValue("/picked/missing.json");
    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[{ id: "e1", title: null }]} />
      </BackendProvider>,
    );
    fireEvent.click(await screen.findByLabelText("Add trace"));
    expect((await screen.findByTestId("walkthrough-error")).textContent).toMatch(/cannot read/i);
  });

  describe("recording from the UI", () => {
    it("offers the crate's tests and records the chosen one", async () => {
      // The whole point: no terminal round-trip. Pick a test, press Record,
      // and end up stepping through it.
      const backend = new MemoryBackend();
      backend._rustTests = ["pty::tests::alpha", "shell_env::tests::beta"];
      backend._seedTraceFile("/recorded/beta.json", traceFile({ test: "shell_env::tests::beta" }));
      backend._recordedTracePath = "/recorded/beta.json";

      render(
        <BackendProvider backend={backend}>
          <DebugWalkthroughTile
            tileId="wt-1"
            workstreamId="ws-1"
            workstreamDir="/repo"
            explorerCandidates={[{ id: "e1", title: null }]}
          />
        </BackendProvider>,
      );

      const testPicker = await screen.findByLabelText("Test");
      await waitFor(() => expect(testPicker.querySelectorAll("option").length).toBe(3));
      fireEvent.change(testPicker, { target: { value: "shell_env::tests::beta" } });
      fireEvent.click(screen.getByLabelText("Record trace"));

      await screen.findByTestId("walkthrough-step-current");
      expect((await backend.listCodeTraces("ws-1")).map((t) => t.test_name)).toEqual([
        "shell_env::tests::beta",
      ]);
    });

    it("shows progress while recording so the UI never looks frozen", async () => {
      // A recording drives a debugger step by step and takes seconds to
      // minutes; a silent button would read as a hang.
      const backend = new MemoryBackend();
      backend._rustTests = ["a::b"];
      backend._seedTraceFile("/r.json", traceFile());
      backend._recordedTracePath = "/r.json";
      let release: (v: string) => void = () => {};
      backend.recordCodeTrace = () => new Promise<string>((resolve) => { release = resolve; });

      render(
        <BackendProvider backend={backend}>
          <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" workstreamDir="/repo"
            explorerCandidates={[{ id: "e1", title: null }]} />
        </BackendProvider>,
      );

      const testPicker = await screen.findByLabelText("Test");
      await waitFor(() => expect(testPicker.querySelectorAll("option").length).toBe(2));
      fireEvent.change(testPicker, { target: { value: "a::b" } });
      fireEvent.click(screen.getByLabelText("Record trace"));

      expect(await screen.findByTestId("walkthrough-recording")).toBeTruthy();
      release("/r.json");
    });

    it("surfaces a recording failure instead of failing silently", async () => {
      const backend = new MemoryBackend();
      backend._rustTests = ["a::b"];
      backend.recordCodeTrace = async () => {
        throw new Error("lldb-dap not found");
      };

      render(
        <BackendProvider backend={backend}>
          <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" workstreamDir="/repo"
            explorerCandidates={[{ id: "e1", title: null }]} />
        </BackendProvider>,
      );

      const testPicker = await screen.findByLabelText("Test");
      await waitFor(() => expect(testPicker.querySelectorAll("option").length).toBe(2));
      fireEvent.change(testPicker, { target: { value: "a::b" } });
      fireEvent.click(screen.getByLabelText("Record trace"));

      expect((await screen.findByTestId("walkthrough-error")).textContent).toMatch(/lldb-dap/i);
    });

    it("explains why no tests are listed instead of showing an empty dropdown", async () => {
      // A silent catch here is what hid a real bug: cargo could not find
      // Cargo.toml, the list came back empty, and the picker gave the user
      // nothing to act on.
      const backend = new MemoryBackend();
      backend.listRustTests = async () => {
        throw new Error("No Cargo.toml found in /repo or its immediate subdirectories.");
      };
      render(
        <BackendProvider backend={backend}>
          <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" workstreamDir="/repo"
            explorerCandidates={[{ id: "e1", title: null }]} />
        </BackendProvider>,
      );
      expect((await screen.findByTestId("walkthrough-tests-unavailable")).textContent)
        .toMatch(/no cargo\.toml/i);
    });

    it("says so when the crate simply has no tests", async () => {
      const backend = new MemoryBackend();
      backend._rustTests = [];
      render(
        <BackendProvider backend={backend}>
          <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" workstreamDir="/repo"
            explorerCandidates={[{ id: "e1", title: null }]} />
        </BackendProvider>,
      );
      expect((await screen.findByTestId("walkthrough-tests-unavailable")).textContent)
        .toMatch(/no tests/i);
    });

    it("cannot record without a workstream directory", async () => {
      // Nothing to point cargo at, so the control must be unavailable rather
      // than failing obscurely on click.
      const backend = new MemoryBackend();
      backend._rustTests = ["a::b"];
      render(
        <BackendProvider backend={backend}>
          <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1"
            explorerCandidates={[{ id: "e1", title: null }]} />
        </BackendProvider>,
      );
      await screen.findByLabelText("Trace", { exact: true });
      expect(screen.queryByLabelText("Record trace")).toBeNull();
    });
  });

  describe("layout", () => {
    it("groups the controls into trace, record and step sections", async () => {
      await setup({ workstreamDir: "/repo" });
      expect(screen.getByTestId("walkthrough-section-trace")).toBeTruthy();
      expect(screen.getByTestId("walkthrough-section-record")).toBeTruthy();
      expect(screen.getByTestId("walkthrough-section-step")).toBeTruthy();
    });

    it("hides the record section when there is no workstream directory", async () => {
      // Nothing to point cargo at, so the whole section would be inert.
      await setup();
      expect(screen.queryByTestId("walkthrough-section-record")).toBeNull();
    });
  });

  describe("keyboard stepping", () => {
    it("steps forward and back with unmodified keys", async () => {
      await setup();
      const tile = screen.getByTestId("debug-walkthrough-tile");
      const progress = screen.getByTestId("walkthrough-progress");

      fireEvent.keyDown(tile, { key: "ArrowDown" });
      await waitFor(() => expect(progress.textContent).toBe("2 / 3"));
      fireEvent.keyDown(tile, { key: "j" });
      await waitFor(() => expect(progress.textContent).toBe("3 / 3"));
      fireEvent.keyDown(tile, { key: "ArrowUp" });
      await waitFor(() => expect(progress.textContent).toBe("2 / 3"));
    });

    it("jumps to the first and last step", async () => {
      await setup();
      const tile = screen.getByTestId("debug-walkthrough-tile");
      const progress = screen.getByTestId("walkthrough-progress");

      fireEvent.keyDown(tile, { key: "End" });
      await waitFor(() => expect(progress.textContent).toBe("3 / 3"));
      fireEvent.keyDown(tile, { key: "Home" });
      await waitFor(() => expect(progress.textContent).toBe("1 / 3"));
    });

    it("drives the bound explorer from the keyboard", async () => {
      await setup();
      fireEvent.keyDown(screen.getByTestId("debug-walkthrough-tile"), { key: "ArrowDown" });
      await waitFor(() => expect(navEvents.length).toBeGreaterThan(0));
      expect(navEvents[navEvents.length - 1].line).toBe(20);
    });

    it("ignores keys held with a modifier", async () => {
      // Alt+Arrows move focus between tiles; stealing them would break
      // navigation the user relies on everywhere else.
      await setup();
      const tile = screen.getByTestId("debug-walkthrough-tile");
      fireEvent.keyDown(tile, { key: "ArrowDown", altKey: true });
      expect(screen.getByTestId("walkthrough-progress").textContent).toBe("1 / 3");
    });

    it("does not steal keys typed into a control", async () => {
      // The test/trace dropdowns are focusable; a bare "j" there must not
      // step the walkthrough out from under the user.
      await setup();
      const picker = screen.getByLabelText("Trace", { exact: true });
      fireEvent.keyDown(picker, { key: "j" });
      expect(screen.getByTestId("walkthrough-progress").textContent).toBe("1 / 3");
    });
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

  it("warns about uncommitted changes reported by the backend", async () => {
    // Uncommitted edits shift line numbers just as effectively as a new
    // commit, and only the backend can see them.
    const backend = new MemoryBackend();
    backend._seedTraceFile(TRACE_PATH, traceFile());
    await backend.indexCodeTrace(TRACE_PATH, "ws-1");
    backend._traceStaleness = "tree_dirty";
    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[{ id: "e1", title: null }]} />
      </BackendProvider>,
    );
    const picker = await screen.findByLabelText("Trace");
    await waitFor(() => expect(picker.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(picker, { target: { value: TRACE_PATH } });
    expect((await screen.findByTestId("walkthrough-stale-banner")).textContent).toMatch(/uncommitted/i);
  });

  it("stays quiet when the backend cannot judge staleness", async () => {
    // Warning on no evidence would train the user to ignore the banner.
    const backend = new MemoryBackend();
    backend._seedTraceFile(TRACE_PATH, traceFile());
    await backend.indexCodeTrace(TRACE_PATH, "ws-1");
    backend._traceStaleness = "unknown";
    render(
      <BackendProvider backend={backend}>
        <DebugWalkthroughTile tileId="wt-1" workstreamId="ws-1" explorerCandidates={[{ id: "e1", title: null }]} />
      </BackendProvider>,
    );
    const picker = await screen.findByLabelText("Trace");
    await waitFor(() => expect(picker.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(picker, { target: { value: TRACE_PATH } });
    await screen.findByTestId("walkthrough-step-current");
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
