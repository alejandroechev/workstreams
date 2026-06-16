import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ZoomableImage } from "../ZoomableImage";

describe("ZoomableImage", () => {
  it("renders the image with src, alt and forwarded testid", () => {
    render(<ZoomableImage testid="img-preview" src="data:image/png;base64,AAAA" alt="logo" />);
    const container = screen.getByTestId("img-preview");
    expect(container).toBeTruthy();
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(img?.getAttribute("alt")).toBe("logo");
  });

  it("starts at 100% zoom", () => {
    render(<ZoomableImage testid="img" src="x" />);
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
  });

  it("zoom-in increases the zoom level", () => {
    render(<ZoomableImage testid="img" src="x" />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("125%");
  });

  it("zoom-out decreases the zoom level", () => {
    render(<ZoomableImage testid="img" src="x" />);
    fireEvent.click(screen.getByTestId("zoom-out"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("80%");
  });

  it("reset returns to 100% after zooming", () => {
    render(<ZoomableImage testid="img" src="x" />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    fireEvent.click(screen.getByTestId("zoom-in"));
    expect(screen.getByTestId("zoom-level").textContent).not.toBe("100%");
    fireEvent.click(screen.getByTestId("zoom-reset"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
  });

  it("double-click on the viewport resets zoom", () => {
    render(<ZoomableImage testid="img" src="x" />);
    fireEvent.click(screen.getByTestId("zoom-in"));
    fireEvent.doubleClick(screen.getByTestId("img"));
    expect(screen.getByTestId("zoom-level").textContent).toBe("100%");
  });
});
