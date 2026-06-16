// @test-skip: tile shell composition; pure helpers + component tests live separately
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { MarkdownView } from "../ui/MarkdownView";
import { MermaidDiagram } from "../ui/MermaidDiagram";
import { useBackend } from "../backend/context";
import { buildTodoDepsMermaid } from "../domain/todo-deps-mermaid";
import { parseViewState } from "../domain/tile-view-state";
import { useTileViewStatePersist } from "../domain/useTileViewStatePersist";
import {
  applyFilter,
  sortByLastTouchedDesc,
  todosForPlan,
  type FeatureFilter,
} from "../domain/feature-discovery";
import type {
  FeatureSummary,
  SessionFeaturesPayload,
  SessionTodo,
  SessionTodoDep,
} from "../backend/types";
import {
  DocumentTextIcon,
  ClipboardDocumentListIcon,
  ShareIcon,
  ChartBarSquareIcon,
  ChatBubbleLeftRightIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";

interface Props {
  tileId: string;
  isFocused: boolean;
  linkedSessionIds?: string[];
  configJson?: string;
  onConfigChange?: (configJson: string) => void;
  workstreamVisible?: boolean;
}

type TabId = "overview" | "plan" | "todos" | "graph" | "grill";

const TABS: { id: TabId; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }[] = [
  { id: "overview", label: "Overview", icon: ChartBarSquareIcon },
  { id: "plan", label: "Plan", icon: DocumentTextIcon },
  { id: "todos", label: "Todos", icon: ClipboardDocumentListIcon },
  { id: "graph", label: "Graph", icon: ShareIcon },
  { id: "grill", label: "Grill", icon: ChatBubbleLeftRightIcon },
];

const STATUS_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  drafting: { bg: "#3a3a52", fg: "#cdd6f4", label: "Drafting" },
  active: { bg: "#1f4d2b", fg: "#a6e3a1", label: "Active" },
  completed: { bg: "#2e3252", fg: "#89b4fa", label: "Completed" },
  archived: { bg: "#3a3a3a", fg: "#999", label: "Archived" },
  orphan: { bg: "#5a2a2a", fg: "#f38ba8", label: "Orphan" },
};

