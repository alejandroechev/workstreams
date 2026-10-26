import { countUnreadPrs, type PrInboxItem } from "./pr-inbox";

/** Which finished runs of a watched pipeline notify (ADR 038). Mirrors the native `PipelineMode`. */
export type PipelineMode = "off" | "failures" | "successes" | "both";

export const PIPELINE_MODES: PipelineMode[] = ["off", "failures", "successes", "both"];

export const PIPELINE_MODE_LABELS: Record<PipelineMode, string> = {
  off: "Off",
  failures: "Failures",
  successes: "Successes",
  both: "Both",
};

export function isPipelineMode(value: string): value is PipelineMode {
  return (PIPELINE_MODES as string[]).includes(value);
}

/**
 * Only `failed` is a failure and only `succeeded` a success: partial successes
 * and cancels never notify, though they still show as a pipeline's last result.
 */
export function pipelineModeWatches(mode: PipelineMode, result: string): boolean {
  if (result === "failed") return mode === "failures" || mode === "both";
  if (result === "succeeded") return mode === "successes" || mode === "both";
  return false;
}

const RESULT_LABELS: Record<string, string> = {
  failed: "Failed",
  succeeded: "Succeeded",
  partiallySucceeded: "Partially succeeded",
  canceled: "Canceled",
};

export function resultLabel(result: string): string {
  return RESULT_LABELS[result] ?? result;
}

/** A watched pipeline, as the Pipelines manager lists it. */
export interface PipelineStatus {
  id: string;
  organization: string;
  project: string;
  definition_id: number;
  name: string;
  url: string;
  mode: PipelineMode;
  last_result: string | null;
  last_run_number: string | null;
  last_run_url: string | null;
  last_finished_at: string | null;
  last_checked: string | null;
  error: string | null;
}

/** One notification: a run that finished with a result its pipeline's mode watches. */
export interface PipelineItem {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  project: string;
  run_id: number;
  run_number: string;
  result: string;
  branch: string;
  trigger: string;
  finished_at: string;
  url: string;
  is_read: boolean;
  discovered_at: string;
}

export interface PipelineGroup {
  pipeline_id: string;
  pipeline_name: string;
  project: string;
  latest: string;
  unread: boolean;
  items: PipelineItem[];
}

/** Runs grouped under their pipeline, newest run first; the pipeline with the newest run first. */
export function groupPipelineItems(items: PipelineItem[]): PipelineGroup[] {
  const groups = new Map<string, PipelineGroup>();
  for (const item of items) {
    const group = groups.get(item.pipeline_id);
    if (group) {
      group.items.push(item);
      if (item.finished_at > group.latest) group.latest = item.finished_at;
      group.unread ||= !item.is_read;
    } else {
      groups.set(item.pipeline_id, {
        pipeline_id: item.pipeline_id,
        pipeline_name: item.pipeline_name,
        project: item.project,
        latest: item.finished_at,
        unread: !item.is_read,
        items: [item],
      });
    }
  }
  const ordered = [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  for (const group of ordered) {
    group.items.sort((a, b) => b.finished_at.localeCompare(a.finished_at) || b.run_id - a.run_id);
  }
  return ordered;
}

/**
 * The one Inbox badge: pull requests needing attention (three comments on one
 * PR are one thing to look at) plus unread pipeline runs (each is its own).
 */
export function countUnreadInbox(snapshot: { items: PrInboxItem[]; pipeline_items?: PipelineItem[] }): number {
  return countUnreadPrs(snapshot.items) + (snapshot.pipeline_items ?? []).filter((item) => !item.is_read).length;
}

export interface PipelineLink {
  organization: string;
  project: string;
  target: { kind: "run" | "definition"; id: number };
}

/**
 * What a pasted link points at, or `null` when it isn't an ADO pipeline or
 * run link. The native side parses again and is authoritative; this serves
 * the in-memory backend.
 */
export function parsePipelineLink(text: string): PipelineLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username) return null;
  const path = url.pathname.replace(/^\/+|\/+$/g, "").split("/").map((s) => {
    try { return decodeURIComponent(s); } catch { return ""; }
  });
  const host = url.hostname.toLowerCase();
  let organization: string;
  let rest: string[];
  if (host === "dev.azure.com" && path.length >= 3) {
    organization = path[0];
    rest = path.slice(1);
  } else if (host.endsWith(".visualstudio.com") && !host.slice(0, -".visualstudio.com".length).includes(".") && path.length >= 2) {
    organization = host.slice(0, -".visualstudio.com".length);
    rest = path;
  } else return null;
  const project = rest[0];
  const valid = (s: string) => s.length > 0 && s !== "." && s !== ".." && !/[/\\]/.test(s);
  if (rest[1] !== "_build" || !valid(organization) || !valid(project)) return null;
  const param = (key: string) => {
    for (const [k, v] of url.searchParams) if (k.toLowerCase() === key.toLowerCase()) return v;
    return null;
  };
  const run = param("buildId");
  const definition = run === null ? param("definitionId") : null;
  const raw = run ?? definition;
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return { organization, project, target: { kind: run !== null ? "run" : "definition", id: Number(raw) } };
}
