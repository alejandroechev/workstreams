/**
 * Repo Explorer open-file tabs. Covers AT-1..AT-7 of
 * files/features/explorer-open-files/acceptance.md against the dev server
 * with the in-memory backend; file reads are stubbed per path.
 */
import { test, expect, type Page } from "@playwright/test";

const ROOT = "/demo/open";
let pageErrors: string[] = [];
test.beforeEach(() => { pageErrors = []; });
test.afterEach(() => { expect(pageErrors).toEqual([]); });
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const NAMES = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "x.ts", "y.ts", "z.ts", "x.md", "notes.md", "pic.png", "doc.pdf", "data.db"];

function body(name: string): string {
  if (name === "x.md") return "# X\n\nGo to [z](z.ts).\n";
  if (name.endsWith(".md")) return "# Notes\n\nSome text.\n";
  return Array.from({ length: 300 }, (_, i) => `// ${name} line ${i + 1}`).join("\n");
}

async function start(page: Page, opts: { explorers?: number; terminal?: boolean; config?: Record<string, unknown> } = {}) {
  const tiles: Array<{ type: string; title: string; config: Record<string, unknown> }> = Array.from({ length: opts.explorers ?? 1 }, (_, i) => ({
    type: "file_explorer",
    title: `Explorer ${i + 1}`,
    config: i === 0 && opts.config ? opts.config : {},
  }));
  if (opts.terminal) tiles.push({ type: "terminal", title: "Shell", config: {} });
  await page.addInitScript(({ root, names, tiles, bodies, png }) => {
    const contents: Record<string, string> = {};
    names.forEach((n: string, i: number) => { contents[n] = bodies[i]; });
    Object.assign(window, {
      __WS_INVOKE_HANDLERS__: {
        get_setting: () => null,
        set_setting: () => null,
        read_file_base64: () => png,
        is_sqlite_file: () => false,
        list_db_tables: () => [],
        read_text_file: (a: { path: string }) => ({ content: contents[a.path.split(/[\\/]/).pop() ?? ""] ?? "", line_ending: "lf", has_trailing_newline: true }),
        write_text_file: () => null,
        canonicalize_path: ({ path }: { path: string }) => path,
        watch_file_changes: () => null,
        unwatch_file_changes: () => null,
        watch_directory: () => null,
        unwatch_directory: () => null,
        list_git_hooks: () => [],
        git_current_branch: () => "main",
        cancel_searches: () => null,
        search_files: () => [],
      },
      __WS_DEMO_SEED__: {
        workstreams: [{ name: "Tabs", directory: root, loaded: true, tiles }],
        files: names.map((n: string, i: number) => ({ path: `${root}/${n}`, content: bodies[i] })),
      },
    });
  }, { root: ROOT, names: NAMES, tiles, bodies: NAMES.map(body), png: PNG_1PX });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto("/");
  await page.getByTestId("workstream-item").filter({ hasText: "Tabs" }).click();
  await expect(page.locator("[data-tile-id]").filter({ hasText: "Explorer 1" }).first()).toBeVisible();
}

const explorer = (page: Page, i = 0) => page.locator("[data-tile-id]").filter({ hasText: `Explorer ${i + 1}` }).first();
const tabs = (page: Page, i = 0) => explorer(page, i).getByTestId("open-file-tab");
const tab = (page: Page, name: string, i = 0) => explorer(page, i).locator(`[data-testid="open-file-tab"][data-path$="${name}"]`);
const tabNames = async (page: Page, i = 0) =>
  (await tabs(page, i).evaluateAll((els) => els.map((e) => (e.getAttribute("data-path") ?? "").split(/[\\/]/).pop())));

async function openFromTree(page: Page, name: string, i = 0) {
  const ex = explorer(page, i);
  if (!(await ex.getByTestId("file-tree-item").first().isVisible().catch(() => false))) {
    await ex.getByTestId("repo-explorer-go-to-folder").click();
  }
  await ex.getByTestId("file-tree-item").filter({ hasText: new RegExp(`^\\s*${name.replace(".", "\\.")}\\s*$`) }).click();
  await expect(tab(page, name, i)).toHaveAttribute("data-active", "true");
}