function StatusPill({ status }: { status: FeatureSummary["derivedStatus"] }) {
  const s = STATUS_COLORS[status] ?? STATUS_COLORS.drafting;
  return (
    <span
      data-testid={`feature-status-pill-${status}`}
      style={{
        background: s.bg,
        color: s.fg,
        padding: "1px 6px",
        borderRadius: 3,
        fontSize: 9,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {s.label}
    </span>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  if (total === 0) {
    return <span style={{ color: "#666", fontSize: 10 }}>—</span>;
  }
  const pct = Math.round((done / total) * 100);
  return (
    <div
      data-testid="feature-progress-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10,
        color: "#aaa",
        width: "100%",
      }}
    >
      <div
        style={{
          flex: 1,
          height: 4,
          background: "#1e1e2e",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: "#a6e3a1" }} />
      </div>
      <span>
        {done}/{total}
      </span>
    </div>
  );
}

function TodoList({ todos }: { todos: SessionTodo[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (todos.length === 0) {
    return <div style={{ padding: 12, opacity: 0.6 }}>No todos for this plan.</div>;
  }
  const groups: Record<string, SessionTodo[]> = {};
  for (const t of todos) {
    (groups[t.status] ??= []).push(t);
  }
  const order = ["in_progress", "pending", "blocked", "done", "archived"];
  return (
    <div style={{ padding: 12 }}>
      {order
        .filter((s) => groups[s])
        .map((status) => (
          <div key={status} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>
              {status} ({groups[status].length})
            </div>
            {groups[status].map((t) => {
              const isOpen = expanded.has(t.id);
              return (
                <div
                  key={t.id}
                  style={{
                    padding: 6,
                    borderLeft: "2px solid #313244",
                    marginBottom: 4,
                    fontSize: 12,
                    cursor: t.description ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (!t.description) return;
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(t.id)) next.delete(t.id);
                      else next.add(t.id);
                      return next;
                    });
                  }}
                >
                  <div>
                    <span style={{ opacity: 0.5 }}>{t.id}</span> · {t.title}
                  </div>
                  {isOpen && t.description && (
                    <div style={{ marginTop: 4, fontSize: 11, color: "#aaa", whiteSpace: "pre-wrap" }}>
                      {t.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}

export default function PlanTile({ linkedSessionIds, configJson, onConfigChange, workstreamVisible = true }: Props) {
  const backend = useBackend();
  const sessionId = linkedSessionIds?.[0];

  const [payload, setPayload] = useState<SessionFeaturesPayload>({ features: [], currentPlanId: null });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeatureFilter>("active");
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [planMd, setPlanMd] = useState<string | null>(null);
  const [grillMd, setGrillMd] = useState<string | null>(null);
  const [todos, setTodos] = useState<SessionTodo[]>([]);
  const [deps, setDeps] = useState<SessionTodoDep[]>([]);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const p = await backend.listSessionFeatures(sessionId);
      setPayload(p);
    } catch (err) {
      console.error("PlanTile listSessionFeatures failed", err);
    }
  }, [backend, sessionId]);

  // Initial load + subscribe to backend events. No polling.
  useEffect(() => {
    if (!sessionId) return;
    let unlisten: UnlistenFn | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    void load();
    void backend.watchSessionFeatures(sessionId).catch(() => {});
    listen<{ sessionId: string }>("session-features-changed", (event) => {
      if (event.payload?.sessionId !== sessionId) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 200);
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => {
      if (debounce) clearTimeout(debounce);
      if (unlisten) unlisten();
      backend.unwatchSessionFeatures(sessionId).catch(() => {});
    };
  }, [backend, sessionId, load]);

  // Per-feature heavier loads when the selection changes.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const feat = payload.features.find((f) => f.name === selectedName);
    if (!feat) {
      setPlanMd(null);
      setGrillMd(null);
      setTodos([]);
      setDeps([]);
      return;
    }
    Promise.all([
      feat.hasPlan
        ? invoke<string>("read_session_file", {
            sessionId,
            relativePath: `files/features/${feat.name}/plan.md`,
          }).catch(() => null)
        : Promise.resolve(null),
      feat.hasGrillMe
        ? invoke<string>("read_session_file", {
            sessionId,
            relativePath: `files/features/${feat.name}/grill-me.md`,
          }).catch(() => null)
        : Promise.resolve(null),
      backend.listSessionTodos(sessionId).catch(() => [] as SessionTodo[]),
      backend.listSessionTodoDeps(sessionId).catch(() => [] as SessionTodoDep[]),
    ]).then(([plan, grill, allTodos, allDeps]) => {
      if (cancelled) return;
      setPlanMd(plan);
      setGrillMd(grill);
      setTodos(allTodos);
      setDeps(allDeps);
    });
    return () => { cancelled = true; };
  }, [backend, sessionId, selectedName, payload.features]);

  // View-state hydration (per Q2.9: drop stale keys silently).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!workstreamVisible || hydratedRef.current) return;
    hydratedRef.current = true;
    const vs = parseViewState(configJson, "plan");
    if (vs.activeTab && TABS.some((t) => t.id === vs.activeTab)) {
      setActiveTab(vs.activeTab as TabId);
    }
  }, [workstreamVisible, configJson]);

  useTileViewStatePersist(
    configJson,
    "plan",
    { activeTab },
    onConfigChange,
    { enabled: hydratedRef.current },
  );

  const sortedFiltered = useMemo(
    () => sortByLastTouchedDesc(applyFilter(payload.features, filter)),
    [payload.features, filter],
  );

  // Keep the selection valid: when the filtered list changes and the
  // current selection is no longer visible, snap to the first row.
  useEffect(() => {
    if (sortedFiltered.length === 0) {
      if (selectedName !== null) setSelectedName(null);
      return;
    }
    if (selectedName && sortedFiltered.some((f) => f.name === selectedName)) return;
    setSelectedName(sortedFiltered[0].name);
  }, [sortedFiltered, selectedName]);

  if (!sessionId) {
    return (
      <div data-testid="plan-tile" style={{ padding: 16, color: "#aaa" }}>
        No Copilot session linked to this workstream. Link a session to see its plans.
      </div>
    );
  }

  const selected = sortedFiltered.find((f) => f.name === selectedName) ?? null;

  return (
    <div data-testid="plan-tile" style={{ display: "flex", flexDirection: "column", height: "100%", color: "#eee" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Sidebar */}
        <div
          data-testid="plan-sidebar"
          style={{
            width: 240,
            borderRight: "1px solid #2a2a2a",
            display: "flex",
            flexDirection: "column",
            background: "#161616",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: "6px 8px",
              borderBottom: "1px solid #2a2a2a",
            }}
          >
            {(["active", "completed", "all"] as const).map((f) => (
              <button
                key={f}
                data-testid={`plan-filter-${f}`}
                onClick={() => setFilter(f)}
                style={{
                  background: filter === f ? "#313244" : "transparent",
                  border: "none",
                  color: filter === f ? "#89b4fa" : "#aaa",
                  padding: "3px 8px",
                  fontSize: 11,
                  borderRadius: 3,
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {f}
              </button>
            ))}
            <button
              onClick={() => void load()}
              title="Refresh now"
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                color: "#aaa",
                cursor: "pointer",
                padding: 2,
              }}
              data-testid="plan-refresh"
            >
              <ArrowPathIcon style={{ width: 13, height: 13 }} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {sortedFiltered.length === 0 && (
              <div style={{ padding: 12, opacity: 0.6, fontSize: 11 }}>
                {payload.features.length === 0
                  ? "No features yet. Run grill-me in the linked Copilot session to start planning a feature."
                  : "No features match the current filter."}
              </div>
            )}
            {sortedFiltered.map((f) => {
              const isSelected = f.name === selectedName;
              const isCurrent = f.planId !== null && f.planId === payload.currentPlanId;
              return (
                <button
                  key={f.name}
                  data-testid={`feature-row-${f.name}`}
                  onClick={() => setSelectedName(f.name)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: isSelected ? "#2a2a2a" : "transparent",
                    border: "none",
                    borderBottom: "1px solid #222",
                    color: "#eee",
                    padding: "8px 10px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    {isCurrent && (
                      <span
                        data-testid="feature-current-dot"
                        title="Copilot's currently active plan"
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: "#f9e2af",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.name}
                    </span>
                    <StatusPill status={f.derivedStatus} />
                  </div>
                  <ProgressBar done={f.todosDone} total={f.todosTotal} />
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail pane */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {selected === null ? (
            <div style={{ padding: 16, color: "#888", fontSize: 12 }}>
              Select a feature on the left.
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid #2a2a2a",
                  background: "#181818",
                }}
              >
                {TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    data-testid={`plan-tab-${id}`}
                    onClick={() => setActiveTab(id)}
                    style={{
                      background: activeTab === id ? "#2a2a2a" : "transparent",
                      border: "none",
                      borderBottom: activeTab === id ? "2px solid #89b4fa" : "2px solid transparent",
                      color: "#eee",
                      padding: "8px 12px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <Icon style={{ width: 14, height: 14 }} />
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
                {activeTab === "overview" && (
                  <OverviewTab
                    feature={selected}
                    todos={todosForPlan(todos, selected.planId)}
                    onComplete={
                      selected.planId && selected.derivedStatus === "active"
                        ? async () => {
                            if (!sessionId || !selected.planId) return;
                            await backend.completeSessionPlan(sessionId, selected.planId).catch(() => {});
                            await load();
                          }
                        : undefined
                    }
                  />
                )}
                {activeTab === "plan" && (
                  <div style={{ padding: 12 }}>
                    {planMd === null ? (
                      <div style={{ opacity: 0.6, fontSize: 12 }}>
                        {selected.hasPlan
                          ? "Loading plan.md…"
                          : "No plan.md yet — run feature-plan in the linked Copilot session after answering grill-me."}
                      </div>
                    ) : (
                      <MarkdownView>{planMd}</MarkdownView>
                    )}
                  </div>
                )}
                {activeTab === "todos" && (
                  <TodoList todos={todosForPlan(todos, selected.planId)} />
                )}
                {activeTab === "graph" && (
                  <div style={{ height: "100%" }}>
                    <MermaidDiagram
                      source={buildTodoDepsMermaid(
                        todosForPlan(todos, selected.planId),
                        deps,
                      )}
                    />
                  </div>
                )}
                {activeTab === "grill" && (
                  <div style={{ padding: 12 }}>
                    {grillMd === null ? (
                      <div style={{ opacity: 0.6, fontSize: 12 }}>
                        {selected.hasGrillMe
                          ? "Loading grill-me.md…"
                          : "No grill-me.md yet — run the grill-me skill in the linked session."}
                      </div>
                    ) : (
                      <MarkdownView>{grillMd}</MarkdownView>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ feature, todos, onComplete }: { feature: FeatureSummary; todos: SessionTodo[]; onComplete?: () => void }) {
  const doneIds = new Set(todos.filter((t) => t.status === "done").map((t) => t.id));
  const ready = todos.filter((t) => t.status === "pending");
  // We don't filter by deps here (would need todo_deps); a future
  // enhancement can scope to "no incomplete deps".
  const inProgress = todos.filter((t) => t.status === "in_progress");
  const recentlyDone = todos.filter((t) => doneIds.has(t.id)).slice(-3).reverse();
  const openCount = feature.todosTotal - feature.todosDone;

  return (
    <div style={{ padding: 16, color: "#eee", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{feature.planTitle ?? feature.name}</h2>
        <StatusPill status={feature.derivedStatus} />
        {onComplete && (
          <button
            data-testid="plan-complete-button"
            onClick={() => {
              const msg = openCount > 0
                ? `Mark this plan completed? ${openCount} todo(s) are still open.`
                : "Mark this plan completed?";
              if (typeof window !== "undefined" && !window.confirm(msg)) return;
              onComplete();
            }}
            style={{
              marginLeft: "auto",
              background: "#1f4d2b",
              color: "#a6e3a1",
              border: "1px solid #2e6b3c",
              borderRadius: 4,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
            title="Flip plan status to completed (mirrors the complete-feature-plan skill)"
          >
            Complete plan
          </button>
        )}
      </div>
      <div style={{ marginBottom: 12 }}>
        <ProgressBar done={feature.todosDone} total={feature.todosTotal} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 4, fontSize: 12, marginBottom: 16 }}>
        <div style={{ color: "#888" }}>Plan id</div><div>{feature.planId ?? <em style={{ opacity: 0.6 }}>—</em>}</div>
        <div style={{ color: "#888" }}>Created</div><div>{feature.planCreatedAt ?? <em style={{ opacity: 0.6 }}>—</em>}</div>
        <div style={{ color: "#888" }}>Last touched</div><div>{feature.lastTouchedAt || <em style={{ opacity: 0.6 }}>—</em>}</div>
        <div style={{ color: "#888" }}>Folder</div>
        <div style={{ fontFamily: "monospace", fontSize: 11 }}>
          {feature.planPath ?? feature.grillMePath ?? <em style={{ opacity: 0.6 }}>orphan</em>}
        </div>
      </div>

      {feature.derivedStatus === "drafting" && (
        <div style={{ padding: 10, background: "#1e1e2e", borderRadius: 4, color: "#888", fontSize: 12, marginBottom: 12 }}>
          No plan yet — run <code style={{ background: "#0d0d12", padding: "1px 4px", borderRadius: 2 }}>feature plan</code> after answering grill-me to materialise it.
        </div>
      )}
      {feature.derivedStatus === "orphan" && (
        <div style={{ padding: 10, background: "#1e1e2e", borderRadius: 4, color: "#f38ba8", fontSize: 12, marginBottom: 12 }}>
          Folder is missing on disk. The plan row still exists in the session DB.
        </div>
      )}

      {inProgress.length > 0 && (
        <Section title={`In progress (${inProgress.length})`} todos={inProgress.slice(0, 5)} />
      )}
      {ready.length > 0 && (
        <Section title={`Ready to start (${ready.length})`} todos={ready.slice(0, 5)} />
      )}
      {recentlyDone.length > 0 && (
        <Section title="Recently completed" todos={recentlyDone} />
      )}
    </div>
  );
}

function Section({ title, todos }: { title: string; todos: SessionTodo[] }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>{title}</div>
      {todos.map((t) => (
        <div key={t.id} style={{ padding: "4px 8px", fontSize: 12 }}>
          <span style={{ opacity: 0.5 }}>{t.id}</span> · {t.title}
        </div>
      ))}
    </div>
  );
}
