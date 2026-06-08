import { useEffect, useRef } from "react";
import { debounce } from "./debounce";
import { mergeViewState, type AnyViewState } from "./tile-view-state";

/**
 * Debounced writer that pushes a tile's view-state back into its
 * `tiles.config_json` blob via the supplied `onConfigChange` callback.
 *
 * Mount-all-workstreams means many tiles call this hook simultaneously;
 * the 500 ms debounce coalesces bursts (e.g. tab clicks, fast file
 * navigation) into a single setState + IPC round-trip per quiet window.
 *
 * `enabled` lets the caller skip writes during the hydration cycle so
 * we don't immediately persist the same values we just read.
 */
export function useTileViewStatePersist<K extends AnyViewState["kind"]>(
  configJson: string | null | undefined,
  kind: K,
  viewState: Extract<AnyViewState, { kind: K }>["state"],
  onConfigChange: ((nextConfigJson: string) => void) | undefined,
  options: { enabled?: boolean; debounceMs?: number } = {},
): void {
  const { enabled = true, debounceMs = 500 } = options;
  // Keep refs to the latest values so the debounced fn always uses the
  // freshest config (avoids stale closure when configJson updates mid-burst).
  const configRef = useRef(configJson);
  const onChangeRef = useRef(onConfigChange);
  useEffect(() => {
    configRef.current = configJson;
    onChangeRef.current = onConfigChange;
  }, [configJson, onConfigChange]);

  const writerRef = useRef(
    debounce((vs: Extract<AnyViewState, { kind: K }>["state"]) => {
      const onChange = onChangeRef.current;
      if (!onChange) return;
      const next = mergeViewState(configRef.current ?? null, kind, vs);
      // Skip if no change vs. current config_json — avoid spurious writes.
      if (next === configRef.current) return;
      onChange(next);
    }, debounceMs),
  );

  useEffect(() => {
    if (!enabled) return;
    writerRef.current(viewState);
  }, [enabled, viewState]);

  useEffect(() => {
    const w = writerRef.current;
    return () => w.cancel();
  }, []);
}
