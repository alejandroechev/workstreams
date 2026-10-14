// Acceptance CLI — CLI parity for the Plan tile's acceptance Review mode (ADR 037).
//
// Runs the real parser and writers from src/domain/acceptance (bundled on the
// fly with esbuild), so what it does to a file is what the app would do.
//
// Usage:
//   node scripts/acceptance-cli.mjs parse   <acceptance.md>
//   node scripts/acceptance-cli.mjs mark    <acceptance.md> <AT-n> ok|clear|change <note...>
//   node scripts/acceptance-cli.mjs missing <acceptance.md> <note...>
//   node scripts/acceptance-cli.mjs request <acceptance.md> <AT-n> [note...]
//
// Every write is refused once the file's front-matter says status: approved.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAcceptance() {
  const result = await build({
    stdin: {
      contents: 'export * from "./src/domain/acceptance/parse"; export * from "./src/domain/acceptance/write";',
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const USAGE = "Usage: node scripts/acceptance-cli.mjs parse|mark|missing|request <acceptance.md> …";

async function main() {
  const [command, file, ...rest] = process.argv.slice(2);
  if (!["parse", "mark", "missing", "request"].includes(command) || !file) fail(USAGE, 2);
  const acceptance = await loadAcceptance();
  const text = fs.readFileSync(file, "utf8");
  let result;
  if (command === "parse") {
    const parsed = acceptance.parseAcceptance(text);
    const tests = parsed.tests.map(({ lines: _lines, ...test }) => test);
    process.stdout.write(`${JSON.stringify({ status: parsed.status, missing: parsed.missing, tests }, null, 2)}\n`);
    return;
  } else if (command === "mark") {
    const [id, kind, ...note] = rest;
    if (!id || !["ok", "clear", "change"].includes(kind)) fail("mark needs <AT-n> ok|clear|change <note...>", 2);
    const mark = kind === "ok" ? { kind: "ok" } : kind === "change" ? { kind: "change", note: note.join(" ") } : null;
    result = acceptance.setReview(text, id, mark);
  } else if (command === "missing") {
    result = acceptance.addMissing(text, rest.join(" "));
  } else {
    const [id, ...note] = rest;
    if (!id) fail("request needs <AT-n> [note...]", 2);
    result = acceptance.addVisualRequest(text, id, note.join(" "));
  }
  if (!result.ok) fail(result.error);
  fs.writeFileSync(file, result.text);
  process.stdout.write(`${JSON.stringify({ command, written: true })}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
