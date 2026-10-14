import { invoke } from "@tauri-apps/api/core";
import { tauriGrillIo, type GrillIo } from "../grill/grill-io";
import type { ValidationRound } from "../../domain/acceptance/view";

/** File access for acceptance Review mode: the grill's, plus directory listing for validation rounds. */
export interface AcceptanceIo extends GrillIo {
  listDir(path: string): Promise<string[]>;
}

export const tauriAcceptanceIo: AcceptanceIo = {
  ...tauriGrillIo,
  async listDir(path) {
    const entries = await invoke<Array<{ name: string }>>("list_directory", { path });
    return entries.map((entry) => entry.name);
  },
};

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
