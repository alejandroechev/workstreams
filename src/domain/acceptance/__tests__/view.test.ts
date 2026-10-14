import { describe, it, expect } from "vitest";
import { parseAcceptance } from "../parse";
import { markOf, filterByMark, screenshotName, actualsFor, MARK_COLORS } from "../view";
import { assetPath } from "../../grill/view";
import newFormat from "./fixtures/new-format.md?raw";

const file = parseAcceptance(newFormat);

describe("marks", () => {
  it("classifies each test's mark", () => {
    expect(file.tests.map(markOf)).toEqual(["ok", "change", "unmarked"]);
    expect(Object.keys(MARK_COLORS).sort()).toEqual(["change", "ok", "unmarked"]);
  });

  it("filters by mark, keeping file order", () => {
    expect(filterByMark(file.tests, "all").map((t) => t.id)).toEqual(["AT-1", "AT-2", "AT-3"]);
    expect(filterByMark(file.tests, "unmarked").map((t) => t.id)).toEqual(["AT-3"]);
    expect(filterByMark(file.tests, "change").map((t) => t.id)).toEqual(["AT-2"]);
    expect(filterByMark(file.tests, "ok").map((t) => t.id)).toEqual(["AT-1"]);
  });
});

describe("matching validation screenshots to frames", () => {
  it("names a frame's screenshot by test id and 1-based frame index", () => {
    expect(screenshotName("AT-3", 0)).toBe("AT-3-1.png");
  });

  it("uses the latest round that has each frame's screenshot", () => {
    const rounds = [
      { round: 1, files: ["AT-1-1.png", "AT-1-3.png", "notes.json"] },
      { round: 2, files: ["AT-1-3.png"] },
      { round: 10, files: ["AT-2-1.png"] },
    ];
    expect(actualsFor(file.tests[0], rounds)).toEqual([
      { round: 1, file: "AT-1-1.png" },
      null,
      { round: 2, file: "AT-1-3.png" },
    ]);
    expect(actualsFor(file.tests[2], rounds)).toEqual([]);
  });
});

describe("asset confinement", () => {
  it("allows a chosen asset folder, still refusing escapes", () => {
    expect(assetPath("/f", "acceptance-assets/AT-1/1.html", "acceptance-assets")).toBe("/f/acceptance-assets/AT-1/1.html");
    expect(assetPath("/f", "grill-assets/A1/x.png", "acceptance-assets")).toBeNull();
    expect(assetPath("/f", "acceptance-assets/../x", "acceptance-assets")).toBeNull();
    expect(assetPath("/f", "grill-assets/A1/x.png")).toBe("/f/grill-assets/A1/x.png");
  });
});
