import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { GrillVisualView } from "../GrillVisualView";
import { PROTOTYPE_CSP } from "../../../domain/grill/view";
import { memoryGrillIo } from "./memory-io";

afterEach(cleanup);

const DIR = "/f";
const visual = (path: string) => ({ path, label: "Label", option: null });

describe("a grill visual", () => {
  it("shows an image from the grill's assets", async () => {
    const io = memoryGrillIo("", { "/f/grill-assets/A1/shot.png": "PNG" });
    render(<GrillVisualView visual={visual("grill-assets/A1/shot.png")} grillDir={DIR} io={io} />);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${btoa("PNG")}`));
    expect(screen.getByText("Label")).toBeTruthy();
  });

  it("runs a prototype in a sandboxed frame with no network, its own images inlined", async () => {
    const io = memoryGrillIo("", {
      "/f/grill-assets/A1/proto.html": `<html><head></head><body><img src="logo.png"><img src="../../secret.png"></body></html>`,
      "/f/grill-assets/A1/logo.png": "LOGO",
    });
    render(<GrillVisualView visual={visual("grill-assets/A1/proto.html")} grillDir={DIR} io={io} />);
    const frame = await screen.findByTestId("grill-prototype");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toContain(PROTOTYPE_CSP);
    expect(doc).toContain(`src="data:image/png;base64,${btoa("LOGO")}"`);
    expect(doc).toContain(`src="../../secret.png"`);
    expect(io.readBase64).toHaveBeenCalledTimes(1);
  });

  it("refuses files outside the grill's assets", async () => {
    const io = memoryGrillIo("");
    render(<GrillVisualView visual={visual("../other/x.png")} grillDir={DIR} io={io} />);
    expect((await screen.findByRole("alert")).textContent).toContain("outside this grill's grill-assets folder");
    expect(io.readBase64).not.toHaveBeenCalled();
  });

  it("explains files it cannot show", async () => {
    render(<GrillVisualView visual={visual("grill-assets/A1/notes.pdf")} grillDir={DIR} io={memoryGrillIo("")} />);
    expect((await screen.findByRole("alert")).textContent).toContain("not an image or an HTML prototype");
  });

  it("reports a missing image or prototype", async () => {
    const io = memoryGrillIo("");
    io.read.mockRejectedValue(new Error("no such file"));
    render(<GrillVisualView visual={visual("grill-assets/A1/gone.png")} grillDir={DIR} io={io} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load grill-assets/A1/gone.png");
    cleanup();
    render(<GrillVisualView visual={visual("grill-assets/A1/gone.html")} grillDir={DIR} io={io} />);
    expect((await screen.findByRole("alert")).textContent).toContain("no such file");
  });
});
