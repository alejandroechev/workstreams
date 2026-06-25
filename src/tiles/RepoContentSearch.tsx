import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useContentSearch, type UseContentSearchOptions } from "../files/useContentSearch";
import { computeHighlightSegments, groupMatchesByFile } from "../domain/content-search";

interface Props {
  /** Directory to search under (the tile's current dir). */
  currentDir: string;
  /** Open a match: the host opens the file and jumps to `line`. */
  onOpenMatch: (path: string, line: number) => void;
  /** Search tuning (debounce/minLength/limit). Mainly for tests. */
  options?: UseContentSearchOptions;
  /** Seed the query on mount (restored from persisted view-state). */
  initialQuery?: string;
  /** Notified whenever the query changes, so the host can persist it. */
  onQueryChange?: (query: string) => void;
}

/**
 * Content-search ("search all files") panel for the Repo Explorer Search tab.
 * Renders a query input and results grouped by file, each row showing the line
 * number + a preview with the matched substring highlighted. Clicking or
 * pressing Enter on a row opens the file at that line via `onOpenMatch`.
 *
 * All heavy lifting (debounce, cancellation, the off-thread backend walk) lives
 * in `useContentSearch`; this component is presentation + keyboard nav only.
 */
export function RepoContentSearch({ currentDir, onOpenMatch, options, initialQuery, onQueryChange }: Props) {
  const { query, setQuery, results, loading, truncated } = useContentSearch(currentDir, {
    ...options,
    initialQuery: options?.initialQuery ?? initialQuery,
  });

  // Report query changes upward so the host can persist the last query.
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);

  const groups = useMemo(() => groupMatchesByFile(results, currentDir), [results, currentDir]);

  // Flattened list of (path, line) for keyboard navigation across all matches.
  const flat = useMemo(
    () => results.map((r) => ({ path: r.path, line: r.line_number })),
    [results],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const setSelected = (next: number) => {
    selectedIndexRef.current = next;
    setSelectedIndex(next);
  };
  useEffect(() => {
    selectedIndexRef.current = 0;
    setSelectedIndex(0);
  }, [results]);

  const inputRef = useRef<HTMLInputElement>(null);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (flat.length === 0) {
      if (e.key === "Escape") setQuery("");
      return;
    }
    const cur = selectedIndexRef.current;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.min(flat.length - 1, cur + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = flat[selectedIndexRef.current];
      if (sel) onOpenMatch(sel.path, sel.line);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  const hasQuery = query.trim().length > 0;
  const showEmpty = hasQuery && !loading && results.length === 0;

  return (
    <div style={panelStyle} data-testid="content-search-panel">
      <div style={inputRowStyle}>
        <MagnifyingGlassIcon style={{ width: 14, height: 14, color: "#6c7086", flexShrink: 0 }} />
        <input
          ref={inputRef}
          data-testid="content-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search all files…"
          style={inputStyle}
        />
      </div>

      <div style={statusRowStyle}>
        {loading && <span data-testid="content-search-loading">Searching…</span>}
        {!loading && truncated && (
          <span data-testid="content-search-truncated" style={{ color: "#f9e2af" }}>
            Showing first {results.length} results — refine your query
          </span>
        )}
        {showEmpty && (
          <span data-testid="content-search-empty" style={{ color: "#6c7086" }}>
            No matches
          </span>
        )}
      </div>

      <div style={resultsStyle}>
        {groups.map((g) => (
          <div key={g.path} data-testid={`content-search-group-${g.relPath}`}>
            <div style={groupHeaderStyle}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {g.relPath}
              </span>
              <span style={countBadgeStyle}>{g.matches.length}</span>
            </div>
            {g.matches.map((mtch) => {
              const flatIdx = flat.findIndex(
                (f) => f.path === mtch.path && f.line === mtch.line_number,
              );
              const selected = flatIdx === selectedIndex;
              return (
                <div
                  key={`${mtch.path}:${mtch.line_number}`}
                  data-testid={`content-search-match-${mtch.path}-${mtch.line_number}`}
                  onClick={() => onOpenMatch(mtch.path, mtch.line_number)}
                  onMouseEnter={() => flatIdx >= 0 && setSelected(flatIdx)}
                  style={{ ...rowStyle, background: selected ? "#313244" : "transparent" }}
                >
                  <span style={lineNoStyle}>{mtch.line_number}</span>
                  <span style={lineTextStyle}>
                    {computeHighlightSegments(mtch.line_text, query).map((seg, i) =>
                      seg.match ? (
                        <mark key={i} style={markStyle}>
                          {seg.text}
                        </mark>
                      ) : (
                        <span key={i}>{seg.text}</span>
                      ),
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  background: "#1e1e2e",
  color: "#cdd6f4",
};

const inputRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 10px",
  borderBottom: "1px solid #313244",
};

const inputStyle: CSSProperties = {
  flex: 1,
  background: "#11111b",
  border: "1px solid #313244",
  borderRadius: 4,
  color: "#cdd6f4",
  padding: "4px 8px",
  fontSize: 12,
  outline: "none",
};

const statusRowStyle: CSSProperties = {
  minHeight: 18,
  padding: "2px 10px",
  fontSize: 11,
  color: "#a6adc8",
};

const resultsStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  fontSize: 12,
};

const groupHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "4px 10px",
  background: "#181825",
  borderTop: "1px solid #313244",
  borderBottom: "1px solid #25253a",
  color: "#89b4fa",
  position: "sticky",
  top: 0,
};

const countBadgeStyle: CSSProperties = {
  flexShrink: 0,
  background: "#313244",
  borderRadius: 8,
  padding: "0 6px",
  fontSize: 10,
  color: "#cdd6f4",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "2px 10px 2px 18px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const lineNoStyle: CSSProperties = {
  color: "#6c7086",
  minWidth: 36,
  textAlign: "right",
  flexShrink: 0,
  userSelect: "none",
};

const lineTextStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const markStyle: CSSProperties = {
  background: "#f9e2af",
  color: "#11111b",
  borderRadius: 2,
};
