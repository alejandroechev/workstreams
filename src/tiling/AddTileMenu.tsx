/**
 * AddTileMenu — single "+ Add tile" button that opens a dropdown listing all
 * available tile types with their default icons. Replaces the row of
 * per-type buttons (+ Session, + Terminal, etc.) in the status bar.
 */
import { createElement, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, PlusIcon } from "@heroicons/react/24/outline";
import { TILE_ICONS, type TileIconKey } from "./tile-icons";

export interface TileMenuItem {
  key: string;
  label: string;
  icon: TileIconKey;
  shortcut?: string;
  onSelect: () => void;
}

interface Props {
  items: TileMenuItem[];
  buttonStyle?: React.CSSProperties;
}

export default function AddTileMenu({ items, buttonStyle }: Props) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[highlightIdx];
        if (item) {
          setOpen(false);
          item.onSelect();
        }
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, items, highlightIdx]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => {
          setOpen((v) => !v);
          setHighlightIdx(0);
        }}
        style={{
          background: open ? "#313244" : "transparent",
          border: "1px solid #45475a",
          borderRadius: 4,
          color: "#cdd6f4",
          cursor: "pointer",
          fontSize: 11,
          padding: "4px 8px",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          ...(buttonStyle ?? {}),
        }}
        title="Add tile"
        data-testid="add-tile-button"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <PlusIcon style={{ width: 12, height: 12 }} />
        <span>Add tile</span>
        <ChevronDownIcon style={{ width: 10, height: 10, opacity: 0.6 }} />
      </button>
      {open && (
        <div
          role="menu"
          data-testid="add-tile-menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            right: 0,
            background: "#1e1e2e",
            border: "1px solid #45475a",
            borderRadius: 6,
            boxShadow: "0 6px 16px rgba(0,0,0,0.5)",
            minWidth: 200,
            padding: 4,
            zIndex: 100,
          }}
        >
          {items.map((item, i) => {
            const Icon = TILE_ICONS[item.icon];
            const isHighlight = i === highlightIdx;
            return (
              <button
                key={item.key}
                role="menuitem"
                data-testid={`add-tile-item-${item.key}`}
                onMouseEnter={() => setHighlightIdx(i)}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 10px",
                  background: isHighlight ? "#313244" : "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: "#cdd6f4",
                  fontSize: 12,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {createElement(Icon, { style: { width: 14, height: 14, color: "#89b4fa", flexShrink: 0 } })}
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.shortcut && (
                  <span style={{ fontSize: 10, color: "#6c7086" }}>{item.shortcut}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
