import { PencilSquareIcon, EyeIcon, PresentationChartBarIcon } from "@heroicons/react/24/outline";
import type { CSSProperties } from "react";
import type { MarkdownViewState, ViewMode } from "../../files/FileEditorView";

/**
 * Compact three-way segmented control for the markdown view modes
 * (Edit / Preview / Slides). Replaces the older pair of standalone toggle
 * buttons so a user can jump straight to any mode in one click. The Slides
 * segment is only shown when the file can be presented (markdown).
 *
 * Rendered by the three markdown-hosting tiles (Repo Explorer, Workbench,
 * Session Meta); `testIdPrefix` keeps their data-testids unique.
 */
export function MarkdownModeSelector({
  viewState,
  testIdPrefix,
}: {
  viewState: MarkdownViewState;
  testIdPrefix: string;
}) {
  const segments: { id: ViewMode; label: string; icon: typeof PencilSquareIcon; title: string }[] = [
    { id: "edit", label: "Edit", icon: PencilSquareIcon, title: "Edit (raw source)" },
    { id: "preview", label: "Preview", icon: EyeIcon, title: "Preview (rendered)" },
  ];
  if (viewState.canPresent) {
    segments.push({ id: "present", label: "Slides", icon: PresentationChartBarIcon, title: "Present as slides" });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Markdown view mode"
      data-testid={`${testIdPrefix}-mode-selector`}
      style={groupStyle}
    >
      {segments.map(({ id, label, icon: Icon, title }) => {
        const active = viewState.mode === id;
        // Map the present segment to the legacy testid suffix so existing
        // callers/tests keep working; edit/preview get explicit suffixes.
        const suffix = id === "present" ? "present-toggle" : `mode-${id}`;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`${testIdPrefix}-${suffix}`}
            onClick={() => viewState.setMode(id)}
            title={title}
            style={{
              ...segmentStyle,
              background: active ? "#313244" : "transparent",
              color: active ? "#cdd6f4" : "#7f849c",
            }}
          >
            <Icon style={{ width: 13, height: 13 }} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

const groupStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 1,
  padding: 2,
  borderRadius: 5,
  background: "#181825",
  border: "1px solid #313244",
};

const segmentStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  border: "none",
  borderRadius: 3,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};

