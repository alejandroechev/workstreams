import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  it("shows one step's frames, or the unstepped ones numbered among all frames, and refuses frames outside the asset folder", async () => {
    const io = memoryAcceptanceIo("", { assets: { "/f/acceptance-assets/AT-1/a.png": "A", "/f/acceptance-assets/AT-1/b.png": "B" } });
    const { unmount } = render(<Storyboard test={test} step={null} featureDir="/f" io={io} rounds={[]} />);
    let frames = screen.getAllByTestId("acceptance-frame");
    expect(frames.map((f) => f.querySelector("figcaption")!.textContent)).toEqual(["Frame 1First"]);
    await waitFor(() => expect(within(frames[0]).getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${btoa("A")}`));
    unmount();
    render(<Storyboard test={test} step="when" featureDir="/f" io={io} rounds={[]} />);
    frames = screen.getAllByTestId("acceptance-frame");
    expect(frames.map((f) => f.querySelector("figcaption")!.textContent)).toEqual(["WhenEscapes"]);
    expect((await within(frames[0]).findByRole("alert")).textContent).toContain("outside this document's acceptance-assets folder");
  });

  it("renders nothing for a step without frames", () => {
    const { container } = render(<Storyboard test={test} step="given" featureDir="/f" io={memoryAcceptanceIo("")} rounds={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("puts a frame's screenshot under it, matched by its number among all frames", async () => {
    const io = memoryAcceptanceIo("", { assets: { "/f/acceptance-assets/AT-1/a.png": "A", "/f/acceptance-assets/AT-1/b.png": "B", "/f/validation/r4/AT-1-2.png": "S" } });
    render(<Storyboard test={test} step="then" featureDir="/f" io={io} rounds={[{ round: 4, files: ["AT-1-2.png"] }]} />);
    const frame = screen.getByTestId("acceptance-frame");
    expect(within(frame).getByText("Expected")).toBeTruthy();
    expect(within(frame).getByText("Actual — round 4")).toBeTruthy();
    await waitFor(() => expect(within(frame).getByTestId("acceptance-actual").getAttribute("src")).toBe(`data:image/png;base64,${btoa("S")}`));
  });
});
