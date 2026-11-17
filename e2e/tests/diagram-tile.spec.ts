/**
 * Diagram tile (ADR 043). Covers the browser-build side of AT-1..AT-8 in
 * files/features/diagram-tile/acceptance.md: the in-memory backend stands in
 * for SQLite, and file writes go to an in-page map through stubbed commands.
 */
import { test, expect, type Page } from "@playwright/test";

type El = { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; containerId?: string | null; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null; groupIds?: string[] };

let pageErrors: string[] = [];
test.beforeEach(() => { pageErrors = []; });
test.afterEach(() => { expect(pageErrors).toEqual([]); });

interface SeedTile { type: string; title: string; boards?: Array<{ name: string; scene?: unknown }> }

async function start(page: Page, opts: { tiles?: SeedTile[]; files?: Record<string, string>; saveTo?: string[] } = {}) {
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.addInitScript(({ tiles, files, saveTo }) => {
    const disk: Record<string, string> = { ...files };
    // The browser build may join paths Windows-style; the fake disk keys use "/".
    const norm = (p: string) => p.replace(/\\/g, "/");
    const answers = [...saveTo];
    Object.assign(window, {
      __WS_DISK__: disk,
      __WS_DIALOG_SAVE__: () => answers.shift() ?? null,
      __WS_INVOKE_HANDLERS__: {
        get_setting: () => null,
        set_setting: () => null,
        read_text_file: ({ path }: { path: string }) => {
          const key = norm(path);
          if (!(key in disk)) throw new Error(`not found: ${path}`);
          return { content: disk[key], hash_hex: String(disk[key].length), line_ending: "lf", has_trailing_newline: true };
        },
        write_text_file: ({ args }: { args: { path: string; content: string } }) => {
          disk[norm(args.path)] = args.content;
          return { mtime_unix_ms: 0, hash_hex: String(args.content.length) };
        },
        write_binary_file: ({ path, base64 }: { path: string; base64: string }) => { disk[norm(path)] = `base64:${base64}`; return null; },
        canonicalize_path: ({ path }: { path: string }) => path,
        watch_directory: () => null,
        unwatch_directory: () => null,
        list_git_hooks: () => [],
        git_current_branch: () => "main",
      },
      __WS_DEMO_SEED__: {
        workstreams: [{ name: "Draw", directory: "/demo/draw", loaded: true, tiles }],
        files: Object.entries(files).map(([path, content]) => ({ path, content })),
      },
    });
  }, { tiles: opts.tiles ?? [], files: opts.files ?? {}, saveTo: opts.saveTo ?? [] });
  await page.goto("/");
  await page.getByTestId("workstream-item").filter({ hasText: "Draw" }).click();
}

/** Live elements of the nth canvas on screen (in DOM order). */
async function elements(page: Page, nth = 0): Promise<El[]> {
  const key = await page.getByTestId("diagram-canvas").nth(nth).getAttribute("data-diagram-key");
  return page.evaluate((key) => {
    const reg = (window as unknown as { __WS_DIAGRAMS__?: Record<string, { getSceneElements(): unknown[] }> }).__WS_DIAGRAMS__ ?? {};
    return key && reg[key] ? (JSON.parse(JSON.stringify(reg[key].getSceneElements())) as El[]) : [];
  }, key);
}

async function canvasBox(page: Page, nth = 0) {
  const canvas = page.getByTestId("diagram-canvas").nth(nth).locator("canvas.interactive");
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  return (await canvas.boundingBox())!;
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 4 });
  await page.mouse.up();
}

const byType = (els: El[], type: string) => els.filter((e) => e.type === type);

/** Where a scene point is on screen, for the nth canvas. */
async function toScreen(page: Page, x: number, y: number, nth = 0): Promise<[number, number]> {
  const key = await page.getByTestId("diagram-canvas").nth(nth).getAttribute("data-diagram-key");
  const box = await canvasBox(page, nth);
  const s = await page.evaluate((key) => {
    const api = (window as unknown as { __WS_DIAGRAMS__: Record<string, { getAppState(): { scrollX: number; scrollY: number; zoom: { value: number }; offsetLeft: number; offsetTop: number } }> }).__WS_DIAGRAMS__[key!];
    const a = api.getAppState();
    return { scrollX: a.scrollX, scrollY: a.scrollY, zoom: a.zoom.value };
  }, key);
  return [box.x + (x + s.scrollX) * s.zoom, box.y + (y + s.scrollY) * s.zoom];
}

