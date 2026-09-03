#!/usr/bin/env node
/**
 * gen-keymaps.mjs
 *
 * Generates docs/keymaps.md — the user-facing keyboard shortcut reference —
 * directly from the three declarative registries that are the single source of
 * truth for keys in the app:
 *
 *   - `APP_KEY_BINDINGS`         in src/domain/keyboard.ts
 *   - `WALKTHROUGH_KEY_BINDINGS` in src/domain/walkthrough-keys.ts
 *   - `EXTERNAL_KEY_BINDINGS`    in src/domain/external-keys.ts
 *
 * The registries are parsed with pure Node — no TypeScript compile, no deps —
 * so this is safe to run from the pre-commit hook.
 *
 * Generated content is written between sentinel markers, so any hand-written
 * prose outside them survives regeneration.
 *
 * Feature-flagged bindings (Alt+P behind `plan-tile`, Alt+D behind
 * `debug-walkthrough`) are rendered with their flag name rather than omitted or
 * advertised as unconditionally available, per ADR 010.
 *
 * Usage:
 *   node scripts/gen-keymaps.mjs           # write docs/keymaps.md
 *   node scripts/gen-keymaps.mjs --check   # exit 1 if the file is stale
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const KEYBOARD_TS = join(REPO, "src", "domain", "keyboard.ts");
const WALKTHROUGH_TS = join(REPO, "src", "domain", "walkthrough-keys.ts");
const EXTERNAL_TS = join(REPO, "src", "domain", "external-keys.ts");
const OUT = join(REPO, "docs", "keymaps.md");

export const BEGIN_MARKER = "<!-- BEGIN GENERATED KEYMAPS -->";
export const END_MARKER = "<!-- END GENERATED KEYMAPS -->";

/**
 * Extract the top-level array literal assigned to `name`, as source text.
 * Brace/bracket counting (string- and comment-aware) keeps nested objects and
 * arrays intact.
 */
export function extractArrayLiteral(src, name) {
  const decl = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[`).exec(src);
  if (!decl) return null;
  const start = decl.index + decl[0].length - 1;
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/** Split an array literal body into its top-level `{ ... }` object entries. */
export function splitObjectEntries(arrayLiteral) {
  const entries = [];
  let depth = 0;
  let start = -1;
  let quote = null;
  for (let i = 0; i < arrayLiteral.length; i++) {
    const ch = arrayLiteral[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) entries.push(arrayLiteral.slice(start, i + 1));
    }
  }
  return entries;
}

/** Read a string-valued field from an object literal, joining adjacent parts. */
export function readStringField(entry, field) {
  const re = new RegExp(`(^|[\\s{,])${field}\\s*:\\s*`, "m");
  const m = re.exec(entry);
  if (!m) return null;
  let i = m.index + m[0].length;
  let value = "";
  while (i < entry.length) {
    while (i < entry.length && /\s/.test(entry[i])) i++;
    const quote = entry[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") break;
    i++;
    for (; i < entry.length; i++) {
      if (entry[i] === "\\") {
        value += entry[i + 1];
        i++;
      } else if (entry[i] === quote) break;
      else value += entry[i];
    }
    i++;
    // Only continue when the next non-space char starts another string part.
    let j = i;
    while (j < entry.length && /\s/.test(entry[j])) j++;
    if (entry[j] === '"' || entry[j] === "'" || entry[j] === "`") i = j;
    else break;
  }
  return value;
}

/** Render the `action` field of an entry as a compact, readable phrase. */
export function readAction(entry) {
  const m = /(^|[\s{,])action\s*:\s*/m.exec(entry);
  if (!m) return null;
  const rest = entry.slice(m.index + m[0].length).trimStart();
  if (rest[0] !== "{") {
    const literal = readStringField(entry, "action");
    return literal ?? null;
  }
  const obj = extractBalanced(rest);
  const type = readStringField(obj, "type");
  const tileType = readStringField(obj, "tileType");
  const direction = readStringField(obj, "direction");
  const parts = [type];
  if (tileType) parts.push(`(${tileType})`);
  if (direction) parts.push(`(${direction})`);
  const extra = /extraConfig\s*:\s*\{([^}]*)\}/.exec(obj);
  if (extra) parts.push(`[${extra[1].trim().replace(/["']/g, "").replace(/,$/, "")}]`);
  return parts.filter(Boolean).join(" ");
}

function extractBalanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return text;
}

export function parseAppBindings(src) {
  const literal = extractArrayLiteral(src, "APP_KEY_BINDINGS");
  if (!literal) return [];
  return splitObjectEntries(literal).map((entry) => ({
    combo: readStringField(entry, "combo"),
    description: readStringField(entry, "description"),
    action: readAction(entry),
    featureFlag: readStringField(entry, "featureFlag"),
  }));
}

export function parseWalkthroughBindings(src) {
  const literal = extractArrayLiteral(src, "WALKTHROUGH_KEY_BINDINGS");
  if (!literal) return [];
  return splitObjectEntries(literal).map((entry) => ({
    combo: readStringField(entry, "combo"),
    description: readStringField(entry, "description"),
    action: readAction(entry),
  }));
}

