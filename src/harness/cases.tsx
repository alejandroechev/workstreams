// @test-skip: dev/E2E-only harness scaffolding; real-Monaco interactivity is covered by scripts/harness.mjs + e2e/tests/comment-interactivity.spec.ts, not jsdom.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FC } from "react";

import { FileEditorView } from "../files/FileEditorView";
import CodeReviewTile from "../tiles/CodeReviewTile";
import RepoExplorerTile from "../tiles/RepoExplorerTile";
import TerminalTile from "../tiles/TerminalTile";
import { BackendProvider } from "../backend/context";
import { MemoryBackend } from "../backend/memory-backend";
import type { SessionFileComment } from "../domain/file-comments";
import { makeInMemoryRegistry } from "./fakeRegistry";

/**
 * Harness cases (dev/E2E only). Each case mounts ONE component under test with
 * seeded data, full-viewport, so a Playwright probe can reach the buggy UI in a
 * single `page.goto('…?harness=<id>')` — no workstream/tile navigation.
 *
 * These cases render *real* Monaco (via the real loader), which is exactly what
 * the jsdom unit tests cannot do. They exist to reproduce/verify real
 * layout/z-index/pointer-events bugs (e.g. clicking buttons inside comment view
 * zones).
 */

const full: CSSProperties = { position: "fixed", inset: 0, background: "#1e1e2e" };

function nowIso() {
  return new Date().toISOString();
}

/**
 * Case: Repo Explorer file-comment zone. A `FileEditorView` with one seeded
 * user comment on line 2, so its inline view zone renders the Edit/Delete
 * buttons. Clicking **Edit** must open the inline composer (the state change
 * the probe asserts).
 */
const CommentZoneCase: FC = () => {
  const path = "C:/repo/src/example.ts";
  const content = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
  const registry = useMemo(() => makeInMemoryRegistry(path, content), []);
  const [comments, setComments] = useState<SessionFileComment[]>(() => [
    {
      id: "c1",
      workstream_id: "ws-1",
      file: "src/example.ts",
      anchor_line_start: 2,
      anchor_line_end: 2,
      anchor_text: "const b = 2;",
      body: "Prefer a clearer name than `b`.",
      author: "reviewer",
      parent_id: null,
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    {
      id: "a1",
      workstream_id: "ws-1",
      file: "src/example.ts",
      anchor_line_start: 2,
      anchor_line_end: 2,
      anchor_text: "const b = 2;",
      body: "Renamed `b` to `count`.",
      author: "agent",
      parent_id: "c1",
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    {
      id: "a2",
      workstream_id: "ws-1",
      file: "src/example.ts",
      anchor_line_start: 2,
      anchor_line_end: 2,
      anchor_text: "const b = 2;",
      body: "Thanks — looks good now.",
      author: "reviewer",
      parent_id: "c1",
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
  ]);

  return (
    <div data-testid="harness-case" data-case="comment-zone" style={full}>
      <FileEditorView
        path={path}
        registry={registry}
        showHeader={false}
        commentsEnabled
        comments={comments}
        onBack={() => {}}
        onAddComment={() => Promise.resolve()}
        onUpdateComment={(id, body) => {
          setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c)));
          return Promise.resolve();
        }}
        onReplyComment={(parentId, body) => {
          const parent = comments.find((c) => c.id === parentId);
          setComments((cs) => [
            ...cs,
            {
              id: `r-${cs.length + 1}`,
              workstream_id: "ws-1",
              file: "src/example.ts",
              anchor_line_start: parent?.anchor_line_start ?? 1,
              anchor_line_end: parent?.anchor_line_end ?? 1,
              anchor_text: parent?.anchor_text ?? null,
              body,
              author: "reviewer",
              parent_id: parentId,
              status: "open",
              created_at: nowIso(),
              updated_at: nowIso(),
            },
          ]);
          return Promise.resolve();
        }}
        onDeleteComment={(id) => {
          setComments((cs) => cs.filter((c) => c.id !== id && c.parent_id !== id));
          return Promise.resolve();
        }}
        onSetCommentStatus={(id, status) => {
          setComments((cs) => cs.map((c) => (c.id === id ? { ...c, status } : c)));
          return Promise.resolve();
        }}
      />
    </div>
  );
};

