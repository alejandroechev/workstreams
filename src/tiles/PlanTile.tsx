// @test-skip: pre-existing tile shell pattern; pure helpers/backends tested separately
import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownView } from "../ui/MarkdownView";
import { MermaidDiagram } from "../ui/MermaidDiagram";
import { useBackend } from "../backend/context";
import { buildTodoDepsMermaid } from "../domain/todo-deps-mermaid";
import { parseViewState } from "../domain/tile-view-state";
import { useTileViewStatePersist } from "../domain/useTileViewStatePersist";
import type {
  SessionPlanEntry,
  SessionTodo,
  SessionTodoDep,
} from "../backend/types";
import {
  DocumentTextIcon,
  ClipboardDocumentListIcon,
  ShareIcon,
  ClockIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from "@heroicons/react/24/outline";

interface Props {
  tileId: string;
  isFocused: boolean;
  linkedSessionIds?: string[];
  configJson?: string;
  onConfigChange?: (configJson: string) => void;
  workstreamVisible?: boolean;
}

type TabId = "plan" | "todos" | "graph" | "history";

const STATUS_ORDER = ["in_progress", "pending", "blocked", "done", "archived"];

const STATUS_COLORS: Record<string, string> = {
  done: "#16a34a",
  in_progress: "#eab308",
  blocked: "#dc2626",
  pending: "#6b7280",
  archived: "#111827",
};

function groupByStatus(todos: SessionTodo[]): Record<string, SessionTodo[]> {
  const out: Record<string, SessionTodo[]> = {};
  for (const t of todos) {
    (out[t.status] ??= []).push(t);
  }
  return out;
}

function TodoList({ todos }: { todos: SessionTodo[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (todos.length === 0) {
    return <div style={{ padding: 12, opacity: 0.6 }}>No todos for this plan.</div>;
  }
  const grouped = groupByStatus(todos);
  return (
    <div style={{ padding: 8 }}>
      {STATUS_ORDER.filter((s) => grouped[s]?.length).map((status) => (
        <div key={status} style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              color: STATUS_COLORS[status],
              marginBottom: 4,
              fontWeight: 600,
            }}
          >
            {status} ({grouped[status].length})
          </div>
          {grouped[status].map((t) => {
            const isOpen = expanded.has(t.id);
            return (
              <div
                key={t.id}
                style={{
                  border: "1px solid #2a2a2a",
                  borderRadius: 4,
                  marginBottom: 4,
                  background: "#1a1a1a",
                }}
              >
                <button
                  onClick={() => {
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(t.id)) next.delete(t.id);
                      else next.add(t.id);
                      return next;
                    });
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: "#eee",
                    padding: "6px 8px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {isOpen ? (
                    <ChevronDownIcon style={{ width: 14, height: 14 }} />
                  ) : (
                    <ChevronRightIcon style={{ width: 14, height: 14 }} />
                  )}
                  <span style={{ fontFamily: "monospace", fontSize: 12, opacity: 0.7 }}>
                    {t.id}
                  </span>
                  <span style={{ fontSize: 13 }}>{t.title}</span>
                </button>
                {isOpen && t.description && (
                  <div
                    style={{
                      padding: "0 8px 8px 28px",
                      fontSize: 12,
                      color: "#bbb",
                      whiteSpace: "pre-wrap",
                    }}
                  >
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
  const [activeTab, setActiveTab] = useState<TabId>("plan");
  const [planMd, setPlanMd] = useState<string | null>(null);
  const [plans, setPlans] = useState<SessionPlanEntry[]>([]);
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);
  const [todos, setTodos] = useState<SessionTodo[]>([]);
  const [deps, setDeps] = useState<SessionTodoDep[]>([]);
  const [selectedHistoryPlanId, setSelectedHistoryPlanId] = useState<string | null>(null);
  const [historySubTab, setHistorySubTab] = useState<"plan" | "todos">("plan");
  const [loadedAt, setLoadedAt] = useState<number>(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [p, cp, td, de] = await Promise.all([
        backend.listSessionPlans(sessionId),
        backend.getCurrentSessionPlan(sessionId),
        backend.listSessionTodos(sessionId),
        backend.listSessionTodoDeps(sessionId),
      ]);
      setPlans(p);
      setCurrentPlanId(cp);
      setTodos(td);
      setDeps(de);
      try {
        const md = await invoke<string>("read_session_file", {
          sessionId,
          relativePath: "plan.md",
        });
        setPlanMd(md);
      } catch {
        setPlanMd(null);
      }
      setLoadedAt(Date.now());
    } catch (err) {
      console.error("PlanTile load failed", err);
    }
  }, [backend, sessionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!workstreamVisible || hydratedRef.current) return;
    hydratedRef.current = true;
    const vs = parseViewState(configJson, "plan");
    if (vs.activeTab) setActiveTab(vs.activeTab as TabId);
    if (vs.selectedHistoryPlanId) setSelectedHistoryPlanId(vs.selectedHistoryPlanId);
    if (vs.historySubTab === "plan" || vs.historySubTab === "todos") {
      setHistorySubTab(vs.historySubTab);
    }
  }, [workstreamVisible, configJson]);

  useTileViewStatePersist(
    configJson,
    "plan",
    {
      activeTab,
      selectedHistoryPlanId: selectedHistoryPlanId ?? undefined,
      historySubTab,
    },
    onConfigChange,
    { enabled: hydratedRef.current },
  );

  const currentTodos = todos.filter((t) => t.plan_id === currentPlanId);
  const mermaidSrc = buildTodoDepsMermaid(currentTodos, deps);

  const selectedPlan = plans.find((p) => p.id === selectedHistoryPlanId);
  const selectedPlanTodos = todos.filter(
    (t) => t.plan_id === selectedHistoryPlanId,
  );

  if (!sessionId) {
    return (
      <div style={{ padding: 16, color: "#aaa" }}>
        No Copilot session linked to this workstream. Link a session in the project
        to see its plan.
      </div>
    );
  }

  const tabs: { id: TabId; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; count: number }[] = [
    { id: "plan", label: "Plan", icon: DocumentTextIcon, count: 0 },
    { id: "todos", label: "Todos", icon: ClipboardDocumentListIcon, count: currentTodos.length },
    { id: "graph", label: "Graph", icon: ShareIcon, count: deps.length },
    { id: "history", label: "History", icon: ClockIcon, count: plans.length },
  ];

  return (
    <div
      data-testid="plan-tile"
      style={{ display: "flex", flexDirection: "column", height: "100%", color: "#eee" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid #2a2a2a",
          background: "#181818",
        }}
      >
        {tabs.map(({ id, label, icon: Icon, count }) => (
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
            {count > 0 && (
              <span
                style={{
                  background: "#333",
                  borderRadius: 8,
                  padding: "0 6px",
                  fontSize: 10,
                }}
              >
                {count}
              </span>
            )}
          </button>
        ))}
        <button
          onClick={() => void load()}
          title="Refresh"
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            color: "#aaa",
            cursor: "pointer",
            padding: 8,
          }}
        >
          <ArrowPathIcon style={{ width: 14, height: 14 }} />
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {activeTab === "plan" && (
          <div style={{ padding: 12 }}>
            {planMd === null ? (
              <div style={{ opacity: 0.6 }}>No plan.md found in session.</div>
            ) : (
              <MarkdownView>{planMd}</MarkdownView>
            )}
          </div>
        )}

        {activeTab === "todos" && <TodoList todos={currentTodos} />}

        {activeTab === "graph" && (
          <div style={{ height: "100%" }}>
            <MermaidDiagram source={mermaidSrc} />
          </div>
        )}

        {activeTab === "history" && (
          <div style={{ display: "flex", height: "100%" }}>
            <div
              style={{
                width: 260,
                borderRight: "1px solid #2a2a2a",
                overflow: "auto",
                background: "#161616",
              }}
            >
              {plans.length === 0 && (
                <div style={{ padding: 12, opacity: 0.6 }}>No plans recorded yet.</div>
              )}
              {plans.map((p) => (
                <button
                  key={p.id}
                  data-testid={`plan-history-row-${p.id}`}
                  onClick={() => setSelectedHistoryPlanId(p.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background:
                      selectedHistoryPlanId === p.id ? "#2a2a2a" : "transparent",
                    border: "none",
                    borderBottom: "1px solid #222",
                    color: "#eee",
                    padding: "8px 10px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 12 }}>
                    {p.title ?? p.id}{" "}
                    {p.id === currentPlanId && (
                      <span style={{ color: "#16a34a", fontSize: 10 }}>(active)</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>
                    {p.status} · {p.created_at}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {!selectedPlan && (
                <div style={{ padding: 12, opacity: 0.6 }}>Select a plan to view.</div>
              )}
              {selectedPlan && (
                <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                  <div style={{ display: "flex", borderBottom: "1px solid #2a2a2a" }}>
                    {(["plan", "todos"] as const).map((sub) => (
                      <button
                        key={sub}
                        onClick={() => setHistorySubTab(sub)}
                        style={{
                          background: historySubTab === sub ? "#2a2a2a" : "transparent",
                          border: "none",
                          color: "#eee",
                          padding: "6px 10px",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        {sub === "plan" ? "Plan snapshot" : `Todos (${selectedPlanTodos.length})`}
                      </button>
                    ))}
                  </div>
                  <div style={{ flex: 1, overflow: "auto" }}>
                    {historySubTab === "plan" && (
                      <div style={{ padding: 12 }}>
                        {selectedPlan.plan_md_snapshot ? (
                          <MarkdownView>{selectedPlan.plan_md_snapshot}</MarkdownView>
                        ) : (
                          <div style={{ opacity: 0.6 }}>
                            No plan.md snapshot stored for this plan.
                          </div>
                        )}
                      </div>
                    )}
                    {historySubTab === "todos" && <TodoList todos={selectedPlanTodos} />}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          fontSize: 10,
          color: "#666",
          padding: "2px 8px",
          borderTop: "1px solid #2a2a2a",
          background: "#141414",
        }}
      >
        {loadedAt > 0 ? `Last sync: ${new Date(loadedAt).toLocaleTimeString()}` : "Loading..."}
      </div>
    </div>
  );
}
