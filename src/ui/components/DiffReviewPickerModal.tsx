import { useEffect } from "react";
import type { DiffReview } from "../../domain/diff-review";

interface Props {
  reviews: DiffReview[];
  onPick: (reviewId: string) => void;
  onClose: () => void;
}

type ReviewWithChunkCount = DiffReview & { total_chunks?: number };

function formatSource(review: DiffReview): string {
  if (review.diff_source === "working_tree") return "working tree";
  return [review.diff_source, review.source_ref].filter(Boolean).join(" ");
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function chunkLabel(review: DiffReview): string {
  const count = (review as ReviewWithChunkCount).total_chunks ?? 0;
  return `${count} ${count === 1 ? "chunk" : "chunks"}`;
}

export default function DiffReviewPickerModal({ reviews, onPick, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="diff-review-picker-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="diff-review-picker-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(17, 17, 27, 0.78)",
        color: "#cdd6f4",
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
      }}
    >
      <section
        style={{
          width: "min(560px, calc(100vw - 32px))",
          maxHeight: "min(640px, calc(100vh - 32px))",
          overflow: "auto",
          background: "#1e1e2e",
          border: "1px solid #45475a",
          borderRadius: 10,
          boxShadow: "0 18px 48px rgba(0,0,0,0.55)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "16px 18px",
            borderBottom: "1px solid #313244",
          }}
        >
          <h2 id="diff-review-picker-title" style={{ margin: 0, fontSize: 18, color: "#cdd6f4" }}>
            Pick a diff review
          </h2>
          <button
            type="button"
            data-testid="diff-review-picker-close"
            onClick={onClose}
            aria-label="Close diff review picker"
            style={{
              background: "transparent",
              border: "1px solid #45475a",
              borderRadius: 6,
              color: "#a6adc8",
              cursor: "pointer",
              padding: "4px 8px",
              fontSize: 14,
            }}
          >
            Close
          </button>
        </header>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
          {reviews.map((review) => (
            <article
              key={review.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 14,
                padding: 12,
                background: "#181825",
                border: "1px solid #313244",
                borderRadius: 8,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#89b4fa" }}>{formatSource(review)}</div>
                <div style={{ marginTop: 4, display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#a6adc8" }}>
                  <span>{formatCreatedAt(review.created_at)}</span>
                  <span>{chunkLabel(review)}</span>
                </div>
              </div>
              <button
                type="button"
                data-testid={`diff-review-picker-open-${review.id}`}
                onClick={() => onPick(review.id)}
                style={{
                  background: "#89b4fa",
                  border: "none",
                  borderRadius: 6,
                  color: "#11111b",
                  cursor: "pointer",
                  fontWeight: 700,
                  padding: "7px 12px",
                }}
              >
                Open
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