test.describe("Repo Explorer open files", () => {
  test("AT-1: preview tab is replaced, kept tab stays, reopening selects the existing tab", async ({ page }) => {
    await start(page);
    await openFromTree(page, "c.ts");
    await expect(tab(page, "c.ts")).toHaveAttribute("data-preview", "true");
    await openFromTree(page, "d.ts");
    expect(await tabNames(page)).toEqual(["d.ts"]);
    await tab(page, "d.ts").dblclick();
    await expect(tab(page, "d.ts")).toHaveAttribute("data-preview", "false");
    await openFromTree(page, "a.ts");
    expect(await tabNames(page)).toEqual(["d.ts", "a.ts"]);
    await expect(tab(page, "a.ts")).toHaveAttribute("data-preview", "true");
    await openFromTree(page, "d.ts");
    expect(await tabNames(page)).toEqual(["d.ts", "a.ts"]);
  });

  test("AT-2: every kind of file can be a tab, and tabs are per explorer", async ({ page }) => {
    await start(page, { explorers: 2 });
    const twelve = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "x.ts", "y.ts", "z.ts", "notes.md", "pic.png", "doc.pdf", "data.db"];
    for (const name of twelve) {
      await openFromTree(page, name);
      await tab(page, name).dblclick();
      await expect(tab(page, name)).toHaveAttribute("data-preview", "false");
    }
    expect(await tabNames(page)).toEqual(twelve);

    const ex = explorer(page);
    await tab(page, "notes.md").click();
    await ex.getByTestId("repo-explorer-mode-edit").click();
    await tab(page, "a.ts").click();
    await expect(ex.getByTestId("file-editor-monaco")).toBeVisible();
    await tab(page, "notes.md").click();
    await expect(ex.getByTestId("repo-explorer-mode-edit")).toHaveAttribute("aria-checked", "true");
    await ex.getByTestId("repo-explorer-mode-preview").click();
    await tab(page, "a.ts").click();
    await tab(page, "notes.md").click();
    await expect(ex.getByTestId("repo-explorer-mode-preview")).toHaveAttribute("aria-checked", "true");
    await expect(ex.getByText("Some text.")).toBeVisible();

    await tab(page, "pic.png").click();
    await expect(ex.getByTestId("image-preview")).toBeVisible();
    await tab(page, "doc.pdf").click();
    await expect(ex.getByTestId("pdf-preview")).toBeVisible();
    await tab(page, "data.db").click();
    await expect(ex.getByText("No tables found")).toBeVisible();
    expect(await tabs(page).count()).toBe(12);

    await openFromTree(page, "y.ts", 1);
    expect(await tabNames(page, 1)).toEqual(["y.ts"]);
    expect(await tabs(page).count()).toBe(12);
  });

  test("AT-3: switching back keeps undo, cursor and scroll", async ({ page }) => {
    await start(page);
    await openFromTree(page, "x.ts");
    await tab(page, "x.ts").dblclick();
    await openFromTree(page, "y.ts");
    await tab(page, "y.ts").dblclick();
    await tab(page, "x.ts").click();
    await expect(explorer(page).getByTestId("file-editor-monaco")).toBeVisible();
    await page.waitForFunction(() => document.querySelectorAll(".monaco-editor").length > 0);

    await editorEval(page, (ed) => { ed.setPosition({ lineNumber: 210, column: 1 }); ed.focus(); });
    await page.keyboard.type("hello ");
    await editorEval(page, (ed) => { ed.setScrollTop(ed.getTopForLineNumber(200)); });
    await expect.poll(async () => (await editorState(page)).firstLine).toBeGreaterThanOrEqual(199);
    const before = await editorState(page);
    expect(before.value).toContain("hello ");
    await page.waitForTimeout(800);

    await tab(page, "y.ts").click();
    await expect.poll(async () => (await editorState(page)).value).toContain("y.ts line 1");
    await tab(page, "x.ts").click();
    await expect.poll(async () => (await editorState(page)).value).toContain("x.ts line 1");
    await expect.poll(async () => (await editorState(page)).firstLine).toBeGreaterThanOrEqual(199);
    const after = await editorState(page);
    expect(Math.abs(after.firstLine - before.firstLine)).toBeLessThanOrEqual(1);
    expect(after.cursorLine).toBe(210);
    expect(after.value).toContain("hello ");
    await editorEval(page, (ed) => { ed.trigger("test", "undo", null); });
    expect((await editorState(page)).value).not.toContain("hello ");
  });

  test("AT-4: open files and the place come back after a restart", async ({ page }) => {
    await start(page);
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await openFromTree(page, name);
      await tab(page, name).dblclick();
    }
    await openFromTree(page, "d.ts");
    await tab(page, "b.ts").click();
    await expect.poll(async () => (await editorState(page)).value).toContain("b.ts line 1");
    await editorEval(page, (ed) => { ed.setPosition({ lineNumber: 125, column: 1 }); ed.setScrollTop(ed.getTopForLineNumber(120)); });
    await page.waitForTimeout(1500);

    const config = await page.evaluate(async () => {
      const b = (window as unknown as { __WS_BACKEND__: { listWorkstreams(): Promise<Array<{ id: string }>>; listTiles(id: string): Promise<Array<{ tile_type: string; config_json?: string; config?: string }>> } }).__WS_BACKEND__;
      const [ws] = await b.listWorkstreams();
      const t = (await b.listTiles(ws.id)).find((x) => x.tile_type === "file_explorer")!;
      return JSON.parse(t.config_json ?? t.config ?? "{}");
    });
    expect(config.viewState?.openTabs?.tabs?.length).toBe(4);

    // Restart: a fresh page whose backend starts from the persisted config.
    const fresh = await page.context().newPage();
    await start(fresh, { config });
    await expect(tabs(fresh)).toHaveCount(4);
    expect(await tabNames(fresh)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    await expect(tab(fresh, "d.ts")).toHaveAttribute("data-preview", "true");
    await expect(tab(fresh, "b.ts")).toHaveAttribute("data-active", "true");
    await expect.poll(async () => (await editorState(fresh)).value).toContain("b.ts line 1");
    await expect.poll(async () => (await editorState(fresh)).cursorLine).toBe(125);
    await expect.poll(async () => Math.abs((await editorState(fresh)).firstLine - 120)).toBeLessThanOrEqual(2);
  });

  test("AT-5: Ctrl+Tab switcher, Cmd+1, Ctrl+W; terminals untouched", async ({ page }) => {
    await start(page, { terminal: true });
    for (const name of ["x.ts", "y.ts", "z.ts"]) {
      await openFromTree(page, name);
      await tab(page, name).dblclick();
    }
    await tab(page, "z.ts").click();
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    const items = page.getByTestId("tab-switcher-item");
    await expect(items).toHaveText(["z.ts", "y.ts", "x.ts"]);
    await page.keyboard.up("Control");
    await expect(page.getByTestId("tab-switcher")).toHaveCount(0);
    await expect(tab(page, "y.ts")).toHaveAttribute("data-active", "true");

    await page.keyboard.press("Meta+1");
    await expect(tab(page, "x.ts")).toHaveAttribute("data-active", "true");
    await page.keyboard.press("Control+w");
    expect(await tabNames(page)).toEqual(["y.ts", "z.ts"]);

    await page.locator("[data-tile-id]").filter({ hasText: "Shell" }).first().click();
    await page.keyboard.press("Control+w");
    await page.waitForTimeout(300);
    expect(await tabNames(page)).toEqual(["y.ts", "z.ts"]);
  });

  test("AT-6: Back and Forward walk history across tabs", async ({ page }) => {
    await start(page);
    await openFromTree(page, "x.md");
    await tab(page, "x.md").dblclick();
    await openFromTree(page, "y.ts");
    await tab(page, "y.ts").dblclick();
    await tab(page, "x.md").click();
    const ex = explorer(page);
    await ex.getByTestId("repo-explorer-mode-preview").click();
    await ex.getByRole("link", { name: "z" }).click();
    const shown = () => ex.locator('[data-testid="open-file-tab"][data-active="true"]').getAttribute("data-path").then((p) => (p ?? "").split(/[\\/]/).pop());
    const seq: Array<string | undefined> = [];
    await expect(tab(page, "z.ts")).toHaveAttribute("data-active", "true");
    seq.push(await shown());
    await tab(page, "y.ts").click();
    await expect(tab(page, "y.ts")).toHaveAttribute("data-active", "true");
    seq.push(await shown());
    const before = (await tabNames(page)).sort();
    for (const id of ["repo-explorer-nav-back", "repo-explorer-nav-back", "repo-explorer-nav-forward"]) {
      const prev = await shown();
      await ex.getByTestId(id).click();
      await expect.poll(shown).not.toBe(prev);
      seq.push(await shown());
    }
    expect(seq).toEqual(["z.ts", "y.ts", "z.ts", "x.md", "z.ts"]);
    expect((await tabNames(page)).sort()).toEqual(before);
  });

  test("AT-7: tab menu, middle-click and Reveal in tree", async ({ page }) => {
    await start(page);
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await openFromTree(page, name);
      await tab(page, name).dblclick();
    }
    await tab(page, "b.ts").click();
    const menu = async (name: string, item: string) => {
      await tab(page, name).click({ button: "right" });
      await page.getByRole("menuitem", { name: item }).click();
    };
    await tab(page, "d.ts").click({ button: "middle" });
    expect(await tabNames(page)).toEqual(["a.ts", "b.ts", "c.ts"]);
    await menu("b.ts", "Close to the right");
    expect(await tabNames(page)).toEqual(["a.ts", "b.ts"]);
    await menu("b.ts", "Reveal in tree");
    const revealed = explorer(page).locator('[data-testid="file-tree-item"][data-revealed="true"]');
    await expect(revealed).toHaveCount(1);
    await expect(revealed).toContainText("b.ts");
    expect(await tabNames(page)).toEqual(["a.ts", "b.ts"]);
    await menu("b.ts", "Close others");
    expect(await tabNames(page)).toEqual(["b.ts"]);
    await menu("b.ts", "Close all");
    await expect(tabs(page)).toHaveCount(0);
  });
});

