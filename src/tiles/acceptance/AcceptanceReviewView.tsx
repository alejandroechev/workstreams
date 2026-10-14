import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { parseAcceptance, type ReviewMark } from "../../domain/acceptance/parse";
import { addMissing, addVisualRequest, setReview } from "../../domain/acceptance/write";
import { filterByMark, MARK_COLORS, MARK_LABELS, markOf, type MarkFilter, type ValidationRound } from "../../domain/acceptance/view";
import type { WriteResult } from "../../domain/grill/write";
import { updateGrillFile } from "../grill/grill-io";
import { tauriAcceptanceIo, validationRounds, type AcceptanceIo } from "./acceptance-io";
import { AcceptanceCard } from "./AcceptanceCard";

const POLL_MS = 2000;
const FILTERS: { value: MarkFilter; label: string }[] = [
  { value: "all", label: "All tests" },
  { value: "unmarked", label: "Not reviewed" },
  { value: "change", label: "Needs change" },
  { value: "ok", label: "Looks right" },
];

/**
 * Review mode for a feature's acceptance.md (ADR 037): one test per screen in
 * file order, marks written into the file, storyboards with the latest
 * validation screenshots beside them. Approval stays a word typed in the
 * session; once the file says approved, nothing here writes it.
 */
export function AcceptanceReviewView({ path, io = tauriAcceptanceIo }: { path: string; io?: AcceptanceIo }) {
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rounds, setRounds] = useState<ValidationRound[]>([]);
  const [filter, setFilter] = useState<MarkFilter>("all");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "saving" | "saved" | "error"; message?: string } | null>(null);
  const [missingNote, setMissingNote] = useState("");
  const inFlight = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const featureDir = path.split("/").slice(0, -1).join("/");

  const reload = useCallback(async () => {
    try {
      const { text: next } = await io.read(path);
      if (inFlight.current > 0) return;
      setText(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(`Could not read the acceptance tests: ${error instanceof Error ? error.message : String(error)}`);
    }
    setRounds(await validationRounds(io, featureDir));
  }, [featureDir, io, path]);

  useEffect(() => {
    void reload();
    const interval = setInterval(() => { if (inFlight.current === 0) void reload(); }, POLL_MS);
    return () => clearInterval(interval);
  }, [reload]);

  const file = useMemo(() => (text === null ? null : parseAcceptance(text)), [text]);
  const readOnly = file?.status !== "draft";

  const write = useCallback((edit: (text: string) => WriteResult) => {
    setStatus({ kind: "saving" });
    inFlight.current += 1;
    const run = queue.current.then(async () => {
      try {
        const result = await updateGrillFile(io, path, edit);
        if (result.ok) { setText(result.text); setStatus({ kind: "saved" }); }
        else setStatus({ kind: "error", message: result.error });
        return result;
      } finally {
        inFlight.current -= 1;
      }
    });
    queue.current = run.catch(() => {});
    return run;
  }, [io, path]);

  const tests = useMemo(() => (file ? filterByMark(file.tests, filter) : []), [file, filter]);
  let index = tests.findIndex((t) => t.id === currentId);
  if (index < 0) index = 0;
  const current = tests[index] ?? null;
  const go = (next: number) => {
    const target = tests[Math.max(0, Math.min(next, tests.length - 1))];
    if (target) setCurrentId(target.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight" || event.key === "Enter") { event.preventDefault(); go(index + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
  };

  if (loadError && text === null) return <div role="alert" style={{ padding: 12, color: "#f38ba8", fontSize: 12 }}>{loadError}</div>;
  if (!file) return <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>Loading…</div>;
  if (file.tests.length === 0) {
    return <div data-testid="acceptance-review-empty" style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>No acceptance tests found in this file. Use List to see the recorded ones.</div>;
  }

  return (
    <div data-testid="acceptance-review-view" tabIndex={0} onKeyDown={onKeyDown} style={rootStyle}>
      <div style={toolbarStyle}>
        <span data-testid="acceptance-status" style={{ fontSize: 11, color: readOnly ? "#a6e3a1" : "#f9e2af" }}>
          {readOnly
            ? "Approved — read-only. Results are recorded in List."
            : "Draft — marks are saved into the file. Type “review” or “approve” in the session when done."}
        </span>
        <span style={{ flex: 1 }} />
        <select aria-label="Show" data-testid="acceptance-filter" value={filter}
          onChange={(e) => { setFilter(e.target.value as MarkFilter); setCurrentId(null); }} style={controlStyle}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        {status && (
          <span data-testid="acceptance-save-status" role={status.kind === "error" ? "alert" : undefined}
            style={{ fontSize: 11, color: status.kind === "error" ? "#f38ba8" : "#6c7086" }}>
            {status.kind === "saving" ? "Saving…" : status.kind === "saved" ? "Saved" : status.message}
          </span>
        )}
      </div>

      <nav aria-label="Tests" data-testid="acceptance-strip" style={stripStyle}>
        {tests.map((test, i) => {
          const mark = markOf(test);
          return (
            <button key={`${test.id}-${i}`} type="button" data-testid="acceptance-marker" data-id={test.id} data-mark={mark}
              aria-current={i === index ? "step" : undefined} title={`${test.id}. ${test.title} — ${MARK_LABELS[mark]}`}
              onClick={() => setCurrentId(test.id)}
              style={{ ...markerStyle, borderColor: MARK_COLORS[mark], background: mark === "unmarked" ? "transparent" : MARK_COLORS[mark], color: mark === "unmarked" ? "#cdd6f4" : "#11111b", outline: i === index ? "2px solid #cdd6f4" : "none" }}>
              {test.id.replace("AT-", "")}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
        {current ? (
          <AcceptanceCard
            key={current.id}
            test={current}
            readOnly={readOnly}
            featureDir={featureDir}
            io={io}
            rounds={rounds}
            onMark={(mark: ReviewMark | null) => { if (!readOnly) void write((t) => setReview(t, current.id, mark)); }}
            onRequestVisual={(note) => { if (!readOnly) void write((t) => addVisualRequest(t, current.id, note)); }}
          />
        ) : (
          <div data-testid="acceptance-filter-empty" style={{ fontSize: 12, opacity: 0.6 }}>No tests match the filter.</div>
        )}

        <section style={{ maxWidth: 960, margin: "0 auto", width: "100%", borderTop: "1px solid #313244", paddingTop: 10, fontSize: 12 }}>
          <div style={{ color: "#a6adc8", marginBottom: 6 }}>Missing tests</div>
          <ul data-testid="acceptance-missing-list" style={{ margin: "0 0 6px", paddingLeft: 18 }}>
            {file.missing.map((note, i) => <li key={i}>{note}</li>)}
            {file.missing.length === 0 && <li style={{ listStyle: "none", marginLeft: -18, opacity: 0.6 }}>None noted.</li>}
          </ul>
          <form onSubmit={(e) => { e.preventDefault(); if (readOnly) return; const note = missingNote; void write((t) => addMissing(t, note)).then((r) => { if (r.ok) setMissingNote(""); }); }}
            style={{ display: "flex", gap: 6 }}>
            <input aria-label="A test you expected but don't see" data-testid="acceptance-missing-note" disabled={readOnly}
              placeholder="A test you expected but don't see" value={missingNote} onChange={(e) => setMissingNote(e.target.value)}
              style={{ ...inputStyle, flex: 1 }} />
            <button type="submit" data-testid="acceptance-missing-add" disabled={readOnly || !missingNote.trim()} style={buttonStyle}>Add</button>
          </form>
        </section>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 16px", borderTop: "1px solid #2a2a2a" }}>
        <button type="button" data-testid="acceptance-prev" disabled={index <= 0} onClick={() => go(index - 1)} style={buttonStyle}>← Previous</button>
        <span style={{ fontSize: 11, color: "#6c7086" }}>{tests.length > 0 ? `${index + 1} / ${tests.length}` : ""}</span>
        <button type="button" data-testid="acceptance-next" disabled={index >= tests.length - 1} onClick={() => go(index + 1)} style={buttonStyle}>Next →</button>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { height: "100%", display: "flex", flexDirection: "column", minHeight: 0, outline: "none" };
const toolbarStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 12px", borderBottom: "1px solid #2a2a2a" };
const controlStyle: CSSProperties = { background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 3, fontSize: 11 };
const buttonStyle: CSSProperties = { background: "#313244", color: "#cdd6f4", border: "none", borderRadius: 4, padding: "3px 10px", fontSize: 12, cursor: "pointer" };
const inputStyle: CSSProperties = { background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 4, padding: "4px 6px", fontSize: 13, fontFamily: "inherit" };
const stripStyle: CSSProperties = { display: "flex", gap: 4, flexWrap: "wrap", padding: "6px 12px" };
const markerStyle: CSSProperties = { minWidth: 24, height: 20, border: "2px solid", borderRadius: 4, fontSize: 10, cursor: "pointer", padding: "0 4px" };