export function parseExternalBindings(src) {
  const literal = extractArrayLiteral(src, "EXTERNAL_KEY_BINDINGS");
  if (!literal) return [];
  return splitObjectEntries(literal).map((entry) => ({
    combo: readStringField(entry, "combo"),
    macCombo: readStringField(entry, "macCombo"),
    description: readStringField(entry, "description"),
    surface: readStringField(entry, "surface"),
  }));
}

const cell = (value) => (value ? String(value).replace(/\|/g, "\\|") : "—");

/** The generated body placed between the sentinel markers. */
export function renderKeymaps({ app, walkthrough, external }) {
  const out = [];
  out.push("## Application shortcuts");
  out.push("");
  out.push(
    "Dispatched by `parseKeyAction` in `src/domain/keyboard.ts`. On macOS the `Alt+`",
    "combos are typed with Option.",
  );
  out.push("");
  out.push("| Keys | Description | Action |");
  out.push("| --- | --- | --- |");
  for (const b of app) {
    const flag = b.featureFlag ? ` _(feature-flagged: \`${b.featureFlag}\`)_` : "";
    out.push(`| \`${b.combo}\` | ${cell(b.description)}${flag} | \`${cell(b.action)}\` |`);
  }
  out.push("");
  out.push("## Walkthrough navigation");
  out.push("");
  out.push(
    "Unmodified keys, active only while a debug walkthrough tile has focus.",
  );
  out.push("");
  out.push("| Keys | Description | Action |");
  out.push("| --- | --- | --- |");
  for (const b of walkthrough) {
    out.push(`| \`${b.combo}\` | ${cell(b.description)} | \`${cell(b.action)}\` |`);
  }
  out.push("");
  out.push("## Externally-owned shortcuts");
  out.push("");
  out.push(
    "Documented for the reader but implemented by another surface — Monaco, a",
    "tile's own handler, or the OS — so they never reach `parseKeyAction`.",
  );
  out.push("");
  out.push("| Keys | macOS | Description | Owning surface |");
  out.push("| --- | --- | --- | --- |");
  for (const b of external) {
    out.push(
      `| \`${b.combo}\` | ${b.macCombo ? `\`${b.macCombo}\`` : "—"} | ${cell(b.description)} | ${cell(b.surface)} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

const HEADER = `<!--
  AUTO-GENERATED — do not edit by hand.
  Sources of truth: src/domain/keyboard.ts, src/domain/walkthrough-keys.ts,
  src/domain/external-keys.ts
  Regenerate: node scripts/gen-keymaps.mjs
-->

# Keyboard shortcuts

Every keyboard shortcut the app documents, generated from the binding
registries. Edit the registries, not this file.

`;

/**
 * Splice the generated body into `existing` between the sentinel markers,
 * preserving any hand-written prose outside them. When there are no markers
 * yet (or no file), a fresh document is produced.
 */
export function applyMarkers(existing, body) {
  const block = `${BEGIN_MARKER}\n\n${body}\n${END_MARKER}`;
  if (existing) {
    const start = existing.indexOf(BEGIN_MARKER);
    const end = existing.indexOf(END_MARKER);
    if (start !== -1 && end !== -1 && end > start) {
      return existing.slice(0, start) + block + existing.slice(end + END_MARKER.length);
    }
  }
  return `${HEADER}${block}\n`;
}

export function generate({ keyboardSrc, walkthroughSrc, externalSrc, existing }) {
  const app = parseAppBindings(keyboardSrc);
  const walkthrough = parseWalkthroughBindings(walkthroughSrc);
  const external = parseExternalBindings(externalSrc);
  if (app.length === 0 || walkthrough.length === 0 || external.length === 0) {
    throw new Error("gen-keymaps: parsed an empty registry — parser or source changed?");
  }
  return applyMarkers(existing, renderKeymaps({ app, walkthrough, external }));
}

function main() {
  const check = process.argv.includes("--check");
  for (const file of [KEYBOARD_TS, WALKTHROUGH_TS, EXTERNAL_TS]) {
    if (!existsSync(file)) {
      console.error(`gen-keymaps: cannot find ${file}`);
      process.exit(2);
    }
  }
  const existing = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;
  let content;
  try {
    content = generate({
      keyboardSrc: readFileSync(KEYBOARD_TS, "utf8"),
      walkthroughSrc: readFileSync(WALKTHROUGH_TS, "utf8"),
      externalSrc: readFileSync(EXTERNAL_TS, "utf8"),
      existing,
    });
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(2);
  }
  const normalize = (s) => s.replace(/\r\n/g, "\n");
  if (check) {
    if (existing === null || normalize(existing) !== normalize(content)) {
      console.error(
        "gen-keymaps: docs/keymaps.md is stale. Run `node scripts/gen-keymaps.mjs` and stage it.",
      );
      process.exit(1);
    }
    console.log("gen-keymaps: docs/keymaps.md is up to date.");
    return;
  }
  writeFileSync(OUT, content);
  console.log(`gen-keymaps: wrote ${OUT}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
