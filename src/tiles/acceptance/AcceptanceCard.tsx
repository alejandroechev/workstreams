import { useState, type CSSProperties, type ReactNode } from "react";
import { MarkdownView } from "../../ui/MarkdownView";
import type { AcceptanceTestBlock, ReviewMark } from "../../domain/acceptance/parse";
import { MARK_COLORS, MARK_LABELS, markOf, type ValidationRound } from "../../domain/acceptance/view";
import type { AcceptanceIo } from "./acceptance-io";
import { Storyboard } from "./Storyboard";

export interface AcceptanceCardProps {
  test: AcceptanceTestBlock;
  readOnly: boolean;
  featureDir: string;
  io: AcceptanceIo;
  rounds: ValidationRound[];
  onMark(mark: ReviewMark | null): void;
  onRequestVisual(note: string): void;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 8, fontSize: 13 }}>
      <span style={{ color: "#6c7086", fontSize: 11, paddingTop: 2 }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </section>
  );
}

/** One acceptance test, full focus (ADR 037). */
export function AcceptanceCard({ test, readOnly, featureDir, io, rounds, onMark, onRequestVisual }: AcceptanceCardProps) {
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [requestNote, setRequestNote] = useState<string | null>(null);
  const mark = markOf(test);
  const md = (text: string) => <MarkdownView basePath={featureDir}>{text}</MarkdownView>;

  return (
    <article data-testid="acceptance-card" data-id={test.id} style={cardStyle}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: "#89b4fa", fontWeight: 600 }}>{test.id}</span>
        <h3 style={{ margin: 0, flex: 1, fontSize: 15, color: "#cdd6f4" }}>{test.title}</h3>
        {test.automation && <span style={chipStyle} title="How this test is expected to be run">{test.automation}</span>}
        <span data-testid="acceptance-card-mark" style={{ ...chipStyle, borderColor: MARK_COLORS[mark], color: MARK_COLORS[mark] }}>{MARK_LABELS[mark]}</span>
      </header>
      {test.validates && <div style={{ fontSize: 11, color: "#6c7086" }}>Validates {test.validates}</div>}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" data-testid="acceptance-mark-ok" disabled={readOnly} onClick={() => { setChangeNote(null); onMark({ kind: "ok" }); }}
          style={{ ...buttonStyle, background: mark === "ok" ? "#2b3d2b" : buttonStyle.background, color: mark === "ok" ? MARK_COLORS.ok : buttonStyle.color }}>
          Looks right
        </button>
        <button type="button" data-testid="acceptance-mark-change" disabled={readOnly}
          onClick={() => setChangeNote(test.review?.kind === "change" ? test.review.note : "")}
          style={{ ...buttonStyle, background: mark === "change" ? "#3d3a2b" : buttonStyle.background, color: mark === "change" ? MARK_COLORS.change : buttonStyle.color }}>
          Needs change…
        </button>
        <button type="button" data-testid="acceptance-mark-clear" disabled={readOnly || mark === "unmarked"} onClick={() => { setChangeNote(null); onMark(null); }} style={linkStyle}>
          Clear mark
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" data-testid="acceptance-request-visual" disabled={readOnly} onClick={() => setRequestNote("")} style={linkStyle}>
          Show me this
        </button>
      </div>
      {test.review?.kind === "change" && changeNote === null && (
        <div style={{ fontSize: 12, color: MARK_COLORS.change }}>Needs change: {test.review.note}</div>
      )}
      {changeNote !== null && !readOnly && (
        <form onSubmit={(e) => { e.preventDefault(); onMark({ kind: "change", note: changeNote }); setChangeNote(null); }} style={formStyle}>
          <input autoFocus aria-label="What should change?" data-testid="acceptance-change-note" placeholder="What should change?"
            value={changeNote} onChange={(e) => setChangeNote(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button type="submit" data-testid="acceptance-change-save" disabled={!changeNote.trim()} style={buttonStyle}>Save</button>
          <button type="button" onClick={() => setChangeNote(null)} style={linkStyle}>Cancel</button>
        </form>
      )}
      {requestNote !== null && !readOnly && (
        <form onSubmit={(e) => { e.preventDefault(); onRequestVisual(requestNote); setRequestNote(null); }} style={formStyle}>
          <input autoFocus aria-label="What should the storyboard show?" data-testid="acceptance-request-note"
            placeholder="What should it show? e.g. the error state" value={requestNote}
            onChange={(e) => setRequestNote(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button type="submit" data-testid="acceptance-request-submit" style={buttonStyle}>Request</button>
          <button type="button" onClick={() => setRequestNote(null)} style={linkStyle}>Cancel</button>
        </form>
      )}
      {test.visualRequests.map((note, i) => (
        <div key={i} data-testid="acceptance-visual-requested" style={{ fontSize: 11, color: "#f9e2af" }}>Visual requested: {note}</div>
      ))}

      {test.given && <Section label="Given">{md(test.given)}</Section>}
      {test.when && <Section label="When">{md(test.when)}</Section>}
      {test.then && <Section label="Then">{md(test.then)}</Section>}
      {test.frames.length > 0 && <Storyboard test={test} featureDir={featureDir} io={io} rounds={rounds} />}
      {test.passesWhen && (
        <div style={{ borderLeft: "3px solid #a6e3a1", padding: "6px 8px", background: "#181825", fontSize: 13 }}>
          <b>Passes when:</b> {md(test.passesWhen)}
        </div>
      )}
      {test.verifyHuman && <Section label="Verify (human)">{md(test.verifyHuman)}</Section>}
      {test.verifyAgent && <Section label="Verify (agent)">{md(test.verifyAgent)}</Section>}
    </article>
  );
}

const cardStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, maxWidth: 960, margin: "0 auto", width: "100%" };
const chipStyle: CSSProperties = { fontSize: 10, padding: "1px 6px", borderRadius: 8, border: "1px solid #45475a", color: "#a6adc8" };
const buttonStyle: CSSProperties = { background: "#313244", color: "#cdd6f4", border: "none", borderRadius: 4, padding: "4px 10px", fontSize: 12, cursor: "pointer" };
const linkStyle: CSSProperties = { background: "transparent", color: "#89b4fa", border: "none", padding: 0, fontSize: 12, cursor: "pointer" };
const inputStyle: CSSProperties = { background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 4, padding: "4px 6px", fontSize: 13, fontFamily: "inherit" };
const formStyle: CSSProperties = { display: "flex", gap: 6 };
