import { useState, type CSSProperties } from "react";
import { MarkdownView } from "../../ui/MarkdownView";
import { IMPORTANCE_LEVELS, type GrillQuestion, type Importance } from "../../domain/grill/parse";
import { IMPORTANCE_COLORS, optionAnswer, selectedOption } from "../../domain/grill/view";
import type { GrillIo } from "./grill-io";
import { GrillVisualView } from "./GrillVisualView";

export interface QuestionCardProps {
  question: GrillQuestion;
  /** The answer as being edited (may be ahead of the file). */
  answer: string;
  readOnly: boolean;
  alwaysShowRecommendation: boolean;
  grillDir: string;
  io: GrillIo;
  /** `immediate`: save now rather than after the typing pause. */
  onAnswer(answer: string, immediate: boolean): void;
  onImportance(level: Importance): void;
  onRequestVisual(note: string): void;
}

/** One question, full focus (ADR 034). The recommendation stays hidden until asked for. */
export function QuestionCard(props: QuestionCardProps) {
  const { question, answer, readOnly, grillDir, io } = props;
  const [revealed, setRevealed] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [requestNote, setRequestNote] = useState<string | null>(null);
  const showReco = revealed || props.alwaysShowRecommendation;
  const picked = selectedOption(answer, question.options);
  const blocking = question.importance === "Blocking";
  const general = question.visuals.filter((v) => v.option === null);
  const visualsFor = (key: string) => question.visuals.filter((v) => v.option === key);
  const comparable = question.options.filter((o) => visualsFor(o.key).length > 0);

  return (
    <article data-testid="grill-question" data-id={question.id} style={cardStyle}>
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, color: "#cdd6f4" }}>{question.id}.</span>
        <h3 style={{ margin: 0, flex: 1, fontSize: 15, color: "#cdd6f4" }}>{question.title}</h3>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#a6adc8" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: IMPORTANCE_COLORS[question.importance] }} />
          <select
            aria-label="Importance"
            data-testid="grill-importance"
            value={question.importance}
            disabled={readOnly}
            onChange={(e) => props.onImportance(e.target.value as Importance)}
            style={selectStyle}
          >
            {IMPORTANCE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
          {question.importanceByUser && <span title="Set by you">(you)</span>}
          {question.importanceInferred && <span title="No importance in the file">(default)</span>}
        </label>
      </header>

      {question.context && (
        <div data-testid="grill-context" style={{ fontSize: 13 }}>
          <MarkdownView basePath={grillDir}>{question.context}</MarkdownView>
        </div>
      )}

      {general.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {general.map((v) => <GrillVisualView key={v.path} visual={v} grillDir={grillDir} io={io} />)}
        </div>
      )}

      {question.options.length > 0 && (
        <div role="radiogroup" aria-label="Options" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {question.options.map((option, index) => {
            const active = picked?.key === option.key;
            return (
              <div key={option.key} data-testid="grill-option-row" data-option={option.key}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`grill-option-${option.key}`}
                  disabled={readOnly}
                  onClick={() => props.onAnswer(optionAnswer(option.key, picked?.note ?? ""), true)}
                  style={{ ...optionStyle, borderColor: active ? "#89b4fa" : "#313244", background: active ? "#1e2a40" : "#181825" }}
                >
                  <kbd style={kbdStyle}>{index + 1}</kbd>
                  <span>({option.key}) {option.text}</span>
                </button>
                {!comparing && visualsFor(option.key).map((v) => (
                  <div key={v.path} style={{ marginTop: 4 }}><GrillVisualView visual={v} grillDir={grillDir} io={io} /></div>
                ))}
              </div>
            );
          })}
          {comparable.length >= 2 && (
            <button type="button" data-testid="grill-compare" onClick={() => setComparing(!comparing)} style={linkButtonStyle}>
              {comparing ? "Stop comparing" : "Compare options side by side"}
            </button>
          )}
          {comparing && (
            <div data-testid="grill-comparison" style={{ display: "grid", gridTemplateColumns: `repeat(${comparable.length}, minmax(0, 1fr))`, gap: 8 }}>
              {comparable.map((option) => (
                <div key={option.key} data-option={option.key} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>({option.key}) {option.text}</div>
                  {visualsFor(option.key).map((v) => <GrillVisualView key={v.path} visual={v} grillDir={grillDir} io={io} />)}
                </div>
              ))}
            </div>
          )}
          {picked && (
            <input
              aria-label="Note"
              data-testid="grill-option-note"
              placeholder="Add a note (optional)"
              value={picked.note}
              disabled={readOnly}
              onChange={(e) => props.onAnswer(optionAnswer(picked.key, e.target.value), false)}
              style={inputStyle}
            />
          )}
        </div>
      )}

      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#a6adc8" }}>
        Your answer
        <textarea
          data-testid="grill-answer"
          value={answer}
          disabled={readOnly}
          rows={3}
          onChange={(e) => props.onAnswer(e.target.value, false)}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>

      {question.recommendation && (
        <section data-testid="grill-recommendation" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {showReco ? (
            <div data-testid="grill-recommendation-text" style={{ fontSize: 13, borderLeft: "3px solid #a6e3a1", paddingLeft: 8 }}>
              <MarkdownView basePath={grillDir}>{question.recommendation}</MarkdownView>
            </div>
          ) : (
            <button type="button" data-testid="grill-reveal" onClick={() => setRevealed(true)} style={linkButtonStyle}>
              Show recommendation
            </button>
          )}
          {showReco && !readOnly && !blocking && (
            <button type="button" data-testid="grill-accept" onClick={() => props.onAnswer("reco", true)} style={buttonStyle}>
              Accept recommendation
            </button>
          )}
          {showReco && blocking && (
            <div style={{ fontSize: 11, color: IMPORTANCE_COLORS.Blocking }}>Blocking: this one needs your own answer.</div>
          )}
        </section>
      )}

      {question.visualRequests.map((note, i) => (
        <div key={i} data-testid="grill-visual-requested" style={{ fontSize: 11, color: "#f9e2af" }}>Visual requested: {note}</div>
      ))}
      {!readOnly && (requestNote === null ? (
        <button type="button" data-testid="grill-request-visual" onClick={() => setRequestNote("")} style={linkButtonStyle}>
          Show me this
        </button>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); props.onRequestVisual(requestNote); setRequestNote(null); }}
          style={{ display: "flex", gap: 6 }}
        >
          <input
            autoFocus
            aria-label="What should the visual show?"
            data-testid="grill-request-note"
            placeholder="What should it show? e.g. a prototype of option b"
            value={requestNote}
            onChange={(e) => setRequestNote(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="submit" data-testid="grill-request-submit" style={buttonStyle}>Request</button>
          <button type="button" onClick={() => setRequestNote(null)} style={linkButtonStyle}>Cancel</button>
        </form>
      ))}
    </article>
  );
}

const cardStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, maxWidth: 880, margin: "0 auto", width: "100%" };
const selectStyle: CSSProperties = { background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 3, fontSize: 11 };
const optionStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "6px 10px", border: "1px solid", borderRadius: 5, color: "#cdd6f4", cursor: "pointer", fontSize: 13 };
const kbdStyle: CSSProperties = { fontSize: 10, padding: "0 4px", borderRadius: 3, border: "1px solid #45475a", color: "#a6adc8" };
const inputStyle: CSSProperties = { background: "#181825", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 4, padding: "4px 6px", fontSize: 13, fontFamily: "inherit" };
const buttonStyle: CSSProperties = { alignSelf: "flex-start", background: "#313244", color: "#cdd6f4", border: "none", borderRadius: 4, padding: "4px 10px", fontSize: 12, cursor: "pointer" };
const linkButtonStyle: CSSProperties = { alignSelf: "flex-start", background: "transparent", color: "#89b4fa", border: "none", padding: 0, fontSize: 12, cursor: "pointer" };
