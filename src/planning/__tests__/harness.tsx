import { render, screen } from "@testing-library/react";
import { MemoryBackend } from "../../backend/memory-backend";
import { PlanningView } from "../PlanningView";
import { usePlanning } from "../usePlanning";
import { ITERATIONS, TEAM_LINK } from "./fixtures";
import type { PlanItem } from "../../domain/planning";

/** Inside sprint S22 of the fixtures. */
export const NOW = new Date("2026-10-30T12:00:00Z");

function Harness({ backend }: { backend: MemoryBackend }) {
  const planning = usePlanning(backend, true);
  return <PlanningView planning={planning} onClose={() => {}} now={() => NOW} />;
}

/** Renders Planning over an in-memory ADO team holding `items`. */
export async function open(items: PlanItem[], options: { connect?: boolean; sprint?: string } = {}) {
  const backend = new MemoryBackend();
  backend.seedPlanningAdo({ iterations: ITERATIONS, items });
  if (options.connect !== false) await backend.planningConnect(TEAM_LINK);
  if (options.sprint) await backend.planningSelectSprint(options.sprint);
  render(<Harness backend={backend} />);
  if (options.connect !== false) await screen.findByTestId("planning-sprint-select");
  return backend;
}
