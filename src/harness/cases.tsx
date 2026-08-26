// @test-skip: dev/E2E-only harness scaffolding; real-Monaco interactivity is covered by scripts/harness.mjs + e2e/tests/comment-interactivity.spec.ts, not jsdom.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FC } from "react";

import { FileEditorView } from "../files/FileEditorView";
import CodeReviewTile from "../tiles/CodeReviewTile";
import RepoExplorerTile from "../tiles/RepoExplorerTile";
import TerminalTile from "../tiles/TerminalTile";
import { BackendProvider } from "../backend/context";
import { MemoryBackend } from "../backend/memory-backend";
import type { SessionFileComment } from "../domain/file-comments";
import { hideResolvedComments } from "../files/comments-layer";
import { makeInMemoryRegistry } from "./fakeRegistry";
import type { BufferSnapshot } from "../files/FileBufferRegistry";
import { CommentsPanel } from "../files/CommentsPanel";

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
  const [comments, setComments] = useState<SessionFileComment[]>(() => [
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
        onSetCommentStatus={(id, status) => {
          setComments((cs) => cs.map((c) => (c.id === id ? { ...c, status } : c)));
          return Promise.resolve();
        }}
      />
    </div>
  );
};

/**
 * Case: the **Comments tab** navigation pane beside a real Monaco editor.
 *
 * Proves the cross-file flow that jsdom cannot: clicking a thread in the panel
 * reveals its anchor line in real Monaco and marks the right thread focused.
 */