/**
 * Case: Code Review thread zone. A `CodeReviewTile` with an active working-tree
 * review + one reviewer comment on line 2, so its inline thread view zone
 * renders the **Resolve** button. Clicking Resolve must flip the thread status
 * to "Resolved" (the state change the probe asserts).
 */
const ReviewThreadCase: FC = () => {
  const backend = useMemo(() => {
    const b = new MemoryBackend();
    b.seedBoundSession("ws-1", "sess-1");
    b.seedReviewDiff([{ path: "src/example.ts", status: "M" }]);
    b.seedReviewDiffSides("src/example.ts", {
      before: "const a = 1;\nconst old = 2;\nconst c = 3;\n",
      after: "const a = 1;\nconst renamed = 2;\nconst c = 3;\n",
    });
    return b;
  }, []);
  const [ready, setReady] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    void (async () => {
      const r = await backend.createReview("ws-1", "working_tree", null, null);
      await backend.addReviewComment(
        "ws-1",
        r.id,
        "src/example.ts",
        2,
        "new",
        "const renamed = 2;",
        null,
        "Please pick a clearer name.",
      );
      setReady(true);
    })();
  }, [backend]);

  if (!ready) return <div data-testid="harness-loading">seeding…</div>;
  return (
    <div data-testid="harness-case" data-case="review-thread" style={full}>
      <BackendProvider backend={backend}>
        <CodeReviewTile tileId="t1" isFocused workstreamId="ws-1" workstreamDir="C:/repo" />
      </BackendProvider>
    </div>
  );
};

/**
 * Case: Repo Explorer Unstaged diff with the shared file-comment layer mounted
 * on the DiffEditor's modified side.
 */
const DiffCommentZoneCase: FC = () => {
  const backend = useMemo(() => {
    const instance = new MemoryBackend();
    instance.seedBoundSession("ws-1", "sess-1");
    instance.gitListBranches = async () => ["main", "release/1.0"];
    instance.gitDiffFilesWithStatus = async () => [
      { path: "src/example.ts", status: "M" as const },
    ];
    instance.gitDiffFileSides = async () => ({
      before: "const oldName = 1;\nconst stable = 2;\n",
      after: "const clearName = 1;\nconst stable = 2;\n",
    });
    return instance;
  }, []);
  const [ready, setReady] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    void backend
      .addSessionFileComment(
        "ws-1",
        "src/example.ts",
        1,
        1,
        "const clearName = 1;",
        "This comment came from the working file.",
      )
      .then(() => setReady(true));
  }, [backend]);

  if (!ready) return <div data-testid="harness-loading">seeding…</div>;
  return (
    <div data-testid="harness-case" data-case="diff-comment-zone" style={full}>
      <BackendProvider backend={backend}>
        <RepoExplorerTile
          tileId="t1"
          isFocused
          rootDir="C:/repo"
          workstreamId="ws-1"
        />
      </BackendProvider>
    </div>
  );
};

const TerminalRevealCase: FC = () => {
  const [visible, setVisible] = useState(true);
  const [focusToken, setFocusToken] = useState(0);
  const switchVisibility = (next: boolean) => {
    setVisible(next);
    setFocusToken((token) => token + 1);
  };

  return (
    <div data-testid="harness-case" data-case="terminal-reveal" style={full}>
      <div style={{ position: "absolute", zIndex: 10, top: 8, right: 8, display: "flex", gap: 6 }}>
        <button data-testid="terminal-hide" onClick={() => switchVisibility(false)}>Hide</button>
        <button data-testid="terminal-show" onClick={() => switchVisibility(true)}>Show</button>
      </div>
      <div
        data-testid="terminal-workstream"
        style={{ position: "absolute", inset: 0, display: visible ? "block" : "none" }}
      >
        <TerminalTile
          tileId="terminal-reveal"
          isFocused
          focusToken={focusToken}
          visible={visible}
        />
      </div>
    </div>
  );
};

