import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Storyboard } from "../Storyboard";
import { parseAcceptance } from "../../../domain/acceptance/parse";
import { memoryAcceptanceIo } from "./memory-io";

afterEach(cleanup);

const test = parseAcceptance([
  "## AT-1 — Frames",
  '**Frame:** acceptance-assets/AT-1/a.png "First"',
  '**Frame:** acceptance-assets/AT-1/b.png "Second" (then)',
  '**Frame:** ../outside.png "Escapes" (when)',
].join("\n")).tests[0];

describe("a storyboard", () => {
  it("labels frames without a step by number, and refuses frames outside the asset folder", async () => {
    const io = memoryAcceptanceIo("", { assets: { "/f/acceptance-assets/AT-1/a.png": "A", "/f/acceptance-assets/AT-1/b.png": "B" } });
    render(<Storyboard test={test} featureDir="/f" io={io} rounds={[]} />);
    const frames = screen.getAllByTestId("acceptance-frame");
    expect(frames.map((f) => within(f).getByTestId("acceptance-frame-enlarge").textContent)).toEqual(["Frame 1First", "ThenSecond", "WhenEscapes"]);
    expect((await within(frames[2]).findByRole("alert")).textContent).toContain("outside this document's acceptance-assets folder");
    await waitFor(() => expect(within(frames[0]).getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${btoa("A")}`));
  });

  it("enlarges a frame with its screenshot beside it", async () => {
    const io = memoryAcceptanceIo("", { assets: { "/f/acceptance-assets/AT-1/a.png": "A", "/f/acceptance-assets/AT-1/b.png": "B", "/f/validation/r4/AT-1-2.png": "S" } });
    render(<Storyboard test={test} featureDir="/f" io={io} rounds={[{ round: 4, files: ["AT-1-2.png"] }]} />);
    fireEvent.click(within(screen.getAllByTestId("acceptance-frame")[1]).getByTestId("acceptance-frame-enlarge"));
    const large = screen.getByTestId("acceptance-frame-large");
    expect(large.textContent).toContain("Then Second");
    expect(within(large).getByText("Actual — round 4")).toBeTruthy();
    fireEvent.click(within(screen.getAllByTestId("acceptance-frame")[0]).getByTestId("acceptance-frame-enlarge"));
    expect(screen.getByTestId("acceptance-frame-large").textContent).toContain("Frame 1 First");
  });
});
