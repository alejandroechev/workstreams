/**
 * Mute all (ADR 045): silences every Inbox source, until turned off or until
 * a chosen time. Mirrors the native `inbox_mute::MuteState`.
 */
export interface InboxMuteState {
  muted: boolean;
  /** When it ends by itself (ISO 8601), or null: until turned off. */
  until: string | null;
}

/** The id of a digest's run as an investigatable item, as natively (`drun:<digest>:<run>`). */
export function digestRunItemId(digestId: string, runId: number): string {
  return `drun:${digestId}:${runId}`;
}

/** The Inbox's banner while muted, or null when not muted. */
export function muteBannerText(state: InboxMuteState | undefined, format: (at: Date) => string = (at) => at.toLocaleString()): string | null {
  if (!state?.muted) return null;
  const end = state.until ? `until ${format(new Date(state.until))}` : "until you turn it off";
  return `Muted ${end}. New notifications from every source are dropped, not saved for later.`;
}
