import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  BEGIN_MARKER,
  extractArrayLiteral,
  END_MARKER,
  applyMarkers,
  generate,
  parseAppBindings,
  parseExternalBindings,
  parseWalkthroughBindings,
} from "../gen-keymaps.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");

const keyboardSrc = read("src", "domain", "keyboard.ts");
const walkthroughSrc = read("src", "domain", "walkthrough-keys.ts");
const externalSrc = read("src", "domain", "external-keys.ts");

/** Count occurrences of a field inside the named registry literal only. */
function countField(src, name, field) {
  const literal = extractArrayLiteral(src, name);
  return (literal.match(new RegExp(`^\\s*${field}:`, "gm")) ?? []).length;
}

const fresh = generate({ keyboardSrc, walkthroughSrc, externalSrc, existing: null });

describe("registry parsing", () => {
  it("reads every app binding with combo, description and action", () => {
    const bindings = parseAppBindings(keyboardSrc);
    const comboCount = countField(keyboardSrc, "APP_KEY_BINDINGS", "combo");
    expect(bindings).toHaveLength(comboCount);
    for (const b of bindings) {
      expect(b.combo).toBeTruthy();
      expect(b.description).toBeTruthy();
      expect(b.action).toBeTruthy();
    }
  });

  it("reads every walkthrough and external binding", () => {
    expect(parseWalkthroughBindings(walkthroughSrc).length).toBe(
      countField(walkthroughSrc, "WALKTHROUGH_KEY_BINDINGS", "combo"),
    );
    const external = parseExternalBindings(externalSrc);
    expect(external.length).toBe(countField(externalSrc, "EXTERNAL_KEY_BINDINGS", "id"));
    for (const b of external) expect(b.surface).toBeTruthy();
  });
});

describe("generated keymaps document", () => {
  it("contains every combo and description from all three registries", () => {
    const all = [
      ...parseAppBindings(keyboardSrc),
      ...parseWalkthroughBindings(walkthroughSrc),
      ...parseExternalBindings(externalSrc),
    ];
    expect(all.length).toBeGreaterThan(20);
    for (const b of all) {
      expect(fresh, `missing combo ${b.combo}`).toContain(b.combo);
      expect(fresh, `missing description for ${b.combo}`).toContain(b.description);
    }
  });

  it("marks the flagged plan and walkthrough bindings with their flag names", () => {
    const planRow = fresh.split("\n").find((l) => l.includes("`Alt+P`"));
    const debugRow = fresh.split("\n").find((l) => l.includes("`Alt+D`"));
    expect(planRow).toContain("plan-tile");
    expect(planRow).toMatch(/feature-flagged/i);
    expect(debugRow).toContain("debug-walkthrough");
    expect(debugRow).toMatch(/feature-flagged/i);
  });

  it("groups external shortcuts with their owning surface", () => {
    expect(fresh).toContain("Owning surface");
    expect(fresh).toContain("Repo Explorer");
    expect(fresh).toContain("Monaco editor");
  });

  it("preserves hand-written prose outside the sentinel markers", () => {
    const existing = `# Title\n\nIntro prose kept by hand.\n\n${BEGIN_MARKER}\nstale body\n${END_MARKER}\n\nTrailing prose kept by hand.\n`;
    const regenerated = generate({ keyboardSrc, walkthroughSrc, externalSrc, existing });
    expect(regenerated).toContain("Intro prose kept by hand.");
    expect(regenerated).toContain("Trailing prose kept by hand.");
    expect(regenerated).not.toContain("stale body");
    expect(regenerated).toContain("`Alt+P`");
  });

  it("is idempotent", () => {
    expect(generate({ keyboardSrc, walkthroughSrc, externalSrc, existing: fresh })).toBe(fresh);
  });

  it("rebuilds a full document when the markers are absent", () => {
    const out = applyMarkers(null, "BODY");
    expect(out).toContain("AUTO-GENERATED — do not edit by hand.");
    expect(out).toContain(BEGIN_MARKER);
    expect(out).toContain("BODY");
  });
});

function runCheck() {
  try {
    const stdout = execFileSync(process.execPath, [join(REPO, "scripts", "gen-keymaps.mjs"), "--check"], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("--check", () => {
  it("passes against the committed docs/keymaps.md", () => {
    const committed = read("docs", "keymaps.md");
    expect(committed).toBe(fresh);
    const result = runCheck();
    expect(result.output).toMatch(/up to date/);
    expect(result.code).toBe(0);
  });

  it("fails with a clear message when the committed output is tampered with", () => {
    const path = join(REPO, "docs", "keymaps.md");
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, original.replace("Close the focused tile", "Close it"));
      const result = runCheck();
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/stale/);
      expect(result.output).toContain("node scripts/gen-keymaps.mjs");
    } finally {
      writeFileSync(path, original);
    }
  });
});
