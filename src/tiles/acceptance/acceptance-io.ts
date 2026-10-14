import { invoke } from "@tauri-apps/api/core";
import { tauriGrillIo, type GrillIo } from "../grill/grill-io";
import type { ValidationRound } from "../../domain/acceptance/view";

/** File access for acceptance Review mode: the grill's, plus directory listing for validation rounds. */
export interface AcceptanceIo extends GrillIo {
  listDir(path: string): Promise<string[]>;
  /** Names with modified times, to notice a frame redrawn in place. */
  listEntries(path: string): Promise<Array<{ name: string; modified: string; size: number }>>;
}

export const tauriAcceptanceIo: AcceptanceIo = {
  ...tauriGrillIo,
  async listDir(path) {
    const entries = await invoke<Array<{ name: string }>>("list_directory", { path });
    return entries.map((entry) => entry.name);
  },
  async listEntries(path) {
    const entries = await invoke<Array<{ name: string; modified_epoch: number; modified_ns?: string; size: number }>>("list_directory", { path });
    return entries.map((entry) => ({ name: entry.name, modified: entry.modified_ns ?? String(entry.modified_epoch), size: entry.size }));
  },
};

/** A fingerprint of a test's storyboard folder that changes when any frame is rewritten. */
export async function assetRevision(io: AcceptanceIo, featureDir: string, testId: string): Promise<string> {
  try {
    const entries = await io.listEntries(`${featureDir}/acceptance-assets/${testId}`);
    return entries.map((e) => `${e.name}:${e.modified}:${e.size}`).sort().join("|");
  } catch {
    return "";
  }
}

/** The rounds under `<feature>/validation/` (`r1`, `r2`, …) and the files each saved. */
export async function validationRounds(io: AcceptanceIo, featureDir: string): Promise<ValidationRound[]> {
  let names: string[];
  try {
    names = await io.listDir(`${featureDir}/validation`);
  } catch {
    return [];
  }
  const rounds = names
    .map((name) => /^r(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
  return Promise.all(rounds.map(async (round) => {
    try {
      return { round, files: await io.listDir(`${featureDir}/validation/r${round}`) };
    } catch {
      return { round, files: [] };
    }
  }));
}
