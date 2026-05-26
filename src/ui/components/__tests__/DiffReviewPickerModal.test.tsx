import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import DiffReviewPickerModal from "../DiffReviewPickerModal";
import type { DiffReview } from "../../../domain/diff-review";

function makeReview(overrides: Partial<DiffReview> & { id: string }): DiffReview {
  return {
    id: overrides.id,
    workstream_id: overrides.workstream_id ?? "ws-1",
    diff_source: overrides.diff_source ?? "working_tree",
    source_ref: overrides.source_ref ?? null,
    status: overrides.status ?? "active",
    plan_json: overrides.plan_json ?? null,
    exported_path: overrides.exported_path ?? null,
    created_at: overrides.created_at ?? "2026-05-26T12:34:56.000Z",
    updated_at: overrides.updated_at ?? "2026-05-26T12:34:56.000Z",
    completed_at: overrides.completed_at ?? null,
  };
}

describe("DiffReviewPickerModal", () => {
  afterEach(() => cleanup());

  it("renders the title, review rows, and an Open button per review", () => {
    render(
      <DiffReviewPickerModal
        reviews={[
          { ...makeReview({ id: "rev-1", diff_source: "working_tree" }), total_chunks: 3 } as DiffReview,
          { ...makeReview({ id: "rev-2", diff_source: "branch", source_ref: "master" }), total_chunks: 5 } as DiffReview,
        ]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("diff-review-picker-modal")).toBeTruthy();
    expect(screen.getByText("Pick a diff review")).toBeTruthy();
    expect(screen.getByText("working tree")).toBeTruthy();
    expect(screen.getByText("branch master")).toBeTruthy();
    expect(screen.getByText("3 chunks")).toBeTruthy();
    expect(screen.getByText("5 chunks")).toBeTruthy();
    expect(screen.getByTestId("diff-review-picker-open-rev-1")).toBeTruthy();
    expect(screen.getByTestId("diff-review-picker-open-rev-2")).toBeTruthy();
  });

  it("clicking Open calls onPick with the selected review id", () => {
    const onPick = vi.fn();
    render(
      <DiffReviewPickerModal
        reviews={[makeReview({ id: "rev-1" })]}
        onPick={onPick}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("diff-review-picker-open-rev-1"));

    expect(onPick).toHaveBeenCalledWith("rev-1");
  });

  it("clicking the close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <DiffReviewPickerModal
        reviews={[makeReview({ id: "rev-1" })]}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("diff-review-picker-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <DiffReviewPickerModal
        reviews={[makeReview({ id: "rev-1" })]}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
