/**
 * Messages agents send to the Inbox (ADR 041). The native side
 * (`src-tauri/src/inbox_messages.rs`) is the source of truth; this mirror
 * serves the in-memory backend and the Inbox's grouping.
 */
export const AGENT_MESSAGE_LEVELS = ["info", "done", "needs-you", "error"] as const;
export type AgentMessageLevel = (typeof AGENT_MESSAGE_LEVELS)[number];
export const MAX_TITLE = 120;
export const MAX_BODY = 20_000;
export const HOURLY_CAP = 20;

export interface AgentMessage {
  id: string;
  workstream_id: string;
  /** The workstream's current name, or the one it had when it is gone. */
  workstream_name: string;
  tile_id: string;
  level: string;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
  /** Whether the sending session (and its workstream) still exists. */
  available: boolean;
}

/** Why a message would be refused, or null. Same wording as natively. */
export function checkAgentMessage(level: string, title: string, body: string): string | null {
  if (!(AGENT_MESSAGE_LEVELS as readonly string[]).includes(level)) {
    return `level must be one of ${AGENT_MESSAGE_LEVELS.join(", ")}; got "${level}"`;
  }
  const titleLength = [...title.trim()].length;
  if (titleLength === 0) return "title is required";
  if (titleLength > MAX_TITLE) return `title is ${titleLength} characters; the limit is ${MAX_TITLE}`;
  const bodyLength = [...body].length;
  if (bodyLength > MAX_BODY) return `body is ${bodyLength} characters; the limit is ${MAX_BODY}`;
  return null;
}

export interface AgentMessageGroup {
  workstream_id: string;
  workstream_name: string;
  messages: AgentMessage[];
}

export function groupAgentMessages(messages: AgentMessage[]): AgentMessageGroup[] {
  const newest = [...messages].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const groups = new Map<string, AgentMessageGroup>();
  for (const message of newest) {
    const group = groups.get(message.workstream_id)
      ?? { workstream_id: message.workstream_id, workstream_name: message.workstream_name, messages: [] };
    group.messages.push(message);
    groups.set(message.workstream_id, group);
  }
  return [...groups.values()];
}

export function levelLabel(level: string): string {
  return { info: "Info", done: "Done", "needs-you": "Needs you", error: "Error" }[level] ?? level;
}

/** The first two non-empty lines of a markdown body, without list/heading marks. */
export function previewLines(body: string): string[] {
  return body.split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "").trim())
    .filter(Boolean)
    .slice(0, 2);
}
