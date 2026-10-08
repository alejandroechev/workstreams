import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GrillAnswerView } from "../GrillAnswerView";
import { memoryGrillIo } from "./memory-io";

const invokeMock = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../../ui/MarkdownView", () => ({
  MarkdownView: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

const ROUND_1 = `# Grill

### A1. Old question
**Importance:** High

- (a) one
- (b) two

**Recommendation:** (a)

**Answer:** a

---

`;

const ROUND_2 = `## Round 2

### A1. Storage
**Importance:** Low

- (a) file
- (b) database

**Recommendation:** (a) because simple

**Answer:**

---

### A2. Sync
**Importance:** Medium

Some context.

**Recommendation:** poll

**Answer:** already answered

---

### A3. Layout
**Importance:** High

- (a) tabs
- (b) slides
- (c) scroll

**Recommendation:** (b)

**Answer:**

---

### A4. Security
**Importance:** Blocking

**Recommendation:** sandbox everything

**Answer:**

---

### A5. Naming
**Importance:** Medium

**Recommendation:** keep it

**Answer:** fine
`;

const GRILL = ROUND_1 + ROUND_2;

function shownId() {
  const cards = screen.getAllByTestId("grill-question");
  expect(cards).toHaveLength(1);
  return cards[0].getAttribute("data-id");
}

async function open(text = GRILL) {
  const io = memoryGrillIo(text);
  render(<GrillAnswerView path="/f/grill-me.md" io={io} />);
  await waitFor(() => expect(screen.getByTestId("grill-answer-view")).toBeTruthy());
  return io;
}

