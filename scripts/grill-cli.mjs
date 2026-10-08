// Grill CLI — CLI parity for the Plan tile's Answer mode (ADR 034).
//
// Runs the real parser and writers from src/domain/grill (bundled on the fly
// with esbuild), so what it does to a file is what the app would do.
//
// Usage:
//   node scripts/grill-cli.mjs parse  <grill-me.md>
//   node scripts/grill-cli.mjs answer <grill-me.md> <question-id> <answer...>
//   node scripts/grill-cli.mjs finish <grill-me.md> [--preview]
//
//   parse   rounds and questions as JSON, and which round is open
//   answer  writes the answer into that question of the open round
//   finish  records "reco (default — not reviewed)" for every unanswered
//           question of the open round; refused while a Blocking one is open
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadGrill() {
  const result = await build({
    stdin: {
      contents: 'export * from "./src/domain/grill/parse"; export * from "./src/domain/grill/write";',
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

async function main() {
  const [command, file, ...rest] = process.argv.slice(2);
  if (!["parse", "answer", "finish"].includes(command) || !file) {
    fail("Usage: node scripts/grill-cli.mjs parse|answer|finish <grill-me.md> …", 2);
  }
  const grill = await loadGrill();
  const text = fs.readFileSync(file, "utf8");
  if (command === "parse") {
    const parsed = grill.parseGrill(text);
    const questions = parsed.questions.map(({ lines: _lines, ...q }) => q);
    process.stdout.write(`${JSON.stringify({ rounds: parsed.rounds, editableRound: grill.editableRound(parsed), questions }, null, 2)}\n`);
  } else if (command === "answer") {
    const [id, ...words] = rest;
    if (!id) fail("answer needs a question id", 2);
    const round = grill.editableRound(grill.parseGrill(text));
    const result = grill.setAnswer(text, round, id, words.join(" "));
    if (!result.ok) fail(result.error);
    fs.writeFileSync(file, result.text);
    process.stdout.write(`${JSON.stringify({ round, id, answer: words.join(" ") })}\n`);
  } else {
    const preview = rest.includes("--preview");
    const result = grill.finishRound(text, { preview });
    if (!result.ok) fail(result.error);
    if (!preview) fs.writeFileSync(file, result.text);
    process.stdout.write(`${JSON.stringify({ defaulted: result.defaulted, written: !preview })}\n`);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
