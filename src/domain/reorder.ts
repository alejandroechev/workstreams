/**
 * Reorder helpers — pure, host-agnostic. Used by the workstream sidebar
 * drag-and-drop and any future list reorder UI.
 */

/**
 * Move an item from `fromIndex` to `toIndex` in a copy of `list`.
 * Returns the original reference unchanged if the move is a no-op.
 */
export function moveItem<T>(list: ReadonlyArray<T>, fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return list as T[];
  if (fromIndex < 0 || fromIndex >= list.length) return list as T[];
  if (toIndex < 0) toIndex = 0;
  if (toIndex >= list.length) toIndex = list.length - 1;
  const next = list.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Reorder a list of items by id. `draggedId` is the item being moved.
 * `targetId` is the id of the row it is being dropped on. The dragged
 * item ends up at the index `targetId` currently occupies (i.e. the
 * dragged row pushes the target row down/up).
 *
 * Returns the original reference unchanged if either id is missing or
 * the move is a no-op.
 */
export function reorderById<T extends { id: string }>(
  list: ReadonlyArray<T>,
  draggedId: string,
  targetId: string,
): T[] {
  if (draggedId === targetId) return list as T[];
  const from = list.findIndex((x) => x.id === draggedId);
  const to = list.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0) return list as T[];
  return moveItem(list, from, to);
}
