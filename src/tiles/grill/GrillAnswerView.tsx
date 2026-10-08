import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { editableRound, parseGrill, writableRounds, type Importance } from "../../domain/grill/parse";
import { addVisualRequest, finishRound, setAnswer, setImportance, type WriteResult } from "../../domain/grill/write";
import { IMPORTANCE_COLORS, navigableQuestions, optionAnswer, roundQuestions, selectedOption, type Threshold } from "../../domain/grill/view";
import { tauriGrillIo, updateGrillFile, type GrillIo } from "./grill-io";
import { QuestionCard } from "./QuestionCard";

export const ALWAYS_SHOW_RECO_SETTING = "grill.always-show-reco";
const SAVE_DELAY_MS = 500;
const POLL_MS = 2000;

const THRESHOLDS: { value: Threshold; label: string }[] = [
  { value: "All", label: "All questions" },
  { value: "Medium", label: "Medium and up" },
  { value: "High", label: "High and up" },
  { value: "Blocking", label: "Blocking only" },
];

/** Question ids repeat per round, so drafts and pending saves are keyed by both. */
const draftKey = (round: number, id: string) => `${round}:${id}`;

type Finish = { kind: "idle" } | { kind: "confirm"; defaulted: string[] } | { kind: "refused"; message: string };

/**
 * Answer mode for a grill-me.md (ADR 034): one question per screen, saved
 * into the file as you go. Only the round being answered can be changed;
 * nothing is sent to the session — you type `review` there when done.
 */
