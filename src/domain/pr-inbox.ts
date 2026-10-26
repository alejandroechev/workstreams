import type { PipelineItem, PipelineStatus } from "./pipeline-inbox";
/** Which pull requests a repo is watched for. Mirrors the native `WatchMode`. */
export type PrWatchMode = "off" | "reviewer" | "author" | "both";

export const PR_WATCH_MODES: PrWatchMode[] = ["off", "reviewer", "author", "both"];

export function isPrWatchMode(value: string): value is PrWatchMode {
  return (PR_WATCH_MODES as string[]).includes(value);
}

/**
 * What a PR did, not merely that it exists. A single pull request now produces
 * a stream of these, so the kind is what tells "someone approved" apart from
 * "the build broke".
 */
export type PrEventKind = "assigned" | "comment" | "vote" | "policy" | "closed";

export interface PrInboxItem {
  id: string;
  project_id: string;
  repo_name: string;
  pr_id: number;
  kind: PrEventKind;
  title: string;
  author: string;
  summary: string;
  url: string;
  is_read: boolean;
  discovered_at: string;
  /** What a mute matches on: gate name, reviewer, comment author, or PR author. */
  subject: string;
  /** Gate status, vote value or closure state; "" when the kind has none. */
  outcome: string;
}

/**
 * "Stop tracking events like this", across every repo (ADR 036). Events are
 * matched by kind, subject and outcome, so muting "CI passed" keeps "CI failed".
 */
export interface PrInboxMute {
  kind: PrEventKind;
  subject: string;
  outcome: string;
  created_at?: string;
}

const GATE_OUTCOMES: Record<string, string> = { approved: "passed", rejected: "failed", broken: "errored" };
const VOTE_OUTCOMES: Record<string, string> = {
  "10": "approved",
  "5": "approved with suggestions",
  "-5": "is waiting for the author",
  "-10": "rejected the changes",
};

/** A mute rule in the words the inbox uses for the events it silences. */
export function describeMute(rule: Pick<PrInboxMute, "kind" | "subject" | "outcome">): string {
  switch (rule.kind) {
    case "policy":
      return `Build gate "${rule.subject}" ${GATE_OUTCOMES[rule.outcome] ?? rule.outcome}`;
    case "vote":
      return `${rule.subject} ${VOTE_OUTCOMES[rule.outcome] ?? `voted ${rule.outcome}`}`;
    case "comment":
      return `Comments by ${rule.subject}`;
    case "assigned":
      return `Review requests on PRs by ${rule.subject}`;
    case "closed":
      return `PRs by ${rule.subject} ${rule.outcome}`;
  }
}

export interface PrInboxRepo {
  project_id: string;
  repo_name: string;
  enabled: boolean;
  mode: PrWatchMode;
  last_checked: string | null;
  error: string | null;
}

export const PR_WATCH_MODE_LABELS: Record<PrWatchMode, string> = {
  off: "No notifications",
  reviewer: "PRs I review",
  author: "PRs I authored",
  both: "Both",
};

export const PR_EVENT_LABELS: Record<PrEventKind, string> = {
  assigned: "Review requested",
  comment: "Comment",
  vote: "Vote",
  policy: "Build gate",
  closed: "Closed",
};

/**
 * Notifications arrive per event but are read per pull request, so the inbox
 * groups them. A PR sorts by its newest event, and a group counts as unread
 * while any event in it is.
 */
export function groupPrInboxItems(items: PrInboxItem[]): PrInboxGroup[] {
  const groups = new Map<string, PrInboxGroup>();
  for (const item of items) {
    const key = `${item.project_id}#${item.pr_id}`;
    const group = groups.get(key);
    if (group) {
      group.events.push(item);
      if (item.discovered_at > group.latest) {
        group.latest = item.discovered_at;
        group.title = item.title;
      }
      group.unread ||= !item.is_read;
    } else {
      groups.set(key, {
        key,
        project_id: item.project_id,
        repo_name: item.repo_name,
        pr_id: item.pr_id,
        title: item.title,
        author: item.author,
        url: item.url,
        latest: item.discovered_at,
        unread: !item.is_read,
        events: [item],
      });
    }
  }
  const ordered = [...groups.values()].sort(
    (a, b) => b.latest.localeCompare(a.latest) || b.pr_id - a.pr_id,
  );
  for (const group of ordered) {
    group.events.sort(
      (a, b) => b.discovered_at.localeCompare(a.discovered_at) || b.id.localeCompare(a.id),
    );
  }
  return ordered;
}

export interface PrInboxGroup {
  key: string;
  project_id: string;
  repo_name: string;
  pr_id: number;
  title: string;
  author: string;
  url: string;
  latest: string;
  unread: boolean;
  events: PrInboxItem[];
}

export interface PrInboxSnapshot {
  items: PrInboxItem[];
  repos: PrInboxRepo[];
  mutes: PrInboxMute[];
  /** Watched pipelines and their run notifications (ADR 038). */
  pipelines?: PipelineStatus[];
  pipeline_items?: PipelineItem[];
}

/** UI eligibility only; native code independently validates every HTTP destination. */
export function supportsPrInbox(remote: string | null): boolean {
  if (!remote) return false;
  try {
    const ssh = remote.trim().match(/^(?:git@ssh\.dev\.azure\.com:v3\/|ssh:\/\/git@ssh\.dev\.azure\.com\/v3\/)(.*)$/);
    let parts: string[];
    if (ssh) {
      parts = ssh[1].split("/");
    } else {
      const url = new URL(remote.trim());
      if (url.protocol !== "https:" || url.port || url.search || url.hash) return false;
      const path = url.pathname.replace(/\/$/, "").slice(1).split("/");
      if (url.hostname === "dev.azure.com" && path.length === 4 && path[2] === "_git") {
        parts = [path[0], path[1], path[3]];
      } else if (/^[^.]+\.visualstudio\.com$/.test(url.hostname) && path.length === 3 && path[1] === "_git") {
        parts = [url.hostname.split(".")[0], path[0], path[2]];
      } else return false;
    }
    return parts.length === 3 && parts.every((part) => {
      const decoded = decodeURIComponent(part);
      return decoded.length > 0 && decoded !== "." && decoded !== ".."
        && !decoded.includes("/") && !decoded.includes("\\")
        && !Array.from(decoded).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return false;
    throw error;
  }
}

/**
 * The sidebar badge counts pull requests needing attention, not events: three
 * comments on one PR are one thing to go look at.
 */
export function countUnreadPrs(items: PrInboxItem[]): number {
  return new Set(
    items.filter((item) => !item.is_read).map((item) => `${item.project_id}\u0000${item.pr_id}`),
  ).size;
}
