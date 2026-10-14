import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AcceptanceReviewView } from "../AcceptanceReviewView";
import { memoryAcceptanceIo } from "./memory-io";
import newFormat from "../../../domain/acceptance/__tests__/fixtures/new-format.md?raw";
import oldFormat from "../../../domain/acceptance/__tests__/fixtures/old-format.md?raw";

const invokeMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

const PATH = "/f/acceptance.md";
const ASSETS = {
  "/f/acceptance-assets/AT-1/1.html": "<p>form</p>",
  "/f/acceptance-assets/AT-1/2.png": "PNG",
  "/f/acceptance-assets/AT-1/3.html": "<p>toast</p>",
  "/f/validation/r2/AT-1-1.png": "SHOT1",
  "/f/validation/r2/AT-1-3.png": "SHOT3",
};
const DIRS = { "/f/validation": ["r1", "r2"], "/f/validation/r1": [], "/f/validation/r2": ["AT-1-1.png", "AT-1-3.png"] };

async function open(text = newFormat, dirs: Record<string, string[]> = DIRS) {
  const io = memoryAcceptanceIo(text, { assets: ASSETS, dirs });
  render(<AcceptanceReviewView path={PATH} io={io} />);
  await waitFor(() => expect(screen.getByTestId("acceptance-review-view")).toBeTruthy());
  return io;
}
const shown = () => {
  const cards = screen.getAllByTestId("acceptance-card");
  expect(cards).toHaveLength(1);
  return cards[0].getAttribute("data-id");
};

