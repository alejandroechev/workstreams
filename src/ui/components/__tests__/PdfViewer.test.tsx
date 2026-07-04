import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PdfViewer } from "../PdfViewer";

describe("PdfViewer", () => {
  it("renders an iframe pointing at the blob URL", () => {
    render(<PdfViewer src="blob:pdf-1" title="report.pdf" testid="pdf-preview" />);
    const frame = screen.getByTestId("pdf-preview") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe("blob:pdf-1");
    expect(frame.getAttribute("title")).toBe("report.pdf");
  });

  it("shows an empty-state message when no src is provided", () => {
    render(<PdfViewer src={null} testid="pdf-preview" />);
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
    expect(screen.getByText(/no pdf/i)).toBeTruthy();
  });
});
