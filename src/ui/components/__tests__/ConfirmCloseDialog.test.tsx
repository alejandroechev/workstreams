import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ConfirmCloseDialog from "../ConfirmCloseDialog";

describe("ConfirmCloseDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<ConfirmCloseDialog open={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the dialog when open", () => {
    render(<ConfirmCloseDialog open onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("confirm-close-dialog")).toBeTruthy();
  });

  it("invokes onConfirm with dontAskAgain=false by default", () => {
    const onConfirm = vi.fn();
    render(<ConfirmCloseDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId("confirm-close-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("invokes onConfirm with dontAskAgain=true when checkbox is checked", () => {
    const onConfirm = vi.fn();
    render(<ConfirmCloseDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId("confirm-close-dont-ask"));
    fireEvent.click(screen.getByTestId("confirm-close-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("invokes onCancel from cancel button", () => {
    const onCancel = vi.fn();
    render(<ConfirmCloseDialog open onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("confirm-close-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("invokes onCancel on Escape key", () => {
    const onCancel = vi.fn();
    render(<ConfirmCloseDialog open onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("invokes onConfirm on Enter key", () => {
    const onConfirm = vi.fn();
    render(<ConfirmCloseDialog open onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(false);
    cleanup();
  });
});
