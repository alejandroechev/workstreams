import { invoke } from "@tauri-apps/api/core";
import { openAutomergeDoc } from "../companion/automerge-doc";
import { tauriSettingsStore, type SettingsStore } from "../companion/settings";
import { syncServerUrls } from "../companion/sync-server";
import { fromCompanionDoc, type LearningDoc } from "./doc";
import { createLearningRelay, type LedgerJob, type LedgerPort } from "./relay";
import { loadLearningSettings, onLearningSettingsChanged, type LearningSettings } from "./settings";

export type LearningStatus =
  | { state: "off" }
  | { state: "dev-disabled" }
  | { state: "connecting" }
  | { state: "on" }
  | { state: "update-needed" }
  | { state: "error"; error: string };

export function learningStatusText(status: LearningStatus): string {
  switch (status.state) {
    case "on": return "Connected. Rust Pocket's checks run on this Mac.";
    case "off": return "Not paired.";
    case "connecting": return "Connecting to the sync server…";
    case "dev-disabled": return "Not available in development builds, so a dev instance never runs the phone's checks.";
    case "update-needed": return "Rust Pocket uses a newer format. Update Workstreams to keep using it.";
    case "error": return `Not connected: ${status.error}`;
  }
}

let current: LearningStatus = { state: "off" };
const listeners = new Set<(status: LearningStatus) => void>();

function setStatus(status: LearningStatus): void {
  current = status;
  for (const listener of listeners) listener(status);
}

export function getLearningStatus(): LearningStatus {
  return current;
}

export function onLearningStatus(listener: (status: LearningStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The native ledger (`learning_jobs.rs`) through Tauri commands. */
export const tauriLedger: LedgerPort = {
  enqueue: (job) => invoke<LedgerJob>("learning_enqueue", { request: job }),
  get: (id) => invoke<LedgerJob | null>("learning_job", { id }),
};

async function connectAutomerge(settings: LearningSettings): Promise<LearningDoc> {
  const { ws } = syncServerUrls(settings.serverUrl, settings.token || null);
  const { doc } = await openAutomergeDoc({ docUrl: settings.docUrl, wsUrl: ws, storage: true });
  const { ImmutableString } = await import("@automerge/automerge-repo/slim");
  return fromCompanionDoc(doc, ImmutableString);
}

export interface LearningServiceDeps {
  store?: SettingsStore;
  connect?: (settings: LearningSettings) => Promise<LearningDoc>;
  ledger?: LedgerPort;
  /** Development builds never connect, so they never run the phone's checks. */
  devBuild?: boolean;
}

/**
 * Runs the Rust Pocket relay (ADR 042) for as long as the app runs: connects
 * while paired, and reconnects whenever the pairing changes. Returns stop.
 */
export function startLearningService(deps: LearningServiceDeps = {}): () => void {
  const store = deps.store ?? tauriSettingsStore;
  const connect = deps.connect ?? connectAutomerge;
  const ledger = deps.ledger ?? tauriLedger;
  // A dev instance has its own database, so it runs only if paired itself and
  // explicitly allowed (VITE_WS_LEARNING_DEV=1), for validating the relay.
  const devBuild = deps.devBuild ?? (import.meta.env.DEV && import.meta.env.VITE_WS_LEARNING_DEV !== "1");
  let generation = 0;
  let teardown: (() => void) | null = null;

  async function run(settings: LearningSettings): Promise<void> {
    const mine = ++generation;
    teardown?.();
    teardown = null;
    if (!settings.docUrl || !settings.secret) return setStatus({ state: "off" });
    if (devBuild) return setStatus({ state: "dev-disabled" });
    setStatus({ state: "connecting" });
    let doc: LearningDoc;
    try {
      doc = await connect(settings);
    } catch (error) {
      if (mine === generation) setStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (mine !== generation) return doc.close();
    const relay = createLearningRelay({
      doc,
      ledger,
      secret: settings.secret,
      onStatus: (state) => { if (mine === generation) setStatus({ state }); },
      onError: (error) => console.error("[learning] relay pass failed:", error),
    });
    const stopRelay = relay.start();
    teardown = () => { stopRelay(); doc.close(); };
  }

  const off = onLearningSettingsChanged((settings) => void run(settings));
  void loadLearningSettings(store).then(run);
  return () => {
    generation += 1;
    off();
    teardown?.();
    teardown = null;
  };
}