const CommentsNavigationCase: FC = () => {
  // Two files with comments, mirroring the real tab: selecting a comment in a
  // different file remounts the editor (key=path), which is where the render
  // loop showed up.
  const pathA = "C:/repo/src/example.ts";
  const pathB = "C:/repo/src/other.ts";
  const contentA = Array.from({ length: 60 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");
  const contentB = "export const other = true;\nexport const second = 2;\n";
  const registry = useMemo(
    () => makeInMemoryRegistry(pathA, contentA, { [pathB]: contentB }),
    [],
  );
  const base = {
    workstream_id: "ws-1",
    anchor_text: null as string | null,
    status: "open",
    parent_id: null,
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
  } as const;
  const seeded: SessionFileComment[] = [
    { ...base, id: "near-top", file: "src/example.ts", anchor_line_start: 3, anchor_line_end: 3, body: "NEAR_TOP note", author: "Eduardo Fernandez" },
    { ...base, id: "far-down", file: "src/example.ts", anchor_line_start: 48, anchor_line_end: 48, body: "FAR_DOWN note", author: "reviewer" },
    // Snapshot deliberately does NOT match line 5 -> must badge as drifted.
    { ...base, id: "drifted", file: "src/example.ts", anchor_line_start: 5, anchor_line_end: 5, anchor_text: "THIS_LINE_IS_GONE();", body: "DRIFTED note", author: "reviewer" },
    { ...base, id: "other-file", file: "src/other.ts", anchor_line_start: 2, anchor_line_end: 2, body: "OTHER_FILE note", author: "agent" },
    // A reply, so deleting its root has to cascade.
    { ...base, id: "far-down-reply", file: "src/example.ts", anchor_line_start: 48, anchor_line_end: 48, body: "REPLY note", author: "agent", parent_id: "far-down" },
  ];
  const [comments, setComments] = useState<SessionFileComment[]>(seeded);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [revealLine, setRevealLine] = useState<number | undefined>(undefined);
  const [fileLines, setFileLines] = useState<string[] | null>(null);

  // Stable identity, exactly like the tile: FileEditorView's acquire effect
  // depends on this callback, so an inline arrow re-runs it forever.
  const handleSnapshot = useCallback((snap: BufferSnapshot | null) => {
    const text = snap ? registry.getModel(snap.path)?.getValue() : undefined;
    setFileLines(text === undefined ? null : text.split(/\r?\n/));
  }, [registry]);

  const openRepoRelative = openPath === pathB ? "src/other.ts" : "src/example.ts";

  return (
    <div data-testid="harness-case" data-case="comments-navigation" style={{ ...full, display: "flex" }}>
      <CommentsPanel
        comments={comments}
        selectedId={selectedId}
        fileLines={fileLines ? { [openRepoRelative]: fileLines } : undefined}
        onSelect={(c) => {
          setSelectedId(c.id);
          setOpenPath(c.file === "src/other.ts" ? pathB : pathA);
          setRevealLine(c.anchor_line_start);
        }}
        onDelete={(root) => {
          setComments((cs) => cs.filter((c) => c.id !== root.id && c.parent_id !== root.id));
          if (selectedId === root.id) {
            setSelectedId(null);
            setOpenPath(null);
          }
        }}
        onDeleteAll={(roots) => {
          const ids = new Set(roots.map((r) => r.id));
          setComments((cs) => cs.filter((c) => !ids.has(c.id) && !ids.has(c.parent_id ?? "")));
          if (selectedId && ids.has(selectedId)) {
            setSelectedId(null);
            setOpenPath(null);
          }
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }} data-testid="comments-editor-pane">
        {openPath === null ? (
          <div data-testid="comments-no-selection">Pick a comment</div>
        ) : (
          <FileEditorView
            key={openPath}
            path={openPath}
            registry={registry}
            showHeader={false}
            commentsEnabled
            comments={comments.filter((c) => (openPath === pathB ? c.file === "src/other.ts" : c.file === "src/example.ts"))}
            focusedCommentId={selectedId}
            initialRevealLine={revealLine}
            onSnapshotChange={handleSnapshot}
            onBack={() => {}}
            onAddComment={() => Promise.resolve()}
            onUpdateComment={() => Promise.resolve()}
            onReplyComment={() => Promise.resolve()}
            onDeleteComment={() => Promise.resolve()}
            onSetCommentStatus={() => Promise.resolve()}
          />
        )}
      </div>
    </div>
  );
};


/**
 * Case: resolve through a REAL async round-trip.
 *
 * The existing `comment-zone` case updates state synchronously inside the
 * callback, which is not what the app does: `RepoExplorerTile` passes an inline
 * arrow that awaits `useFileComments.setStatus` (a backend call) and only then
 * sets state. Anything that goes wrong across that await — a stale closure, a
 * view zone torn down and rebuilt while the promise is in flight, a swallowed
 * rejection — is invisible to the synchronous case.
 *
 * This case reproduces the real shape: an unstable inline callback, an awaited
 * backend hop, and a parent that keeps re-rendering underneath it.
 */
const AsyncResolveCase: FC = () => {
  const path = "C:/repo/src/example.ts";
  const registry = useMemo(
    () => makeInMemoryRegistry(path, "const a = 1;\nconst b = 2;\nconst c = 3;\n"),
    [],
  );

  const [comments, setComments] = useState<SessionFileComment[]>([
    {
      id: "c1",
      workstream_id: "ws-1",
      file: "src/example.ts",
      anchor_line_start: 2,
      anchor_line_end: 2,
      anchor_text: "const b = 2;",
      body: "Rename this.",
      author: "reviewer",
      parent_id: null,
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
  ]);

  // A parent that re-renders on a timer, like the real tile does while its
  // sibling hooks settle. Rebuilding view zones underneath an in-flight click
  // is exactly the hazard being probed.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  return (
    <div data-testid="harness-case" data-case="async-resolve" style={full}>
      <span data-testid="async-resolve-tick" style={{ display: "none" }}>
        {tick}
      </span>
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
        onSetCommentStatus={async (id, status) => {
          // The awaited hop the synchronous case skips.
          await new Promise((r) => setTimeout(r, 40));
          setComments((cs) => cs.map((c) => (c.id === id ? { ...c, status } : c)));
        }}
      />
    </div>
  );
};


/**
 * Case: hide-resolved filter over real Monaco view zones.
 *
 * The filter is a pure function, but what matters is that a hidden thread's
 * view zone is actually torn down -- a stale zone would leave the resolved
 * comment on screen (or worse, an empty gap) even though the data says it is
 * gone. jsdom cannot see either outcome.
 */
const HideResolvedCase: FC = () => {
  const path = "C:/repo/src/example.ts";
  const registry = useMemo(
    () => makeInMemoryRegistry(path, "const a = 1;\nconst b = 2;\nconst c = 3;\n"),
    [],
  );
  const [hide, setHide] = useState(false);

  const all = useMemo<SessionFileComment[]>(
    () => [
      {
        id: "open1",
        workstream_id: "ws-1",
        file: "src/example.ts",
        anchor_line_start: 1,
        anchor_line_end: 1,
        anchor_text: "const a = 1;",
        body: "Still open.",
        author: "reviewer",
        parent_id: null,
        status: "open",
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      {
        id: "done1",
        workstream_id: "ws-1",
        file: "src/example.ts",
        anchor_line_start: 2,
        anchor_line_end: 2,
        anchor_text: "const b = 2;",
        body: "Already handled.",
        author: "reviewer",
        parent_id: null,
        status: "resolved",
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      {
        id: "done1reply",
        workstream_id: "ws-1",
        file: "src/example.ts",
        anchor_line_start: 2,
        anchor_line_end: 2,
        anchor_text: "const b = 2;",
        body: "Reply under the resolved root.",
        author: "agent",
        parent_id: "done1",
        status: "open",
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ],
    [],
  );

  const comments = useMemo(() => hideResolvedComments(all, hide), [all, hide]);

  return (
    <div data-testid="harness-case" data-case="hide-resolved" style={full}>
      <button data-testid="hide-resolved-toggle" onClick={() => setHide((v) => !v)}>
        {hide ? "show resolved" : "hide resolved"}
      </button>
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
  "hide-resolved": {
    title: "Repo Explorer: hide resolved comments",
    Component: HideResolvedCase,
  },
  "async-resolve": {
    title: "File-comment resolve through an async backend round-trip",
    Component: AsyncResolveCase,
  },
  "comments-navigation": {
    title: "Comments tab: cross-file navigation to a thread",
    Component: CommentsNavigationCase,
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
