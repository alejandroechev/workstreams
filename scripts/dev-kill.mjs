// dev-kill.mjs — safely terminate ONLY the dev tauri instance spawned by
// cdp-feature.mjs (recorded in .dev/dev.pids). Never matches by name so
// it cannot accidentally kill the user's running production app, which
// shares the workstreams.exe binary name.
//
// Strategy on Windows:
//   - Read root PID from .dev/dev.pids
//   - Verify the process is alive AND its CDP port is 9223 (sanity check
//     so we don't kill something else that happened to reuse the PID)
//   - Use taskkill /T /PID <root> /F to terminate the whole tree

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCdpAlive, CDP_PORT } from "./cdp-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PID_FILE = path.join(REPO_ROOT, ".dev", "dev.pids");

async function main() {
  if (!fs.existsSync(PID_FILE)) {
    console.log("[dev-kill] no .dev/dev.pids — nothing to do.");
    return;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.log("[dev-kill] dev.pids did not contain a valid PID — refusing to act.");
    return;
  }
  const cdpUp = await isCdpAlive();
  if (!cdpUp) {
    console.log(`[dev-kill] CDP :${CDP_PORT} is NOT alive — assuming dev is already stopped. Removing stale pid file.`);
    fs.rmSync(PID_FILE, { force: true });
    return;
  }
  console.log(`[dev-kill] terminating dev tree rooted at PID ${pid}…`);
  if (process.platform === "win32") {
    const res = spawnSync("taskkill", ["/T", "/PID", String(pid), "/F"], { stdio: "inherit" });
    if (res.status !== 0) {
      console.warn(`[dev-kill] taskkill exited with ${res.status}`);
    }
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { /* ignore */ }
  }
  fs.rmSync(PID_FILE, { force: true });
  console.log("[dev-kill] done.");
}

main().catch((err) => {
  console.error("[dev-kill] error:", err);
  process.exit(1);
});