const centerOf = (e: El): [number, number] => [e.x + e.width / 2, e.y + e.height / 2];

function rectEl(id: string, x: number, y: number, label?: string) {
  const out: Array<Record<string, unknown>> = [{ id, type: "rectangle", x, y, width: 120, height: 60, boundElements: label ? [{ id: `${id}-t`, type: "text" }] : [] }];
  if (label) out.push({ id: `${id}-t`, type: "text", x: x + 40, y: y + 20, width: 40, height: 25, text: label, originalText: label, containerId: id, fontSize: 20, verticalAlign: "middle", textAlign: "center" });
  return out;
}

async function importMermaid(page: Page, text: string) {
  await page.getByTestId("diagram-mermaid-open").click();
  await page.getByTestId("diagram-mermaid-input").fill(text);
  await page.getByTestId("diagram-mermaid-import").click();
}

const keep = (list: El[]) => list.map((e) => ({ id: e.id, x: Math.round(e.x), y: Math.round(e.y) }));


test.describe("Diagram tile", () => {
  test("AT-1: added from the menu and with Alt+G; a bound arrow follows a moved box and all of it survives a restart", async ({ page }) => {
    await start(page);
    await page.getByTestId("add-tile-button").click();
    await page.getByTestId("add-tile-item-diagram").click();
    await expect(page.getByTestId("diagram-tile")).toHaveCount(1);
    await page.keyboard.press("Alt+g");
    await expect(page.getByTestId("diagram-tile")).toHaveCount(2);

    const box = await canvasBox(page, 0);
    const at = (dx: number, dy: number): [number, number] => [box.x + dx, box.y + dy];
    await page.mouse.click(...at(40, 300));
    await page.keyboard.press("r");
    await drag(page, at(60, 180), at(160, 240));
    await page.keyboard.press("r");
    await drag(page, at(300, 180), at(400, 240));
    await page.keyboard.press("a");
    // Start and end just inside the boxes' edges, where Excalidraw binds.
    await drag(page, at(156, 210), at(304, 210));
    await page.keyboard.press("Escape");
    let els = await elements(page);
    const rects = byType(els, "rectangle");
    const [arrow] = byType(els, "arrow");
    expect(rects).toHaveLength(2);
    expect(arrow.startBinding?.elementId).toBe(rects[0].id);
    expect(arrow.endBinding?.elementId).toBe(rects[1].id);

    // Move the first box down by dragging its edge.
    await page.keyboard.press("v");
    await drag(page, at(60, 210), at(60, 330));
    els = await elements(page);
    const moved = els.find((e) => e.id === rects[0].id)!;
    expect(moved.y - rects[0].y).toBeGreaterThan(80);
    const movedArrow = els.find((e) => e.id === arrow.id)!;
    expect(movedArrow.startBinding?.elementId).toBe(rects[0].id);
    expect(movedArrow.y).toBeGreaterThan(arrow.y + 30);

    // Restart: a fresh app whose storage holds what the tile saved.
    await page.waitForTimeout(800);
    const saved = await page.evaluate(async () => {
      const b = (window as unknown as { __WS_BACKEND__: { listWorkstreams(): Promise<Array<{ id: string }>>; listTiles(id: string): Promise<Array<{ id: string; tile_type: string }>>; diagramListBoards(id: string): Promise<Array<{ name: string; scene_json: string }>> } }).__WS_BACKEND__;
      const [ws] = await b.listWorkstreams();
      const out = [];
      const order = [...document.querySelectorAll('[data-testid="diagram-canvas"]')].map((el) => el.getAttribute("data-diagram-key")!.split(":")[0]);
      const tiles = (await b.listTiles(ws.id)).filter((x) => x.tile_type === "diagram").sort((p, q) => order.indexOf(p.id) - order.indexOf(q.id));
      for (const t of tiles) {
        out.push((await b.diagramListBoards(t.id)).map((x) => ({ name: x.name, scene: JSON.parse(x.scene_json) })));
      }
      return out;
    });
    expect(saved).toHaveLength(2);
    expect(saved.map((boards) => boards.length)).toEqual([1, 1]);
    const fresh = await page.context().newPage();
    await start(fresh, { tiles: saved.map((boards, i) => ({ type: "diagram", title: `Diagram ${i + 1}`, boards })) });
    await canvasBox(fresh, 0);
    await expect.poll(async () => (await elements(fresh)).length).toBe(3);
    const after = await elements(fresh);
    const keep = (list: El[]) => list.map((e) => ({ id: e.id, type: e.type, x: Math.round(e.x), y: Math.round(e.y), s: e.startBinding?.elementId ?? null, t: e.endBinding?.elementId ?? null }));
    expect(keep(after)).toEqual(keep(els));
  });

  test("AT-2: boards keep their own content through add, rename, switch and delete", async ({ page }) => {
    await start(page, { tiles: [{ type: "diagram", title: "Diagram" }] });
    const box = await canvasBox(page);
    const at = (dx: number, dy: number): [number, number] => [box.x + dx, box.y + dy];
    await page.mouse.click(...at(40, 300));
    await page.keyboard.press("r");
    await drag(page, at(500, 180), at(620, 260));
    await expect.poll(async () => byType(await elements(page), "rectangle").length).toBe(1);
    const firstId = await page.getByTestId("diagram-board-tab").first().getAttribute("data-board-id");

    await page.getByTestId("diagram-board-add").click();
    await expect(page.getByTestId("diagram-board-tab")).toHaveCount(2);
    await expect(page.getByTestId("diagram-board-tab").nth(1)).toHaveAttribute("data-active", "true");
    await page.getByTestId("diagram-board-tab").nth(1).dblclick();
    await page.getByTestId("diagram-board-rename").fill("Sequence");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("diagram-board-tab").nth(1)).toHaveText(/Sequence/);
    const box2 = await canvasBox(page);
    await page.mouse.click(box2.x + 600, box2.y + 400);
    await page.keyboard.press("o");
    await drag(page, [box2.x + 500, box2.y + 180], [box2.x + 620, box2.y + 260]);
    await expect.poll(async () => (await elements(page)).map((e) => e.type)).toEqual(["ellipse"]);

    for (let i = 0; i < 2; i++) {
      await page.getByTestId("diagram-board-tab").first().click();
      await expect.poll(async () => (await elements(page)).map((e) => e.type)).toEqual(["rectangle"]);
      await page.getByTestId("diagram-board-tab").filter({ hasText: "Sequence" }).click();
      await expect.poll(async () => (await elements(page)).map((e) => e.type)).toEqual(["ellipse"]);
    }
    await page.getByTestId("diagram-board-delete").click();
    await page.getByTestId("diagram-board-delete-confirm").click();
    await expect(page.getByTestId("diagram-board-tab")).toHaveCount(1);
    await expect(page.getByTestId("diagram-board-tab")).toHaveAttribute("data-board-id", firstId!);
    await expect.poll(async () => (await elements(page)).map((e) => e.type)).toEqual(["rectangle"]);
  });

  test("AT-3: drawing writes nothing to disk; Save to file uses the system dialog and writes where I chose", async ({ page }) => {
    await start(page, { tiles: [{ type: "diagram", title: "Diagram" }], saveTo: ["/Users/me/Desktop/Board 1.excalidraw", "/demo/draw/notes/board"] });
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 40, box.y + 300);
    await page.keyboard.press("r");
    await drag(page, [box.x + 500, box.y + 180], [box.x + 620, box.y + 260]);
    await page.keyboard.press("o");
    await drag(page, [box.x + 700, box.y + 180], [box.x + 800, box.y + 260]);
    await page.waitForTimeout(600);
    const disk = () => page.evaluate(() => ({ ...(window as unknown as { __WS_DISK__: Record<string, string> }).__WS_DISK__ }));
    expect(Object.keys(await disk())).toEqual([]);

    for (const expected of ["/Users/me/Desktop/Board 1.excalidraw", "/demo/draw/notes/board.excalidraw"]) {
      await page.getByTestId("diagram-menu").click();
      await page.getByTestId("diagram-save-file").click();
      await expect(page.getByTestId("diagram-notice")).toContainText(expected);
    }
    const dialogs = await page.evaluate(() => (window.__WS_INVOKE_LOG__ ?? []).filter((c) => c.cmd === "dialog_save").map((c) => c.args));
    expect(dialogs[0]).toMatchObject({ filters: [{ extensions: ["excalidraw"] }] });
    expect(String((dialogs[0] as { defaultPath: string }).defaultPath).replace(/\\/g, "/")).toBe("/demo/draw/Board 1.excalidraw");
    const files = await disk();
    expect(Object.keys(files).sort()).toEqual(["/Users/me/Desktop/Board 1.excalidraw", "/demo/draw/notes/board.excalidraw"]);
    for (const text of Object.values(files)) {
      const json = JSON.parse(text);
      expect(json.type).toBe("excalidraw");
      expect(json.elements).toHaveLength(2);
    }
  });

  test("AT-4: .excalidraw files open as a canvas and save edits; boards export and copy as Excalidraw", async ({ page }) => {
    const flow = { type: "excalidraw", version: 2, source: "https://excalidraw.com", elements: [...rectEl("a", 0, 0), ...rectEl("b", 200, 0)].filter((e) => e.type === "rectangle").concat([{ id: "c", type: "ellipse", x: 400, y: 0, width: 80, height: 60 }]), appState: { viewBackgroundColor: "#ffffff" }, files: {} };
    await start(page, {
      tiles: [
        { type: "file_explorer", title: "Explorer" },
        { type: "diagram", title: "Diagram", boards: [{ name: "Board 1", scene: { elements: [...rectEl("x", 0, 0), ...rectEl("y", 300, 0)].filter((e) => e.type === "rectangle"), files: {} } }] },
      ],
      files: { "/demo/draw/flow.excalidraw": JSON.stringify(flow) },
      saveTo: ["/tmp/out/board.excalidraw"],
    });
    const explorer = page.locator("[data-tile-id]").filter({ hasText: "Explorer" }).first();
    await explorer.getByTestId("file-tree-item").filter({ hasText: "flow.excalidraw" }).click();
    await expect(explorer.getByTestId("excalidraw-file-view")).toBeVisible();
    await expect(explorer.getByTestId("file-editor-view")).toHaveCount(0);
    const fileKey = "file:";
    const fileElements = () => page.evaluate((prefix) => {
      const reg = (window as unknown as { __WS_DIAGRAMS__?: Record<string, { getSceneElements(): Array<{ type: string }> }> }).__WS_DIAGRAMS__ ?? {};
      const key = Object.keys(reg).find((k) => k.startsWith(prefix));
      return key ? reg[key].getSceneElements().map((e) => e.type) : [];
    }, fileKey);
    await expect.poll(fileElements).toEqual(["rectangle", "rectangle", "ellipse"]);

    const canvas = explorer.getByTestId("diagram-canvas").locator("canvas.interactive");
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + 30, box.y + box.height - 60);
    await page.keyboard.press("t");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 80);
    await page.keyboard.type("label");
    await page.keyboard.press("Escape");
    await expect.poll(async () => {
      const text = await page.evaluate(() => (window as unknown as { __WS_DISK__: Record<string, string> }).__WS_DISK__["/demo/draw/flow.excalidraw"]);
      const json = JSON.parse(text);
      return { n: json.elements.length, label: json.elements.some((e: El) => e.type === "text" && e.text === "label"), type: json.type, source: json.source };
    }).toEqual({ n: 4, label: true, type: "excalidraw", source: "https://excalidraw.com" });

    const tile = page.getByTestId("diagram-tile");
    await expect(tile.getByTestId("diagram-canvas")).toBeVisible();
    await tile.getByTestId("diagram-menu").click();
    await tile.getByTestId("diagram-export-excalidraw").click();
    await expect(tile.getByTestId("diagram-notice")).toContainText("/tmp/out/board.excalidraw");
    const exported = JSON.parse(await page.evaluate(() => (window as unknown as { __WS_DISK__: Record<string, string> }).__WS_DISK__["/tmp/out/board.excalidraw"]));
    expect(exported.type).toBe("excalidraw");
    expect(exported.elements).toHaveLength(2);

    await tile.getByTestId("diagram-menu").click();
    await tile.getByTestId("diagram-copy-excalidraw").click();
    const clip = JSON.parse(await page.evaluate(() => (window as unknown as { __WS_CLIPBOARD_TEXT__: string }).__WS_CLIPBOARD_TEXT__));
    expect(clip.type).toBe("excalidraw/clipboard");
    expect(clip.elements).toHaveLength(2);
  });

  test("AT-5: Mermaid of each kind becomes separate editable shapes; invalid Mermaid adds nothing", async ({ page }) => {
    await start(page, { tiles: [{ type: "diagram", title: "Diagram" }] });
    await canvasBox(page);
    const samples: Array<[string, string, string[]]> = [
      ["flowchart", "flowchart LR\n  A[Client] -->|calls| B[Server]\n  B --> C[Store]", ["Client", "Server", "Store"]],
      ["sequence", "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi back", ["Alice", "Bob", "Hello"]],
      ["class", "classDiagram\n  Animal <|-- Duck\n  Animal : +int age\n  Duck : +swim()", ["Animal", "Duck"]],
      ["state", "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: start\n  Busy --> Idle: done", ["Idle", "Busy"]],
    ];
    let before: El[] = [];
    for (const [kind, text, labels] of samples) {
      await importMermaid(page, text);
      await expect(page.getByTestId("diagram-mermaid-dialog"), kind).toHaveCount(0, { timeout: 15_000 });
      const now = await elements(page);
      const added = now.filter((e) => !before.some((b) => b.id === e.id));
      expect(added.length, kind).toBeGreaterThanOrEqual(3);
      expect(byType(added, "image"), kind).toHaveLength(0);
      expect(byType(added, "arrow").length, kind).toBeGreaterThanOrEqual(1);
      const texts = added.filter((e) => e.type === "text").map((e) => e.text ?? "").join(" | ");
      for (const label of labels) expect(texts, kind).toContain(label);
      // The original shapes did not move.
      expect(keep(now.filter((e) => before.some((b) => b.id === e.id))), kind).toEqual(keep(before));
      before = now;
    }

    // Move one flowchart node: only it, its label and the arrows bound to it change.
    const all = await elements(page);
    const label = all.find((e) => e.type === "text" && e.text === "Client")!;
    const node = all.find((e) => e.id === label.containerId)!;
    const [sx, sy] = await toScreen(page, ...centerOf(node));
    await page.keyboard.press("Escape");
    await drag(page, [sx, sy], [sx + 10, sy + 90]);
    const moved = await elements(page);
    const changed = moved.filter((e) => { const o = all.find((x) => x.id === e.id)!; return Math.round(o.x) !== Math.round(e.x) || Math.round(o.y) !== Math.round(e.y); }).map((e) => e.id);
    expect(changed).toContain(node.id);
    const allowed = new Set([node.id, label.id, ...all.filter((e) => e.type === "arrow" && (e.startBinding?.elementId === node.id || e.endBinding?.elementId === node.id)).map((e) => e.id)]);
    expect(changed.filter((id) => !allowed.has(id))).toEqual([]);

    await importMermaid(page, "flowchart LR\n  A[[[ -->");
    await expect(page.getByTestId("diagram-mermaid-error")).toBeVisible();
    await page.waitForTimeout(400);
    expect((await elements(page)).length).toBe(moved.length);
  });

  test("AT-6: palette shapes for each kind land as editable shapes and placing a message moves nothing", async ({ page }) => {
    await start(page, { tiles: [{ type: "diagram", title: "Diagram" }] });
    await canvasBox(page);
    await page.getByTestId("diagram-palette-toggle").click();
    await expect(page.getByTestId("diagram-palette-group")).toHaveCount(4);
    // The class box's fields are ordinary text: place it and edit them in place.
    await page.locator('[data-testid="diagram-palette-item"][data-name="Class: Class box"]').click();
    await expect.poll(async () => (await elements(page)).length).toBeGreaterThan(0);
    const field = (await elements(page)).find((e) => e.type === "text" && (e.text ?? "").includes("+ field: Type"))!;
    await page.keyboard.press("Escape");
    const [fx, fy] = await toScreen(page, ...centerOf(field));
    await page.mouse.dblclick(fx, fy);
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Order\n+ total: Money");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await elements(page)).find((e) => e.id === field.id)?.text).toContain("+ total: Money");

    const items = ["Flow: Component", "Flow: Actor", "Sequence: Actor with lifeline", "Sequence: Message", "Class: Class box", "State: State", "State: Initial state", "State: Final state", "State: Transition"];
    for (const name of items) {
      const before = (await elements(page)).length;
      await page.locator(`[data-testid="diagram-palette-item"][data-name="${name}"]`).click();
      await expect.poll(async () => (await elements(page)).length, name).toBeGreaterThan(before);
    }
    // Inserting a message moves no existing shape (no reflow).
    const before = await elements(page);
    await page.locator('[data-testid="diagram-palette-item"][data-name="Sequence: Message"]').click();
    await expect.poll(async () => (await elements(page)).length).toBeGreaterThan(before.length);
    const after = await elements(page);
    expect(keep(after.filter((e) => before.some((b) => b.id === e.id)))).toEqual(keep(before));
  });

  test("AT-7: an agent's Mermaid lands on the open board beside my shapes, which keep their ids and places", async ({ page }) => {
    const ideas = {
      elements: [
        ...rectEl("api", 0, 0, "API"),
        ...rectEl("db", 300, 0, "DB"),
        { id: "link", type: "arrow", x: 120, y: 30, width: 180, height: 0, points: [[0, 0], [180, 0]], startBinding: { elementId: "api", focus: 0, gap: 1 }, endBinding: { elementId: "db", focus: 0, gap: 1 } },
      ],
      files: {},
    };
    ideas.elements[0].boundElements = [{ id: "api-t", type: "text" }, { id: "link", type: "arrow" }];
    ideas.elements[2].boundElements = [{ id: "db-t", type: "text" }, { id: "link", type: "arrow" }];
    await start(page, { tiles: [{ type: "diagram", title: "Diagram", boards: [{ name: "Ideas", scene: ideas }] }] });
    await canvasBox(page);
    await expect.poll(async () => (await elements(page)).length).toBe(5);
    const mine = await elements(page);
    const boardId = await page.getByTestId("diagram-board-tab").first().getAttribute("data-board-id");
    await page.evaluate((id) => {
      const b = (window as unknown as { __WS_BACKEND__: { queueDiagramAddition(id: string, m: string): unknown } }).__WS_BACKEND__;
      b.queueDiagramAddition(id!, "flowchart LR\n  Q[Queue] --> W[Worker]");
      b.queueDiagramAddition(id!, "not mermaid at all ((");
    }, boardId);
    await expect.poll(async () => (await elements(page)).length, { timeout: 15_000 }).toBeGreaterThan(5);
    const now = await elements(page);
    expect(keep(now.filter((e) => mine.some((m) => m.id === e.id)))).toEqual(keep(mine));
    expect(now.filter((e) => e.type === "text").map((e) => e.text)).toEqual(expect.arrayContaining(["API", "DB", "Queue", "Worker"]));
    const added = now.filter((e) => !mine.some((m) => m.id === e.id));
    const right = Math.max(...mine.map((e) => e.x + e.width));
    expect(Math.min(...added.map((e) => e.x))).toBeGreaterThan(right);
    await expect.poll(() => page.evaluate(async (id) => {
      const b = (window as unknown as { __WS_BACKEND__: { diagramAdditions(id: string): Promise<Array<{ status: string }>> } }).__WS_BACKEND__;
      return (await b.diagramAdditions(id!)).map((a) => a.status);
    }, boardId)).toEqual(["failed"]);
  });

  test("AT-8: copy as PNG, export SVG and PNG, and paste an image", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page, { tiles: [{ type: "diagram", title: "Diagram" }], saveTo: ["/out/board.svg", "/out/board.png"] });
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 40, box.y + 300);
    await page.keyboard.press("r");
    await drag(page, [box.x + 500, box.y + 180], [box.x + 620, box.y + 260]);
    await page.keyboard.press("Escape");
    await page.getByTestId("diagram-menu").click();
    await page.getByTestId("diagram-copy-png").click();
    await expect(page.getByTestId("diagram-notice")).toHaveText("Copied as PNG");
    const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => [...i.types]));
    expect(types).toContain("image/png");

    await page.getByTestId("diagram-menu").click();
    await page.getByTestId("diagram-export-svg").click();
    await expect(page.getByTestId("diagram-notice")).toContainText("/out/board.svg");
    await page.getByTestId("diagram-menu").click();
    await page.getByTestId("diagram-export-png").click();
    await expect(page.getByTestId("diagram-notice")).toContainText("/out/board.png");
    const files = await page.evaluate(() => (window as unknown as { __WS_DISK__: Record<string, string> }).__WS_DISK__);
    expect(files["/out/board.svg"].startsWith("<svg")).toBe(true);
    expect(files["/out/board.svg"].length).toBeGreaterThan(500);
    const png = Buffer.from(files["/out/board.png"].replace(/^base64:/, ""), "base64");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(500);

    // Paste a screenshot: the clipboard PNG from above.
    const canvas = page.getByTestId("diagram-canvas").locator("canvas.interactive");
    await canvas.click({ position: { x: 400, y: 400 } });
    await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const blob = await item.getType("image/png");
      const data = new DataTransfer();
      data.items.add(new File([blob], "shot.png", { type: "image/png" }));
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => byType(await elements(page), "image").length, { timeout: 10_000 }).toBe(1);
  });
});