beforeEach(() => invokeMock.mockClear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("acceptance Review mode", () => {
  it("shows one test at a time, in file order, with every part of it", async () => {
    await open();
    expect(shown()).toBe("AT-1");
    const card = screen.getByTestId("acceptance-card");
    for (const part of ["Saving shows a toast", "US-1, Round-1 A2", "agent", "an open form", "you press Save", 'a toast says "Saved"', "Fill the form and press Save.", "Drive the form in the harness", "a toast with text Saved is visible."]) {
      expect(card.textContent).toContain(part);
    }
  });

  it("moves with the keys and the buttons, and jumps from the strip", async () => {
    await open();
    const view = screen.getByTestId("acceptance-review-view");
    fireEvent.keyDown(view, { key: "ArrowRight" });
    expect(shown()).toBe("AT-2");
    fireEvent.keyDown(view, { key: "Enter" });
    expect(shown()).toBe("AT-3");
    fireEvent.keyDown(view, { key: "ArrowLeft" });
    expect(shown()).toBe("AT-2");
    fireEvent.click(screen.getByTestId("acceptance-prev"));
    expect(shown()).toBe("AT-1");
    fireEvent.click(screen.getByTestId("acceptance-next"));
    expect(shown()).toBe("AT-2");
    fireEvent.click(screen.getAllByTestId("acceptance-marker")[2]);
    expect(shown()).toBe("AT-3");
  });

  it("colours the strip by mark and filters by it", async () => {
    await open();
    const markers = () => screen.getAllByTestId("acceptance-marker");
    expect(markers().map((m) => m.getAttribute("data-mark"))).toEqual(["ok", "change", "unmarked"]);
    fireEvent.change(screen.getByTestId("acceptance-filter"), { target: { value: "unmarked" } });
    expect(markers().map((m) => m.getAttribute("data-id"))).toEqual(["AT-3"]);
    expect(shown()).toBe("AT-3");
    fireEvent.change(screen.getByTestId("acceptance-filter"), { target: { value: "ok" } });
    fireEvent.change(screen.getByTestId("acceptance-filter"), { target: { value: "change" } });
    expect(shown()).toBe("AT-2");
  });

  it("says so when the filter leaves nothing", async () => {
    await open(newFormat.replace("**Review:** ok\n", ""));
    fireEvent.change(screen.getByTestId("acceptance-filter"), { target: { value: "ok" } });
    expect(screen.getByTestId("acceptance-filter-empty")).toBeTruthy();
  });

  it("marks a test, asks for a change with a note, and clears a mark, writing only that line", async () => {
    const io = await open();
    fireEvent.click(screen.getAllByTestId("acceptance-marker")[2]);
    fireEvent.click(screen.getByTestId("acceptance-mark-ok"));
    await waitFor(() => expect(io.text).toContain("**Automation:** human-only\n**Review:** ok\n"));
    fireEvent.click(screen.getByTestId("acceptance-mark-change"));
    fireEvent.change(screen.getByTestId("acceptance-change-note"), { target: { value: "too vague" } });
    fireEvent.click(screen.getByTestId("acceptance-change-save"));
    await waitFor(() => expect(io.text).toContain("**Automation:** human-only\n**Review:** change: too vague\n"));
    fireEvent.click(screen.getByTestId("acceptance-mark-clear"));
    await waitFor(() => expect(io.text).toBe(newFormat));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("starts a change note from the current one, and can cancel", async () => {
    const io = await open();
    fireEvent.click(screen.getByTestId("acceptance-next"));
    fireEvent.click(screen.getByTestId("acceptance-mark-change"));
    expect((screen.getByTestId("acceptance-change-note") as HTMLInputElement).value).toBe("also check the exit code");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("acceptance-change-note")).toBeNull();
    expect(io.write).not.toHaveBeenCalled();
  });

  it("notes a missing test and lists them", async () => {
    const io = await open();
    expect(screen.getByTestId("acceptance-missing-list").textContent).toContain("nothing checks undo");
    fireEvent.change(screen.getByTestId("acceptance-missing-note"), { target: { value: "nothing checks redo" } });
    fireEvent.click(screen.getByTestId("acceptance-missing-add"));
    await waitFor(() => expect(io.text).toContain("- nothing checks undo\n- nothing checks redo\n"));
    await waitFor(() => expect(screen.getByTestId("acceptance-missing-list").textContent).toContain("nothing checks redo"));
  });

  it("asks for a visual on a test", async () => {
    const io = await open();
    fireEvent.click(screen.getAllByTestId("acceptance-marker")[2]);
    fireEvent.click(screen.getByTestId("acceptance-request-visual"));
    fireEvent.change(screen.getByTestId("acceptance-request-note"), { target: { value: "the error state" } });
    fireEvent.click(screen.getByTestId("acceptance-request-submit"));
    await waitFor(() => expect(io.text).toContain("**Visual requested:** the error state\n\n**Passes when:** z."));
    await waitFor(() => expect(screen.getByTestId("acceptance-visual-requested").textContent).toContain("the error state"));
  });

  it("shows save errors", async () => {
    const io = await open();
    io.write.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(screen.getAllByTestId("acceptance-marker")[2]);
    fireEvent.click(screen.getByTestId("acceptance-mark-ok"));
    await waitFor(() => expect(screen.getByTestId("acceptance-save-status").textContent).toContain("disk full"));
  });

  it("is read-only once approved, and never writes", async () => {
    const approved = newFormat.replace("status: draft", "status: approved");
    const io = await open(approved);
    expect(screen.getByTestId("acceptance-status").textContent).toContain("Approved");
    for (const id of ["acceptance-mark-ok", "acceptance-mark-change", "acceptance-mark-clear", "acceptance-request-visual", "acceptance-missing-add"]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByTestId("acceptance-missing-note") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("acceptance-mark-ok"));
    fireEvent.keyDown(screen.getByTestId("acceptance-review-view"), { key: "ArrowRight" });
    await new Promise((r) => setTimeout(r, 30));
    expect(io.write).not.toHaveBeenCalled();
  });

  it("opens an older file: a card per test, no storyboard", async () => {
    await open(oldFormat, {});
    expect(screen.getAllByTestId("acceptance-marker")).toHaveLength(15);
    expect(screen.queryByTestId("acceptance-storyboard")).toBeNull();
    expect(screen.getByTestId("acceptance-card").textContent).toContain("a normal Workstreams build");
  });

  it("explains an unreadable or empty file", async () => {
    const io = memoryAcceptanceIo("");
    io.read.mockRejectedValue(new Error("gone"));
    render(<AcceptanceReviewView path={PATH} io={io} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("gone"));
    cleanup();
    render(<AcceptanceReviewView path={PATH} io={memoryAcceptanceIo("# nothing\n")} />);
    await waitFor(() => expect(screen.getByTestId("acceptance-review-empty")).toBeTruthy());
  });

  it("picks up changes to the file", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const io = await open();
    io.externalWrite(newFormat.replace("Saving shows a toast", "Saving shows a banner"));
    await act(async () => { vi.advanceTimersByTime(2100); });
    await waitFor(() => expect(screen.getByTestId("acceptance-card").textContent).toContain("Saving shows a banner"));
  });

  describe("storyboards", () => {
    it("shows the frames in order with their steps and captions, and enlarges one", async () => {
      await open();
      const board = screen.getByTestId("acceptance-storyboard");
      const frames = within(board).getAllByTestId("acceptance-frame");
      expect(frames.map((f) => f.getAttribute("data-step"))).toEqual(["given", "when", "then"]);
      expect(frames.map((f) => f.textContent)).toEqual([
        expect.stringContaining("The form"), expect.stringContaining("Pressing Save"), expect.stringContaining("The toast"),
      ]);
      fireEvent.click(within(frames[2]).getByTestId("acceptance-frame-enlarge"));
      expect(screen.getByTestId("acceptance-frame-large").getAttribute("data-index")).toBe("2");
      fireEvent.click(screen.getByTestId("acceptance-frame-large-close"));
      expect(screen.queryByTestId("acceptance-frame-large")).toBeNull();
    });

    it("puts the latest round's screenshot next to each frame it has, read-only", async () => {
      await open();
      const frames = within(screen.getByTestId("acceptance-storyboard")).getAllByTestId("acceptance-frame");
      await waitFor(() => expect(within(frames[0]).getByTestId("acceptance-actual").getAttribute("src")).toBe(`data:image/png;base64,${btoa("SHOT1")}`));
      expect(within(frames[0]).getByText("Actual — round 2")).toBeTruthy();
      expect(within(frames[0]).getByText("Expected")).toBeTruthy();
      expect(within(frames[1]).queryByTestId("acceptance-actual")).toBeNull();
      await waitFor(() => expect(within(frames[2]).getByTestId("acceptance-actual")).toBeTruthy());
      expect(screen.queryByRole("button", { name: /pass|fail|accept/i })).toBeNull();
    });

    it("reloads a frame the agent redrew in place", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const io = await open();
      const frame = () => within(screen.getAllByTestId("acceptance-frame")[0]).getByTestId("grill-prototype");
      await waitFor(() => expect(frame().getAttribute("srcdoc")).toContain("<p>form</p>"));
      io.rewriteAsset("/f/acceptance-assets/AT-1/1.html", "<p>form, redrawn</p>");
      await act(async () => { vi.advanceTimersByTime(2100); });
      await waitFor(() => expect(frame().getAttribute("srcdoc")).toContain("<p>form, redrawn</p>"));
      const reads = io.read.mock.calls.filter(([p]) => p === "/f/acceptance-assets/AT-1/1.html").length;
      await act(async () => { vi.advanceTimersByTime(2100); });
      expect(io.read.mock.calls.filter(([p]) => p === "/f/acceptance-assets/AT-1/1.html").length).toBe(reads);
    });

    it("says when a screenshot can't be loaded", async () => {
      await open(newFormat, { "/f/validation": ["r3"], "/f/validation/r3": ["AT-1-2.png"] });
      const frames = within(screen.getByTestId("acceptance-storyboard")).getAllByTestId("acceptance-frame");
      await waitFor(() => expect(within(frames[1]).getByRole("alert").textContent).toContain("AT-1-2.png"));
    });
  });
});