beforeEach(() => { invokeMock.mockReset(); invokeMock.mockImplementation(async () => null); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the grill Answer view", () => {
  it("opens on the round being answered, one question at a time", async () => {
    await open();
    expect((screen.getByTestId("grill-round") as HTMLSelectElement).value).toBe("2");
    expect(shownId()).toBe("A1");
  });

  it("moves with the arrow keys and Enter, and jumps from the overview strip", async () => {
    await open();
    const view = screen.getByTestId("grill-answer-view");
    fireEvent.keyDown(view, { key: "ArrowRight" });
    expect(shownId()).toBe("A2");
    fireEvent.keyDown(view, { key: "Enter" });
    expect(shownId()).toBe("A3");
    fireEvent.keyDown(view, { key: "ArrowLeft" });
    expect(shownId()).toBe("A2");
    fireEvent.click(screen.getAllByTestId("grill-marker")[3]);
    expect(shownId()).toBe("A4");
    fireEvent.click(screen.getByTestId("grill-prev"));
    expect(shownId()).toBe("A3");
    fireEvent.click(screen.getByTestId("grill-next"));
    expect(shownId()).toBe("A4");
  });

  it("colours the strip by importance and fills the answered markers", async () => {
    await open();
    const markers = screen.getAllByTestId("grill-marker");
    expect(markers.map((m) => m.getAttribute("data-importance"))).toEqual(["Low", "Medium", "High", "Blocking", "Medium"]);
    expect(markers.map((m) => m.getAttribute("data-answered"))).toEqual(["false", "true", "false", "false", "true"]);
  });

  it("picks an option with its number key and saves it straight away", async () => {
    const io = await open();
    fireEvent.keyDown(screen.getByTestId("grill-answer-view"), { key: "2" });
    await waitFor(() => expect(io.text).toContain("**Answer:** b\n\n---\n\n### A2. Sync"));
    expect(screen.getByTestId("grill-option-b").getAttribute("aria-checked")).toBe("true");
  });

  it("ignores navigation keys typed into a field", async () => {
    await open();
    fireEvent.keyDown(screen.getByTestId("grill-answer"), { key: "ArrowRight" });
    expect(shownId()).toBe("A1");
  });

  it("saves typed answers after a pause, into their own slot only", async () => {
    const io = await open();
    fireEvent.click(screen.getByTestId("grill-option-b"));
    fireEvent.change(screen.getByTestId("grill-option-note"), { target: { value: "only on the phone" } });
    await waitFor(() => expect(io.text).toBe(GRILL.replace("**Recommendation:** (a) because simple\n\n**Answer:**\n", "**Recommendation:** (a) because simple\n\n**Answer:** b — only on the phone\n")));
  });

  it("keeps a round the agent appended while you were answering", async () => {
    const io = await open();
    fireEvent.change(screen.getByTestId("grill-answer"), { target: { value: "my own words" } });
    const appended = `${io.text}\n## Round 3\n\n### A1. Later\n\n**Answer:**\n`;
    io.externalWrite(appended);
    await waitFor(() => expect(io.text).toContain("**Answer:** my own words"));
    expect(io.text.endsWith("## Round 3\n\n### A1. Later\n\n**Answer:**\n")).toBe(true);
    expect((screen.getByTestId("grill-round") as HTMLSelectElement).value).toBe("2");
  });

  it("shows earlier rounds read-only", async () => {
    const io = await open();
    fireEvent.change(screen.getByTestId("grill-round"), { target: { value: "1" } });
    expect(shownId()).toBe("A1");
    expect((screen.getByTestId("grill-answer") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("grill-option-b") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("grill-importance") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByTestId("grill-finish")).toBeNull();
    expect(screen.queryByTestId("grill-request-visual")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("grill-answer-view"), { key: "2" });
    await new Promise((r) => setTimeout(r, 20));
    expect(io.write).not.toHaveBeenCalled();
  });

  it("filters by importance and by unanswered", async () => {
    await open();
    const ids = () => screen.getAllByTestId("grill-marker").map((m) => m.getAttribute("data-id"));
    fireEvent.change(screen.getByTestId("grill-threshold"), { target: { value: "High" } });
    expect(ids()).toEqual(["A3", "A4"]);
    fireEvent.click(screen.getByTestId("grill-unanswered-only"));
    expect(ids()).toEqual(["A3", "A4"]);
    fireEvent.change(screen.getByTestId("grill-threshold"), { target: { value: "Medium" } });
    expect(ids()).toEqual(["A3", "A4"]);
    fireEvent.change(screen.getByTestId("grill-threshold"), { target: { value: "All" } });
    expect(ids()).toEqual(["A1", "A3", "A4"]);
  });

  it("moves on to the next open question when the shown one is answered under unanswered-only", async () => {
    await open();
    fireEvent.click(screen.getByTestId("grill-unanswered-only"));
    fireEvent.click(screen.getByTestId("grill-next"));
    expect(shownId()).toBe("A3");
    fireEvent.click(screen.getByTestId("grill-option-a"));
    await waitFor(() => expect(shownId()).toBe("A4"));
    fireEvent.change(screen.getByTestId("grill-answer"), { target: { value: "sandbox" } });
    await waitFor(() => expect(shownId()).toBe("A1"), { timeout: 2000 });
  });

  it("says so when the filter leaves nothing", async () => {
    await open(GRILL.replace("**Importance:** Blocking", "**Importance:** Low"));
    fireEvent.change(screen.getByTestId("grill-threshold"), { target: { value: "Blocking" } });
    expect(screen.getByTestId("grill-filter-empty")).toBeTruthy();
  });

  it("records your importance override in the file", async () => {
    const io = await open();
    fireEvent.change(screen.getByTestId("grill-importance"), { target: { value: "High" } });
    await waitFor(() => expect(io.text).toContain("### A1. Storage\n**Importance:** High (you)"));
  });

  it("hides the recommendation until asked, then offers to accept it", async () => {
    const io = await open();
    expect(screen.getByTestId("grill-question").textContent).not.toContain("because simple");
    expect(screen.queryByTestId("grill-accept")).toBeNull();
    fireEvent.click(screen.getByTestId("grill-reveal"));
    expect(screen.getByTestId("grill-recommendation-text").textContent).toContain("because simple");
    fireEvent.click(screen.getByTestId("grill-accept"));
    await waitFor(() => expect(io.text).toContain("because simple\n\n**Answer:** reco\n"));
  });

  it("never offers the recommendation for a Blocking question", async () => {
    await open();
    fireEvent.click(screen.getAllByTestId("grill-marker")[3]);
    fireEvent.click(screen.getByTestId("grill-reveal"));
    expect(screen.getByTestId("grill-recommendation-text")).toBeTruthy();
    expect(screen.queryByTestId("grill-accept")).toBeNull();
  });

  it("can always show recommendations, remembered as a setting", async () => {
    await open();
    fireEvent.click(screen.getByTestId("grill-always-show-reco"));
    expect(screen.getByTestId("grill-recommendation-text").textContent).toContain("because simple");
    fireEvent.click(screen.getByTestId("grill-next"));
    expect(screen.getByTestId("grill-recommendation-text").textContent).toContain("poll");
    expect(invokeMock).toHaveBeenCalledWith("set_setting", { key: "grill.always-show-reco", value: "1" });
  });

  it("starts with recommendations shown when the setting is on", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "get_setting" ? "1" : null));
    await open();
    await waitFor(() => expect(screen.getByTestId("grill-recommendation-text")).toBeTruthy());
  });

  it("refuses to finish while a Blocking question is open, writing nothing", async () => {
    const io = await open();
    fireEvent.click(screen.getByTestId("grill-finish"));
    await waitFor(() => expect(screen.getByTestId("grill-finish-refused").textContent).toContain("A4"));
    expect(io.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByTestId("grill-finish-refused")).toBeNull();
  });

  it("finishes a round by recording the defaults, after saying how many", async () => {
    const io = await open(GRILL.replace("sandbox everything\n\n**Answer:**", "sandbox everything\n\n**Answer:** yes"));
    fireEvent.change(screen.getByTestId("grill-threshold"), { target: { value: "Blocking" } });
    fireEvent.click(screen.getByTestId("grill-finish"));
    await waitFor(() => expect(screen.getByTestId("grill-finish-confirm").textContent).toContain("2 unanswered questions (A1, A3)"));
    fireEvent.click(screen.getByTestId("grill-finish-ok"));
    await waitFor(() => expect(io.text.match(/\*\*Answer:\*\* reco \(default — not reviewed\)/g)).toHaveLength(2));
    expect(io.text).toContain("**Answer:** already answered");
  });

  it("lets you cancel finishing", async () => {
    const io = await open(GRILL.replace("sandbox everything\n\n**Answer:**", "sandbox everything\n\n**Answer:** yes"));
    fireEvent.click(screen.getByTestId("grill-finish"));
    await waitFor(() => expect(screen.getByTestId("grill-finish-confirm")).toBeTruthy());
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("grill-finish-confirm")).toBeNull();
    expect(io.write).not.toHaveBeenCalled();
  });

  it("says when every question is already answered", async () => {
    await open(ROUND_1);
    fireEvent.click(screen.getByTestId("grill-finish"));
    await waitFor(() => expect(screen.getByTestId("grill-finish-confirm").textContent).toContain("Every question is answered"));
  });

  it("writes a visual request for the question", async () => {
    const io = await open();
    fireEvent.click(screen.getByTestId("grill-request-visual"));
    fireEvent.change(screen.getByTestId("grill-request-note"), { target: { value: "a diagram" } });
    fireEvent.click(screen.getByTestId("grill-request-submit"));
    await waitFor(() => expect(io.text).toContain("**Visual requested:** a diagram\n\n**Recommendation:** (a) because simple"));
  });

  it("picks up the agent's changes to the file", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const io = await open();
    io.externalWrite(GRILL.replace("### A2. Sync", "### A2. Sync, renamed"));
    await act(async () => { vi.advanceTimersByTime(2100); });
    fireEvent.click(screen.getByTestId("grill-next"));
    await waitFor(() => expect(screen.getByTestId("grill-question").textContent).toContain("Sync, renamed"));
  });

  it("shows save errors", async () => {
    const io = await open();
    io.write.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(screen.getByTestId("grill-option-a"));
    await waitFor(() => expect(screen.getByTestId("grill-save-status").textContent).toContain("disk full"));
  });

  it("explains an empty or unreadable grill", async () => {
    render(<GrillAnswerView path="/f/grill-me.md" io={memoryGrillIo("# Nothing yet\n")} />);
    await waitFor(() => expect(screen.getByTestId("grill-answer-empty")).toBeTruthy());
    cleanup();
    const io = memoryGrillIo("");
    io.read.mockRejectedValue(new Error("gone"));
    render(<GrillAnswerView path="/f/grill-me.md" io={io} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("gone"));
  });

  it("saves an answer still being typed when it closes", async () => {
    const io = memoryGrillIo(GRILL);
    const { unmount } = render(<GrillAnswerView path="/f/grill-me.md" io={io} />);
    await waitFor(() => expect(screen.getByTestId("grill-answer")).toBeTruthy());
    fireEvent.change(screen.getByTestId("grill-answer"), { target: { value: "typed then closed" } });
    unmount();
    await waitFor(() => expect(io.text).toContain("**Answer:** typed then closed"));
  });
});
