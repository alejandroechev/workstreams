import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { OpenTabs } from "../domain/open-tabs";
import { FileIcon as FileIconBase } from "../ui/components/FileIcon";
const FileIcon = (p: { name: string; isDir: boolean }) => <FileIconBase {...p} size={13} />;

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

export interface OpenTabsBarProps {
  tabs: OpenTabs;
  /** The file on screen; null while browsing the tree (no tab is active). */
  shownPath: string | null;
  /** The shown file when it has unsaved changes. */
  dirtyPath?: string | null;
  onSelect(path: string): void;
  onKeep(path: string): void;
  onClose(path: string): void;
  onCloseOthers(path: string): void;
  onCloseRight(path: string): void;
  onCloseAll(): void;
  onTogglePin(path: string): void;
  onReveal(path: string): void;
}

/** The Repo Explorer's open files, as tabs (preview in italics). */
export function OpenTabsBar(props: OpenTabsBarProps) {
  const { tabs, shownPath, dirtyPath } = props;
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", onKey); };
  }, [menu]);
  if (tabs.tabs.length === 0) return null;
  const pinned = menu ? tabs.tabs.find((t) => t.path === menu.path)?.pinned : false;
  const act = (fn: () => void) => () => { setMenu(null); fn(); };
  return (
    <div
      data-testid="open-file-tabs"
      style={{ display: "flex", overflowX: "auto", background: "#181825", borderBottom: "1px solid #313244", flexShrink: 0, scrollbarWidth: "thin" }}
    >
      {tabs.tabs.map((tab) => {
        const active = tab.path === shownPath;
        return (
          <div
            key={tab.path}
            data-testid="open-file-tab"
            data-path={tab.path}
            data-active={active ? "true" : "false"}
            data-preview={tab.preview ? "true" : "false"}
            data-pinned={tab.pinned ? "true" : "false"}
            title={tab.path}
            onClick={() => props.onSelect(tab.path)}
            onDoubleClick={() => props.onKeep(tab.path)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); props.onClose(tab.path); } }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ path: tab.path, x: e.clientX, y: e.clientY }); }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 6px 3px 9px",
              fontSize: 12,
              whiteSpace: "nowrap",
              cursor: "pointer",
              userSelect: "none",
              fontStyle: tab.preview ? "italic" : "normal",
              color: active ? "#cdd6f4" : "#7f849c",
              background: active ? "#1e1e2e" : "transparent",
              borderRight: "1px solid #313244",
              borderTop: active ? "2px solid #cba6f7" : "2px solid transparent",
            }}
          >
            <span style={{ width: 13, display: "flex" }}><FileIcon name={baseName(tab.path)} isDir={false} /></span>
            {baseName(tab.path)}
            {dirtyPath === tab.path && <span style={{ color: "#f9e2af" }}>●</span>}
            <button
              data-testid="open-file-tab-close"
              aria-label={`Close ${baseName(tab.path)}`}
              onClick={(e) => { e.stopPropagation(); props.onClose(tab.path); }}
              style={{ background: "transparent", border: "none", color: "inherit", padding: 1, cursor: "pointer", display: "flex", opacity: active ? 1 : 0.6 }}
            >
              <XMarkIcon style={{ width: 11, height: 11 }} />
            </button>
          </div>
        );
      })}
      {menu && (
        <div
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 1000, background: "#181825", border: "1px solid #45475a", borderRadius: 6, padding: 4, minWidth: 160, fontSize: 12, boxShadow: "0 6px 18px #0008" }}
        >
          {[
            ["Close others", () => props.onCloseOthers(menu.path)],
            ["Close to the right", () => props.onCloseRight(menu.path)],
            ["Close all", () => props.onCloseAll()],
            [pinned ? "Unpin" : "Pin", () => props.onTogglePin(menu.path)],
            ["Reveal in tree", () => props.onReveal(menu.path)],
          ].map(([label, fn]) => (
            <button
              key={label as string}
              role="menuitem"
              onClick={act(fn as () => void)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: "#cdd6f4", padding: "5px 8px", borderRadius: 4, cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#313244"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {label as string}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ctrl+Tab: open files, most recently used first; release Ctrl to open. */
export function TabSwitcher({ paths, index }: { paths: string[]; index: number }) {
  return (
    <div
      data-testid="tab-switcher"
      role="listbox"
      style={{ position: "absolute", left: "50%", top: 60, transform: "translateX(-50%)", zIndex: 50, background: "#181825", border: "1px solid #cba6f7", borderRadius: 6, padding: 4, minWidth: 240, boxShadow: "0 6px 20px #000a", fontSize: 12 }}
    >
      {paths.map((path, i) => (
        <div
          key={path}
          data-testid="tab-switcher-item"
          role="option"
          aria-selected={i === index}
          title={path}
          style={{ display: "flex", gap: 6, alignItems: "center", padding: "5px 8px", borderRadius: 4, background: i === index ? "#313244" : "transparent", color: "#cdd6f4" }}
        >
          <span style={{ width: 13, display: "flex" }}><FileIcon name={baseName(path)} isDir={false} /></span>
          {baseName(path)}
        </div>
      ))}
    </div>
  );
}
