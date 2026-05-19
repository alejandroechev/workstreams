import type { SessionTodo, SessionTodoDep } from "../backend/types";

const STATUS_FILL: Record<string, string> = {
  done: "#16a34a",
  in_progress: "#eab308",
  blocked: "#dc2626",
  pending: "#6b7280",
  archived: "#111827",
};

function escapeLabel(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/\n/g, " ");
}

/**
 * Build a mermaid `graph TD` source from todos and their dependencies.
 * Nodes are labelled "title (status)" and colored by status.
 * Isolated nodes (no deps in or out) are still included.
 */
export function buildTodoDepsMermaid(
  todos: SessionTodo[],
  deps: SessionTodoDep[],
): string {
  if (todos.length === 0) {
    return "graph TD\n  empty[\"no todos\"]";
  }

  const byId = new Map(todos.map((t) => [t.id, t]));
  const lines: string[] = ["graph TD"];
  const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, "_");

  for (const t of todos) {
    const label = escapeLabel(`${t.title} (${t.status})`);
    lines.push(`  ${sanitize(t.id)}["${label}"]`);
  }

  for (const d of deps) {
    if (!byId.has(d.todo_id) || !byId.has(d.depends_on)) continue;
    lines.push(`  ${sanitize(d.depends_on)} --> ${sanitize(d.todo_id)}`);
  }

  for (const t of todos) {
    const fill = STATUS_FILL[t.status] ?? STATUS_FILL.pending;
    lines.push(
      `  style ${sanitize(t.id)} fill:${fill},stroke:#1f2937,color:#fff`,
    );
  }

  return lines.join("\n");
}