const RepoContextMenuCase: FC = () => {
  const backend = useMemo(() => {
    const instance = new MemoryBackend();
    instance.seedFile("C:/repo/existing.txt", "hello");
    return instance;
  }, []);
  return (
    <div data-testid="harness-case" data-case="repo-context-menu" style={full}>
      <BackendProvider backend={backend}>
        <RepoExplorerTile tileId="context-menu" isFocused rootDir="C:/repo" workstreamId="ws-1" />
      </BackendProvider>
    </div>
  );
};

/**
 * Case: an **imported** review thread (e.g. from the `ado-file-comments` skill).
 *
 * Two regressions live here that only real Monaco rendering can confirm:
 *  1. the root is authored by an external person, so the zone must show that
 *     name — not "you", which attributed every imported comment to this user;
 *  2. the agent reply carries an ISO-8601 timestamp while the reviewer's later
 *     reply carries a legacy epoch-second one, so lexicographic ordering put
 *     the reviewer's reply above the agent reply it was answering.
 */
const ImportedCommentZoneCase: FC = () => {
  const path = "C:/repo/src/example.ts";
  const content = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
  const registry = useMemo(() => makeInMemoryRegistry(path, content), []);
  const anchor = {
    workstream_id: "ws-1",
    file: "src/example.ts",
    anchor_line_start: 2,
    anchor_line_end: 2,
    anchor_text: "const b = 2;",
    status: "open",
  } as const;
  const [comments] = useState<SessionFileComment[]>(() => [
    {
      ...anchor,
      id: "ado-1513151-16261206-1",
      body: "Use Duration here.",
      author: "Eduardo Fernandez",
      parent_id: null,
      created_at: "2026-08-16T23:51:26Z",
      updated_at: "2026-08-16T23:51:26Z",
    },
    {
      ...anchor,
      id: "agent-reply",
      body: "AGENT_ANSWER: switched to Duration.",
      author: "agent",
      parent_id: "ado-1513151-16261206-1",
      created_at: "2026-08-17T10:00:00Z",
      updated_at: "2026-08-17T10:00:00Z",
    },
    {
      // Written in the tile AFTER the agent replied, in the legacy format.
      ...anchor,
      id: "my-reply",
      body: "MY_FOLLOW_UP: thanks, confirmed.",
      author: "reviewer",
      parent_id: "ado-1513151-16261206-1",
      created_at: String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000)),
      updated_at: String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000)),
    },
  ]);

  return (
    <div data-testid="harness-case" data-case="imported-comment-zone" style={full}>
      <FileEditorView
        path={path}
        registry={registry}
        showHeader={false}
        commentsEnabled
        comments={comments}
        onBack={() => {}}
        onAddComment={() => Promise.resolve()}
        onUpdateComment={() => Promise.resolve()}
        onReplyComment={() => Promise.resolve()}
        onDeleteComment={() => Promise.resolve()}
        onSetCommentStatus={() => Promise.resolve()}
      />
    </div>
  );
};

export interface HarnessCase {
  title: string;
  Component: FC;
}

export const harnessCases: Record<string, HarnessCase> = {
  "comment-zone": {
    title: "Repo Explorer file-comment zone (Edit/Delete buttons)",
    Component: CommentZoneCase,
  },
  "review-thread": {
    title: "Code Review thread zone (Resolve/Reopen buttons)",
    Component: ReviewThreadCase,
  },
  "imported-comment-zone": {
    title: "Imported (ADO) file-comment zone: author name + reply order",
    Component: ImportedCommentZoneCase,
  },
  "diff-comment-zone": {
    title: "Repo Explorer Unstaged diff file-comment zone",
    Component: DiffCommentZoneCase,
  },
  "terminal-reveal": {
    title: "Persisted terminal workstream reveal",
    Component: TerminalRevealCase,
  },
  "repo-context-menu": {
    title: "Repo Explorer context menu",
    Component: RepoContextMenuCase,
  },
};