export function GrillAnswerView({ path, io = tauriGrillIo }: { path: string; io?: GrillIo }) {
  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [round, setRound] = useState<number | null>(null);
  const [filter, setFilter] = useState<{ threshold: Threshold; unansweredOnly: boolean }>({ threshold: "All", unansweredOnly: false });
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: "saved" | "saving" | "error"; message?: string } | null>(null);
  const [alwaysShowReco, setAlwaysShowReco] = useState(false);
  const [finish, setFinish] = useState<Finish>({ kind: "idle" });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<string, () => Promise<void>>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Writes queued or running; a reload never applies while any are. */
  const inFlight = useRef(0);
  /** Bumped by every edit and write, so a reload that started earlier is discarded. */
  const generation = useRef(0);
  const grillDir = path.split("/").slice(0, -1).join("/");

  const grill = useMemo(() => (text === null ? null : parseGrill(text)), [text]);
  const editable = grill && grill.rounds.length > 0 ? editableRound(grill) : null;
  const shownRound = round ?? editable;
  const writable = useMemo(() => (grill ? writableRounds(grill) : []), [grill]);
  const readOnly = shownRound === null || !writable.includes(shownRound);

  const reload = useCallback(async () => {
    const started = generation.current;
    try {
      const { text: next } = await io.read(path);
      if (started !== generation.current || inFlight.current > 0) return;
      setText(next);
      // Stay on the round you opened even if the agent appends another meanwhile.
      setRound((r) => {
        if (r !== null) return r;
        const parsed = parseGrill(next);
        return parsed.rounds.length > 0 ? editableRound(parsed) : null;
      });
      setLoadError(null);
    } catch (error) {
      setLoadError(`Could not read the grill: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [io, path]);

  useEffect(() => {
    void reload();
    // Pick up the agent's changes (a new round, a delivered visual), but never
    // while an answer is waiting to be saved.
    const interval = setInterval(() => {
      if (timers.current.size === 0 && pending.current.size === 0 && inFlight.current === 0) void reload();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [reload]);

  useEffect(() => {
    void invoke<string | null>("get_setting", { key: ALWAYS_SHOW_RECO_SETTING })
      .then((value) => setAlwaysShowReco(value === "1"))
      .catch(() => {});
  }, []);

  /** Runs one file edit after any earlier one, then shows the file as written. */
  const write = useCallback((edit: (text: string) => WriteResult): Promise<WriteResult> => {
    setStatus({ kind: "saving" });
    inFlight.current += 1;
    generation.current += 1;
    const run = queue.current.then(async () => {
      try {
        const result = await updateGrillFile(io, path, edit);
        if (result.ok) { generation.current += 1; setText(result.text); setStatus({ kind: "saved" }); }
        else setStatus({ kind: "error", message: result.error });
        return result;
      } finally {
        inFlight.current -= 1;
      }
    });
    queue.current = run.catch(() => {});
    return run;
  }, [io, path]);

  /** Cancels a debounced save that has not run yet. */
  const cancelPending = (key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    pending.current.delete(key);
  };

  const saveAnswer = useCallback(async (targetRound: number, id: string, answer: string) => {
    cancelPending(draftKey(targetRound, id));
    const key = draftKey(targetRound, id);
    const result = await write((t) => setAnswer(t, targetRound, id, answer));
    // A failed save keeps the draft on screen, so nothing typed is lost.
    if (!result.ok) return;
    setDrafts((all) => {
      if (all[key] !== answer) return all;
      const { [key]: _saved, ...rest } = all;
      return rest;
    });
  }, [write]);

  const onAnswer = useCallback((id: string, answer: string, immediate: boolean) => {
    if (shownRound === null || readOnly) return;
    const key = draftKey(shownRound, id);
    generation.current += 1;
    setDrafts((all) => ({ ...all, [key]: answer }));
    cancelPending(key);
    const targetRound = shownRound;
    const flush = () => saveAnswer(targetRound, id, answer);
    if (immediate) { void flush(); return; }
    pending.current.set(key, flush);
    timers.current.set(key, setTimeout(() => void flush(), SAVE_DELAY_MS));
  }, [readOnly, saveAnswer, shownRound]);

  /** Saves every draft whose save failed (drafts still being typed save themselves). */
  const retry = useCallback(() => {
    for (const [key, answer] of Object.entries(drafts)) {
      if (timers.current.has(key)) continue;
      const at = key.indexOf(":");
      void saveAnswer(Number(key.slice(0, at)), key.slice(at + 1), answer);
    }
  }, [drafts, saveAnswer]);

  const flushAll = useCallback(async () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    const flushes = [...pending.current.values()];
    pending.current.clear();
    await Promise.all(flushes.map((f) => f()));
    await queue.current;
  }, []);

  // Save whatever is still being typed when the view goes away.
  useEffect(() => () => { void flushAll(); }, [flushAll]);

  const questions = useMemo(
    () => (grill && shownRound !== null ? navigableQuestions(grill, shownRound, filter) : []),
    [grill, shownRound, filter],
  );
  let index = questions.findIndex((q) => q.id === currentId);
  if (index < 0 && grill && shownRound !== null && currentId !== null) {
    // The shown question left the filter (you answered it): show the next one still in it.
    const all = roundQuestions(grill, shownRound);
    const at = all.findIndex((q) => q.id === currentId);
    index = questions.findIndex((q) => all.indexOf(q) > at);
    if (index < 0) index = questions.length - 1;
  }
  if (index < 0) index = 0;
  const current = questions[index] ?? null;
  const go = (next: number) => {
    const target = questions[Math.max(0, Math.min(next, questions.length - 1))];
    if (target) setCurrentId(target.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight" || event.key === "Enter") { event.preventDefault(); go(index + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
    else if (/^[1-9]$/.test(event.key) && current && !readOnly) {
      const option = current.options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        const note = selectedOption(drafts[draftKey(current.round, current.id)] ?? current.answer, current.options)?.note ?? "";
        onAnswer(current.id, optionAnswer(option.key, note), true);
      }
    }
  };

  const startFinish = async () => {
    await flushAll();
    let now: string;
    try {
      now = (await io.read(path)).text;
    } catch (error) {
      setFinish({ kind: "refused", message: `Could not read the grill: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const preview = finishRound(now, { preview: true, round: shownRound ?? undefined });
    setFinish(preview.ok ? { kind: "confirm", defaulted: preview.defaulted } : { kind: "refused", message: preview.error });
  };

  const confirmFinish = async () => {
    setFinish({ kind: "idle" });
    const result = await write((t) => {
      const finished = finishRound(t, { round: shownRound ?? undefined });
      return finished.ok ? { ok: true, text: finished.text } : { ok: false, error: finished.error };
    });
    if (!result.ok) setFinish({ kind: "refused", message: result.error });
  };

  const toggleAlwaysShow = (on: boolean) => {
    setAlwaysShowReco(on);
    void invoke("set_setting", { key: ALWAYS_SHOW_RECO_SETTING, value: on ? "1" : "0" }).catch(() => {});
  };

  if (loadError) return <div role="alert" style={{ padding: 12, color: "#f38ba8", fontSize: 12 }}>{loadError}</div>;
  if (!grill) return <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>Loading…</div>;
  if (grill.questions.length === 0) {
    return <div data-testid="grill-answer-empty" style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>No questions found in this grill. Use Edit to see the file.</div>;
  }

  return (
    <div data-testid="grill-answer-view" tabIndex={0} onKeyDown={onKeyDown} style={rootStyle}>
      <div style={toolbarStyle}>
        <select
          aria-label="Round"
          data-testid="grill-round"
          value={shownRound ?? ""}
          onChange={(e) => { setRound(Number(e.target.value)); setCurrentId(null); setFinish({ kind: "idle" }); }}
          style={controlStyle}
        >
          {grill.rounds.map((r) => (
            <option key={r.number} value={r.number}>Round {r.number}{writable.includes(r.number) ? "" : " (read-only)"}</option>
          ))}
        </select>
        <select
          aria-label="Show"
          data-testid="grill-threshold"
          value={filter.threshold}
          onChange={(e) => setFilter({ ...filter, threshold: e.target.value as Threshold })}
          style={controlStyle}
        >
          {THRESHOLDS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <label style={checkStyle}>
          <input type="checkbox" data-testid="grill-unanswered-only" checked={filter.unansweredOnly}
            onChange={(e) => setFilter({ ...filter, unansweredOnly: e.target.checked })} />
          Unanswered only
        </label>
        <label style={checkStyle}>
          <input type="checkbox" data-testid="grill-always-show-reco" checked={alwaysShowReco}
            onChange={(e) => toggleAlwaysShow(e.target.checked)} />
          Always show recommendations
        </label>
        <span style={{ flex: 1 }} />
        {status && (
          <span data-testid="grill-save-status" role={status.kind === "error" ? "alert" : undefined}
            style={{ fontSize: 11, color: status.kind === "error" ? "#f38ba8" : "#6c7086" }}>
            {status.kind === "saving" ? "Saving…" : status.kind === "saved" ? "Saved" : status.message}
          </span>
        )}
        {status?.kind === "error" && Object.keys(drafts).length > 0 && (
          <button type="button" data-testid="grill-save-retry" onClick={retry} style={linkStyle}>Retry</button>
        )}
        {!readOnly && (
          <button type="button" data-testid="grill-finish" onClick={() => void startFinish()} style={buttonStyle}>Finish round</button>
        )}
      </div>

      {finish.kind === "refused" && (
        <div role="alert" data-testid="grill-finish-refused" style={{ ...bannerStyle, borderColor: "#f38ba8" }}>
          {finish.message}
          <button type="button" onClick={() => setFinish({ kind: "idle" })} style={linkStyle}>Dismiss</button>
        </div>
      )}
      {finish.kind === "confirm" && (
        <div data-testid="grill-finish-confirm" style={bannerStyle}>
          {finish.defaulted.length === 0
            ? "Every question is answered. Finishing changes nothing in the file."
            : `${finish.defaulted.length} unanswered question${finish.defaulted.length === 1 ? "" : "s"} (${finish.defaulted.join(", ")}) will take the recommendation, recorded as not reviewed.`}
          {" "}Then type review in the session.
          <button type="button" data-testid="grill-finish-ok" onClick={() => void confirmFinish()} style={buttonStyle}>Finish</button>
          <button type="button" onClick={() => setFinish({ kind: "idle" })} style={linkStyle}>Cancel</button>
        </div>
      )}

      <nav aria-label="Questions" data-testid="grill-strip" style={stripStyle}>
        {questions.map((q, i) => {
          const answered = (drafts[draftKey(q.round, q.id)] ?? q.answer) !== "";
          const color = IMPORTANCE_COLORS[q.importance];
          return (
            <button
              key={`${q.round}-${q.id}-${i}`}
              type="button"
              data-testid="grill-marker"
              data-id={q.id}
              data-importance={q.importance}
              data-answered={answered ? "true" : "false"}
              aria-current={i === index ? "step" : undefined}
              title={`${q.id}. ${q.title} — ${q.importance}${answered ? ", answered" : ""}`}
              onClick={() => setCurrentId(q.id)}
              style={{ ...markerStyle, borderColor: color, background: answered ? color : "transparent", outline: i === index ? "2px solid #cdd6f4" : "none" }}
            >
              {q.id}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 16px" }}>
        {current ? (
          <QuestionCard
            key={`${current.round}-${current.id}`}
            question={current}
            answer={drafts[draftKey(current.round, current.id)] ?? current.answer}
            readOnly={readOnly}
            alwaysShowRecommendation={alwaysShowReco}
            grillDir={grillDir}
            io={io}
            onAnswer={(answer, immediate) => onAnswer(current.id, answer, immediate)}
            onImportance={(level: Importance) => { if (shownRound !== null) void write((t) => setImportance(t, shownRound, current.id, level)); }}
            onRequestVisual={(note) => { if (shownRound !== null) void write((t) => addVisualRequest(t, shownRound, current.id, note)); }}
          />
        ) : (
          <div data-testid="grill-filter-empty" style={{ fontSize: 12, opacity: 0.6 }}>No questions match the filter.</div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 16px", borderTop: "1px solid #2a2a2a" }}>
        <button type="button" data-testid="grill-prev" disabled={index <= 0} onClick={() => go(index - 1)} style={buttonStyle}>← Previous</button>
        <span style={{ fontSize: 11, color: "#6c7086" }}>{questions.length > 0 ? `${index + 1} / ${questions.length}` : ""}</span>
        <button type="button" data-testid="grill-next" disabled={index >= questions.length - 1} onClick={() => go(index + 1)} style={buttonStyle}>Next →</button>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { height: "100%", display: "flex", flexDirection: "column", minHeight: 0, outline: "none" };
const toolbarStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 12px", borderBottom: "1px solid #2a2a2a" };
const controlStyle: CSSProperties = { background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 3, fontSize: 11 };
const checkStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#a6adc8" };
const buttonStyle: CSSProperties = { background: "#313244", color: "#cdd6f4", border: "none", borderRadius: 4, padding: "3px 10px", fontSize: 12, cursor: "pointer" };
const linkStyle: CSSProperties = { background: "transparent", color: "#89b4fa", border: "none", padding: "0 6px", fontSize: 12, cursor: "pointer" };
const bannerStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "6px 12px 0", padding: "6px 10px", border: "1px solid #313244", borderRadius: 4, fontSize: 12 };
const stripStyle: CSSProperties = { display: "flex", gap: 4, flexWrap: "wrap", padding: "6px 12px" };
const markerStyle: CSSProperties = { minWidth: 28, height: 20, border: "2px solid", borderRadius: 4, fontSize: 10, color: "#cdd6f4", cursor: "pointer", padding: "0 4px" };
