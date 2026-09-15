/**
 * Which workstreams come back "loaded" when the app starts.
 *
 * "Loaded" used to be purely runtime state -- a key in App's `wsStates` map --
 * so every launch began with an empty desk and the workstreams representing
 * in-progress work had to be found and reopened by hand. The flag is now
 * persisted per workstream, and this module decides what to do with it.
 *
 * The distinction that matters: **restoring the set is not restoring the
 * tiles.** A restored workstream is marked loaded in the sidebar and mounts
 * its tiles on first visit, exactly as a freshly opened one does. Mounting
 * everything up front would spawn every terminal and Copilot session in the
 * set at once, which is not what "leave my desk as I left it" should cost.
 */
import type { Workstream } from "./types";

/**
 * Statuses that cannot be restored, whatever the flag says.
 *
 * `archived` is the point: archiving is how you put something away, and a
 * workstream that reappears loaded on next launch has not been put away. The
 * flag can legitimately still be set -- archiving a loaded workstream is
 * normal -- so this is a filter, not an invariant anyone violated.
 *
 * The provisioning states are excluded for a different reason: they describe a
 * workstream mid-creation or mid-deletion, whose directory may not exist yet
 * or any more. Restoring one would mount tiles against a path in flux.
 */
const NOT_RESTORABLE = new Set(["archived", "archiving", "creating", "create_failed"]);

/**
 * The set of workstream ids to mark loaded at startup.
 *
 * Reads the flag off the workstream rows themselves, so it cannot name a
 * workstream that no longer exists -- a deleted row takes its flag with it.
 */
export function restorableLoadedIds(workstreams: readonly Workstream[]): Set<string> {
  const out = new Set<string>();
  for (const ws of workstreams) {
    if (!ws.is_loaded) continue;
    if (NOT_RESTORABLE.has(ws.status)) continue;
    out.add(ws.id);
  }
  return out;
}

/**
 * What the sidebar should show as loaded: everything restored from the last
 * session, plus everything mounted since.
 *
 * The union is the whole point of the split. `mounted` is the set with live
 * tiles; `restored` is the set the user left open. A restored workstream that
 * has not been visited yet appears in the first but not the second, and it
 * must still read as loaded -- otherwise persisting the set would be
 * invisible until you clicked each one.
 */
export function visiblyLoadedIds(
  restored: ReadonlySet<string>,
  mounted: Iterable<string>,
): Set<string> {
  const out = new Set(restored);
  for (const id of mounted) out.add(id);
  return out;
}