type Ed = {
  setPosition(p: { lineNumber: number; column: number }): void;
  focus(): void;
  setScrollTop(n: number): void;
  getTopForLineNumber(n: number): number;
  trigger(source: string, id: string, payload: unknown): void;
  getVisibleRanges(): Array<{ startLineNumber: number }>;
  getPosition(): { lineNumber: number } | null;
  getValue(): string;
  getDomNode(): HTMLElement | null;
};

/** Runs `fn` against the visible Monaco editor (the dev server serves the app's monaco module). */
async function editorEval(page: Page, fn: (ed: Ed) => void) {
  await page.evaluate(async (src) => {
    const mod = await import(/* @vite-ignore */ "/src/files/loadMonaco.ts");
    const eds = mod.getMonacoIfLoaded()!.editor.getEditors() as unknown as Ed[];
    const area = (e: Ed) => { const r = e.getDomNode()?.getBoundingClientRect(); return r ? r.width * r.height : 0; };
    const ed = eds.filter((e) => e.getDomNode()?.isConnected).sort((p, q) => area(q) - area(p))[0];
    (new Function("ed", `(${src})(ed)`))(ed);
  }, fn.toString());
}

async function editorState(page: Page) {
  return page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ "/src/files/loadMonaco.ts");
    const eds = (mod.getMonacoIfLoaded()?.editor.getEditors() ?? []) as unknown as Ed[];
    const area = (e: Ed) => { const r = e.getDomNode()?.getBoundingClientRect(); return r ? r.width * r.height : 0; };
    const ed = eds.filter((e) => e.getDomNode()?.isConnected).sort((p, q) => area(q) - area(p))[0];
    if (!ed) return { value: "", firstLine: 0, cursorLine: 0 };
    return { value: ed.getValue(), firstLine: ed.getVisibleRanges()[0]?.startLineNumber ?? 0, cursorLine: ed.getPosition()?.lineNumber ?? 0 };
  });
}
