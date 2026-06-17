/**
 * Re-sync a Copilot session tile's display name with the (possibly
 * renamed) summary from the Copilot session store.
 *
 * A Copilot session can be renamed after it's first linked to a tile, but
 * the tile's stored `session_name` was only captured at link time. When a
 * workstream is re-opened we re-read the session's current summary and, if
 * it changed, update the tile so the status label (and auto-derived title)
 * stay in sync.
 *
 * Manual title renames are preserved: the title is only updated when it
 * still matches the previously-synced session name (i.e. it was never
 * customized by the user).
 */

export interface SessionNameSyncResult {
  /** New config_json to persist (already JSON-stringified). */
  configJson: string;
  /** New title to persist, or undefined to leave the title unchanged. */
  title: string | undefined;
  /** Display label for the sidebar (sessionInfoByWs). */
  label: string;
}

/**
 * Compute the config/title update needed to bring a linked Copilot session
 * tile's name in line with `currentSummary`. Returns `null` when no update
 * is needed (not a linked session, missing/blank summary, or already in
 * sync), so callers can skip the write entirely.
 */
export function computeSessionNameSync(
  configJson: string | null | undefined,
  title: string | null | undefined,
  currentSummary: string | null | undefined,
): SessionNameSyncResult | null {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(configJson || "{}");
  } catch {
    return null;
  }
  if (typeof cfg !== "object" || cfg === null) return null;

  const linkedId = (cfg.copilot_session_id || cfg.resume_by_id) as string | undefined;
  if (!linkedId) return null;

  const summary = (currentSummary ?? "").trim();
  if (!summary) return null;

  const oldName = (typeof cfg.session_name === "string" ? cfg.session_name : "") || "";
  const oldSummary = (typeof cfg.session_summary === "string" ? cfg.session_summary : "") || "";

  // Already in sync — nothing to persist.
  if (summary === oldName && summary === oldSummary) return null;

  const nextCfg = { ...cfg, session_name: summary, session_summary: summary };

  // Preserve a manually-customized title; only auto-update when the title
  // was empty or still equals the previously-derived session name.
  const currentTitle = (title ?? "").trim();
  const titleWasAutoDerived = currentTitle === "" || currentTitle === oldName;
  const nextTitle = titleWasAutoDerived ? summary : undefined;

  return {
    configJson: JSON.stringify(nextCfg),
    title: nextTitle,
    label: summary,
  };
}
