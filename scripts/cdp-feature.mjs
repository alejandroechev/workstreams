// CDP feature runner.
//
// Usage:
//   node scripts/cdp-feature.mjs <feature-id> [--cold] [--no-seed] [--todo-id <id>]
//
// Behavior:
//   - Reuses a running cargo tauri dev on CDP :9222 unless --cold.
//   - Seeds the dev DB / showcase folder unless --no-seed.
//   - Imports e2e/features/<feature-id>.mjs if present; else e2e/features/_generic.mjs.
//   - Captures console + page errors throughout the protocol run.
//   - Saves a screenshot under screenshots/<feature-id>/.
//   - Inserts a row into the dev DB's visual_proofs table when the run is clean.
//   - Exits non-zero if any errors were captured.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  isCdpAlive,
  waitForCdp,
  connect,
  captureErrors,
  makeApi,
  CDP_PORT,
} from "./cdp-utils.mjs";
import { ensureShowcaseFiles, seedDb } from "./dev-seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEV_DIR = path.join(REPO_ROOT, ".dev");
const DEV_DB = path.join(DEV_DIR, "workstreams-dev.db");
const SCREENSHOTS_DIR = path.join(REPO_ROOT, "screenshots");

function parseArgs(argv) {
  // Default: always cold-spawn an isolated dev instance, so we never accidentally
  // operate against a running prod app. Pass --reuse to attach to a live CDP.
  const out = { cold: true, seed: true, featureId: null, todoId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cold") out.cold = true;
    else if (a === "--reuse") out.cold = false;
    else if (a === "--no-seed") out.seed = false;
    else if (a === "--todo-id") out.todoId = argv[++i];
    else if (!out.featureId) out.featureId = a;
  }
  return out;
}

async function ensureDevTauri({ cold }) {
  if (!cold && (await isCdpAlive())) {
    console.log(`[cdp] CDP :${CDP_PORT} is alive — reusing existing instance`);
    console.log(`[cdp] NOTE: if this is your prod app, the runner will operate against the prod DB.`);
    console.log(`[cdp]       Close the prod app and rerun with --cold to start an isolated dev session.`);
    return { spawned: null };
  }
  if (cold && (await isCdpAlive())) {
    throw new Error(
      `Cannot cold-spawn: CDP :${CDP_PORT} already in use. Close the prod/dev app first, or pass --reuse to attach to it (only do this if you're sure it's a dev instance).`,
    );
  }
  console.log(`[cdp] starting cargo tauri dev with WORKSTREAMS_DB_PATH=${DEV_DB} (first build can take ~5 min)...`);
  fs.mkdirSync(DEV_DIR, { recursive: true });
  // Isolate the WebView2 user-data-folder from prod. Prod and dev share the
  // same Tauri identifier, so by default they'd share the WebView2 environment
  // — and a prod instance started without CDP would prevent dev from exposing
  // it on the shared browser process.
  const wv2DataDir = path.join(DEV_DIR, "webview2-userdata");
  fs.mkdirSync(wv2DataDir, { recursive: true });
  const env = {
    ...process.env,
    WORKSTREAMS_DB_PATH: DEV_DB,
    WEBVIEW2_USER_DATA_FOLDER: wv2DataDir,
  };
  const child = spawn("cargo", ["tauri", "dev"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
    shell: true,
  });
  child.on("exit", (code) => {
    console.log(`[cdp] cargo tauri dev exited with ${code}`);
  });
  await waitForCdp({ timeoutMs: 480_000, intervalMs: 2000 });
  console.log(`[cdp] dev instance is ready on :${CDP_PORT}`);
  return { spawned: child };
}

function runSeeder() {
  console.log("[cdp] seeding dev DB + showcase folder...");
  try {
    ensureShowcaseFiles();
    seedDb();
  } catch (err) {
    console.warn(`[cdp] seeder warning: ${err.message}`);
  }
}

async function importProtocol(featureId) {
  const specific = path.join(REPO_ROOT, "e2e", "features", `${featureId}.mjs`);
  const generic = path.join(REPO_ROOT, "e2e", "features", "_generic.mjs");
  const target = fs.existsSync(specific) ? specific : generic;
  console.log(`[cdp] using protocol: ${path.relative(REPO_ROOT, target)}`);
  const mod = await import(pathToFileURL(target).href);
  if (typeof mod.run !== "function") {
    throw new Error(`Protocol ${target} does not export run({page, screenshot})`);
  }
  return mod.run;
}

function recordProof({ todoId, featureId, screenshotPath, consoleErrors }) {
  if (!todoId) return;
  if (!fs.existsSync(DEV_DB)) {
    console.warn(`[cdp] cannot record proof: dev DB missing at ${DEV_DB}`);
    return;
  }
  try {
    const db = new Database(DEV_DB);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO visual_proofs
         (todo_id, feature_id, screenshot_path, console_error_count, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(todoId, featureId, screenshotPath, consoleErrors, new Date().toISOString());
      console.log(`[cdp] recorded visual_proofs row for todo=${todoId}`);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[cdp] failed to record visual_proofs row: ${err.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.featureId) {
    console.error("usage: cdp-feature.mjs <feature-id> [--cold] [--no-seed] [--todo-id <id>]");
    process.exit(2);
  }

  let spawned = null;
  try {
    const r = await ensureDevTauri({ cold: args.cold });
    spawned = r.spawned;

    if (args.seed) runSeeder();

    const { browser, page } = await connect();
    const errors = captureErrors(page);
    const api = makeApi({
      page,
      featureId: args.featureId,
      screenshotsDir: SCREENSHOTS_DIR,
    });

    const runProtocol = await importProtocol(args.featureId);
    await runProtocol(api);

    // brief settle to let async errors land
    await page.waitForTimeout(500);
    await browser.close();

    const consoleErrors = errors.filter((e) => e.kind === "console").length;
    const pageErrors = errors.filter((e) => e.kind === "pageerror").length;
    const last = api.getLastScreenshotPath();

    console.log("");
    console.log(`Feature: ${args.featureId}`);
    console.log(`Screenshot: ${last ?? "(none)"}`);
    console.log(`Console errors: ${consoleErrors}`);
    console.log(`Page errors: ${pageErrors}`);
    if (errors.length) {
      console.log("Error details:");
      for (const e of errors) console.log(`  [${e.kind}] ${e.text}`);
    }

    if (last && errors.length === 0) {
      recordProof({
        todoId: args.todoId,
        featureId: args.featureId,
        screenshotPath: last,
        consoleErrors,
      });
      console.log("\nResult: ✅ PASS");
      process.exit(0);
    } else {
      console.log("\nResult: ❌ FAIL");
      process.exit(1);
    }
  } finally {
    if (spawned) {
      console.log("[cdp] terminating spawned dev instance...");
      try {
        spawned.kill();
      } catch {
        // ignore
      }
    }
  }
}

main().catch((err) => {
  console.error("[cdp] fatal:", err);
  process.exit(1);
});
