#!/usr/bin/env node
// Phone companion CLI (ADR 033) — CLI parity for the laptop side.
//
// Runs the real protocol and runtime modules from src/companion (bundled on
// the fly with esbuild), so what it prints is what the app would do.
//
// Usage:
//   node scripts/companion-cli.mjs sign     --secret <s> --request '<json>'
//   node scripts/companion-cli.mjs check    --secret <s> --request '<json>' [--now <ms>]
//   node scripts/companion-cli.mjs pairing  --doc <automerge:url> --secret <s>
//   node scripts/companion-cli.mjs scenario
//
//   sign      HMAC signature the paired phone would attach to a request
//   check     whether the laptop would execute a request now, and why not
//   pairing   the payload the Settings QR code carries
//   messages  a phone session asking for its result: the laptop records it,
//             its agent sends progress and a result, another session and a
//             bad kind are refused, and the published sessions are printed
//   scenario  a laptop run against an in-memory document: signed, unsigned,
//             stale and replayed requests, a create with a prompt, a session;
//             prints each request's outcome and what the app was asked to do

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: node scripts/companion-cli.mjs <sign|check|pairing|scenario|messages> [options]
  sign      --secret <s> --request '<json>'
  check     --secret <s> --request '<json>' [--now <ms>]
  pairing   --doc <automerge:url> --secret <s>
  scenario
  messages`;

async function loadCompanion() {
  const result = await build({
    stdin: {
      contents: [
        'export * from "./src/companion/protocol";',
        'export { createInMemoryHub } from "./src/companion/doc";',
        'export { startCompanionRuntime } from "./src/companion/runtime";',
        'export { createUniqueFolder } from "./src/companion/folders";',
        'export { buildSessions, publishSessions } from "./src/companion/publisher";',
      ].join("\n"),
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

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function required(args, name) {
  const value = option(args, name);
  if (value === undefined) fail(`Missing --${name}`);
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

async function scenario(companion) {
  const { createInMemoryHub, startCompanionRuntime, signRequest, createUniqueFolder } = companion;
  const secret = "dGVzdC1zZWNyZXQtZm9yLWNvbXBhbmlvbi1maXh0dXI";
  const NOW = 1_790_000_000_000;
  const hub = createInMemoryHub();
  const laptop = hub.peer();
  const phone = hub.peer();

  const appActions = [];
  const world = {
    workstreams: [
      { id: "alpha", name: "Alpha", archived: false, loaded: true, copilotCommand: "copilot --yolo" },
      { id: "beta", name: "Beta", archived: false, loaded: false, copilotCommand: "copilot --yolo" },
    ],
    globalCopilotCommand: "agency copilot --yolo",
  };
  const folders = new Set();
  let created = 0;
  const ops = {
    world: () => world,
    async loadInBackground(id) {
      appActions.push(`load ${id}`);
      const w = world.workstreams.find((x) => x.id === id);
      if (w) w.loaded = true;
    },
    async createWorkstream(name, slug) {
      const directory = await createUniqueFolder("/phone", slug, async (p) => {
        if (folders.has(p)) throw new Error(`A file or folder already exists at ${p}`);
        folders.add(p);
      });
      const id = `created-${++created}`;
      appActions.push(`create ${JSON.stringify(name)} in ${directory}`);
      world.workstreams.push({ id, name, archived: false, loaded: false, copilotCommand: world.globalCopilotCommand });
      return id;
    },
    async startSession(id, command, prompt) {
      appActions.push(`session ${id}: ${command} -i ${JSON.stringify(prompt)}`);
    },
  };

  const send = async (request, { sign = true } = {}) => {
    const signature = sign ? await signRequest(secret, request) : "";
    phone.change((d) => { d.requests[request.id] = { ...request, signature }; });
    return signature;
  };
  const at = (offset) => NOW - 60_000 + offset;

  const loadBeta = { id: "load-beta", kind: "load", args: { workstreamId: "beta" }, createdAt: at(1) };
  const loadSignature = await send(loadBeta);
  await send({ id: "unsigned-create", kind: "create", args: { name: "Unsigned" }, createdAt: at(2) }, { sign: false });
  await send({ id: "stale-create", kind: "create", args: { name: "Stale" }, createdAt: NOW - 10 * 60_000 });
  await send({ id: "create-with-prompt", kind: "create", args: { name: "Fix the docs", prompt: "List the files here" }, createdAt: at(4) });
  await send({ id: "session-alpha", kind: "session", args: { workstreamId: "alpha", prompt: "Review the diff" }, createdAt: at(5) });
  // A captured request replayed under a new id: the id is signed, so it fails.
  phone.change((d) => { d.requests["replayed-load-beta"] = { ...loadBeta, id: "replayed-load-beta", createdAt: at(6), signature: loadSignature }; });

  const runtime = startCompanionRuntime({ doc: laptop, secret, ops, now: () => NOW });
  await runtime.idle();
  runtime.stop();

  const requests = laptop.read().requests;
  const outcomes = Object.fromEntries(Object.keys(requests).sort((a, b) => requests[a].createdAt - requests[b].createdAt || a.localeCompare(b)).map((id) => [id, requests[id].outcome?.status ?? "pending"]));
  const errors = Object.fromEntries(Object.entries(requests).filter(([, r]) => r.outcome?.error).map(([id, r]) => [id, r.outcome.error]));
  return { outcomes, errors, appActions };
}

async function messages(companion) {
  const { createInMemoryHub, startCompanionRuntime, signRequest, withResultRequest, checkMessage, buildSessions, publishSessions } = companion;
  const secret = "dGVzdC1zZWNyZXQtZm9yLWNvbXBhbmlvbi1maXh0dXI";
  const NOW = 1_790_000_000_000;
  const hub = createInMemoryHub();
  const laptop = hub.peer();
  const phone = hub.peer();

  // The laptop's SQLite records, as companion_messages.rs keeps them.
  const store = new Map();
  const world = {
    workstreams: [{ id: "alpha", name: "Alpha", archived: false, loaded: true, copilotCommand: "copilot --yolo" }],
    globalCopilotCommand: "copilot --yolo",
  };
  let tiles = 0;
  let prompt = "";
  const ops = {
    world: () => world,
    async loadInBackground() {},
    async createWorkstream() { throw new Error("not used"); },
    async startSession(workstreamId, _command, sentPrompt, guard, requestId) {
      guard();
      prompt = sentPrompt;
      const tileId = `tile-${++tiles}`;
      store.set(tileId, { tileId, workstreamId, requestId, prompt: sentPrompt, createdAt: NOW, messages: [] });
    },
  };
  // What `workstreams agent call companion.send` does for a tile.
  const sends = [];
  const send = (from, kind, text) => {
    const check = checkMessage(kind, text);
    const session = store.get(from);
    const error = !session ? "This session was not started from your phone." : check.ok ? undefined : check.error;
    if (!error) session.messages.push({ id: `m${session.messages.length + 1}`, kind, text, at: NOW + session.messages.length + 1 });
    sends.push(error ? { from, kind, ok: false, error } : { from, kind, ok: true });
  };

  const request = { id: "ask", kind: "session", args: { workstreamId: "alpha", prompt: withResultRequest("Count the files", true) }, createdAt: NOW - 1000 };
  phone.change((d) => { d.requests.ask = { ...request, signature: "" }; });
  const signature = await signRequest(secret, request);
  phone.change((d) => { d.requests.ask.signature = signature; });
  const runtime = startCompanionRuntime({ doc: laptop, secret, ops, now: () => NOW });
  await runtime.idle();
  runtime.stop();

  send("tile-1", "progress", "Counting…");
  send("tile-1", "result", "# 3 files");
  send("laptop-tile", "result", "not mine to send");
  send("tile-1", "question", "?");

  publishSessions(laptop, buildSessions([...store.values()], new Map([["alpha", "Alpha"]])));
  return {
    prompt,
    recorded: [...store.values()].map(({ tileId, workstreamId, requestId }) => ({ tileId, workstreamId, requestId })),
    sends,
    published: phone.read().sessions,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["sign", "check", "pairing", "scenario", "messages"].includes(command)) fail(command ? `Unknown command: ${command}` : "No command given");
  const companion = await loadCompanion();

  if (command === "sign") {
    const request = JSON.parse(required(args, "request"));
    process.stdout.write(`${await companion.signRequest(required(args, "secret"), request)}\n`);
  } else if (command === "check") {
    const request = JSON.parse(required(args, "request"));
    const now = Number(option(args, "now") ?? Date.now());
    process.stdout.write(`${JSON.stringify(await companion.checkRequest(request, { secret: required(args, "secret"), now }))}\n`);
  } else if (command === "pairing") {
    process.stdout.write(`${companion.encodePairing({ doc: required(args, "doc"), secret: required(args, "secret") })}\n`);
  } else if (command === "messages") {
    process.stdout.write(`${JSON.stringify(await messages(companion), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(await scenario(companion), null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
