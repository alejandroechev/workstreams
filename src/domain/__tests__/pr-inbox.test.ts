import { describe, it, expect } from "vitest";
import {
  supportsPrInbox,
  groupPrInboxItems,
  countUnreadPrs,
  isPrWatchMode,
  PR_WATCH_MODES,
  describeMute,
  type PrInboxItem,
} from "../pr-inbox";

describe("ADO inbox eligibility", () => {
  it("accepts supported clone URLs, not lookalike hosts or malformed paths", () => {
    for (const remote of [
      "https://user@dev.azure.com/org/proj/_git/repo",
      "https://org.visualstudio.com/proj/_git/repo",
      "git@ssh.dev.azure.com:v3/org/proj/repo",
      "ssh://git@ssh.dev.azure.com/v3/org/proj/repo",
    ]) expect(supportsPrInbox(remote)).toBe(true);
    for (const remote of [null, "", "bad", "https://github.com/org/repo",
      "https://dev.azure.com.evil/org/proj/_git/repo", "http://dev.azure.com/org/proj/_git/repo",
      "https://dev.azure.com/org/proj/_git/repo/extra",
      "https://dev.azure.com/org/proj/_git/%2F", "https://dev.azure.com/org/proj/_git/%FF",
      "https://dev.azure.com/org/proj/_git/repo?x=1",
      "https://org.evil.visualstudio.com/proj/_git/repo",
    ]) expect(supportsPrInbox(remote)).toBe(false);
  });
});

describe("grouping inbox events by pull request", () => {
  const base = {
    project_id: "p",
    repo_name: "Repo",
    author: "Author",
    url: "https://dev.azure.com/o/p/_git/r/pullrequest/1",
    title: "Title",
  };
  const item = (over: Partial<PrInboxItem>): PrInboxItem => ({
    ...base,
    id: "x",
    pr_id: 1,
    kind: "comment",
    summary: "Something happened",
    is_read: false,
    discovered_at: "2026-01-01T00:00:00Z",
    subject: "S",
    outcome: "",
    ...over,
  });

  it("keeps events of the same PR together and orders PRs by their newest event", () => {
    const groups = groupPrInboxItems([
      item({ id: "a", pr_id: 1, discovered_at: "2026-01-01T00:00:00Z" }),
      item({ id: "b", pr_id: 2, discovered_at: "2026-01-05T00:00:00Z" }),
      item({ id: "c", pr_id: 1, discovered_at: "2026-01-09T00:00:00Z", title: "Renamed" }),
    ]);
    expect(groups.map((g) => g.pr_id)).toEqual([1, 2]);
    expect(groups[0].events.map((e) => e.id)).toEqual(["c", "a"]);
    // The freshest event carries the current title; PRs get renamed mid-review.
    expect(groups[0].title).toBe("Renamed");
  });

  it("separates the same PR number in different repos", () => {
    const groups = groupPrInboxItems([
      item({ id: "a", project_id: "p", pr_id: 1 }),
      item({ id: "b", project_id: "q", pr_id: 1 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("treats a PR as unread while any of its events is", () => {
    const groups = groupPrInboxItems([
      item({ id: "a", is_read: true }),
      item({ id: "b", is_read: false }),
    ]);
    expect(groups[0].unread).toBe(true);
    expect(groupPrInboxItems([item({ id: "a", is_read: true })])[0].unread).toBe(false);
  });

  it("recognises every watch mode and nothing else", () => {
    for (const mode of PR_WATCH_MODES) expect(isPrWatchMode(mode)).toBe(true);
    expect(isPrWatchMode("sometimes")).toBe(false);
    expect(PR_WATCH_MODES).toContain("off");
  });
});

describe("counting pull requests that need attention", () => {
  const item = (id: string, project_id: string, pr_id: number, is_read: boolean): PrInboxItem => ({
    id, project_id, pr_id, is_read, repo_name: "Repo", kind: "comment", title: "T", summary: "S",
    author: "A", url: "https://dev.azure.com/o/p/_git/r/pullrequest/1", discovered_at: "2026-01-01T00:00:00Z",
    subject: "A", outcome: "",
  });

  it("counts a PR once however many unread events it has, and ignores fully read PRs", () => {
    expect(countUnreadPrs([
      item("a", "p", 1, false),
      item("b", "p", 1, false),
      item("c", "p", 1, true),
      item("d", "p", 2, true),
      item("e", "p", 3, false),
    ])).toBe(2);
  });

  it("treats the same PR number in two repos as two PRs", () => {
    expect(countUnreadPrs([item("a", "p", 1, false), item("b", "q", 1, false)])).toBe(2);
    expect(countUnreadPrs([])).toBe(0);
  });
});

describe("describing a mute rule", () => {
  it("says in words which events stop being tracked", () => {
    expect(describeMute({ kind: "policy", subject: "Comment requirements", outcome: "approved" })).toBe('Build gate "Comment requirements" passed');
    expect(describeMute({ kind: "policy", subject: "CI", outcome: "rejected" })).toBe('Build gate "CI" failed');
    expect(describeMute({ kind: "policy", subject: "CI", outcome: "broken" })).toBe('Build gate "CI" errored');
    expect(describeMute({ kind: "vote", subject: "Dev", outcome: "10" })).toBe("Dev approved");
    expect(describeMute({ kind: "vote", subject: "Dev", outcome: "5" })).toBe("Dev approved with suggestions");
    expect(describeMute({ kind: "vote", subject: "Dev", outcome: "-5" })).toBe("Dev is waiting for the author");
    expect(describeMute({ kind: "vote", subject: "Dev", outcome: "-10" })).toBe("Dev rejected the changes");
    expect(describeMute({ kind: "comment", subject: "Pat", outcome: "" })).toBe("Comments by Pat");
    expect(describeMute({ kind: "assigned", subject: "Bot", outcome: "" })).toBe("Review requests on PRs by Bot");
    expect(describeMute({ kind: "closed", subject: "Bot", outcome: "completed" })).toBe("PRs by Bot completed");
    expect(describeMute({ kind: "closed", subject: "Bot", outcome: "abandoned" })).toBe("PRs by Bot abandoned");
  });

  it("falls back to the raw rule for anything unexpected", () => {
    expect(describeMute({ kind: "policy", subject: "CI", outcome: "weird" })).toBe('Build gate "CI" weird');
    expect(describeMute({ kind: "vote", subject: "Dev", outcome: "3" })).toBe("Dev voted 3");
  });
});
