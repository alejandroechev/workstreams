/**
 * Label resolution and dedupe.
 *
 * Labels are free-form by choice, and they now carry three concepts at once:
 * the devlog's `## section`, its category bullets (`🐞Bugs/Fixes`), and its
 * group bullets (`FileComments:`). Flattening that tree into labels is what
 * keeps tasks two levels deep -- but it also means there will be far more
 * labels than the 21 original sections, so drift is a real risk.
 *
 * With no seeded list and no merge tool in v1, normalisation at the moment of
 * creation is the only defence: typing `ai crew` must reuse `AI Crew` rather
 * than minting a second label that silently splits the archive in two.
 *
 * Punctuation is deliberately preserved. Stripping it would fold `Bugs/Fixes`
 * into `Bugs Fixes`, and the slash is meaningful in the real files.
 */
import type { Label } from "./tasks";

/** Case- and whitespace-insensitive identity. Punctuation is significant. */
export const normalizeLabelName = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, " ");

export function findLabel(labels: Label[], name: string): Label | null {
  const key = normalizeLabelName(name);
  if (!key) return null;
  return labels.find((l) => normalizeLabelName(l.name) === key) ?? null;
}

export interface ResolvedLabels {
  labelIds: string[];
  created: Label[];
}

const DEFAULT_COLOR = "#89b4fa";

/**
 * Map typed names onto label ids, minting labels only for genuinely new names.
 *
 * Dedupes against both the existing set and the rest of this call, so pasting
 * a category twice cannot produce two labels. New labels keep the casing the
 * user typed -- only the *matching* is case-insensitive.
 */
export function resolveLabelNames(
  labels: Label[],
  names: string[],
  makeId: () => string = () => globalThis.crypto.randomUUID(),
): ResolvedLabels {
  const created: Label[] = [];
  const labelIds: string[] = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const key = normalizeLabelName(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const existing = findLabel(labels, raw) ?? findLabel(created, raw);
    if (existing) {
      labelIds.push(existing.id);
      continue;
    }

    const label: Label = { id: makeId(), name: raw.trim(), color: DEFAULT_COLOR };
    created.push(label);
    labelIds.push(label.id);
  }

  return { labelIds, created };
}

/**
 * Autocomplete candidates, substring-matched.
 *
 * Prefix matching alone would be too weak now that labels carry group names:
 * typing `Comments` has to surface `FileComments`, or the user creates a
 * duplicate and the dedupe above never gets a chance to fire. Prefix hits
 * still rank first so the exact thing you are typing stays at the top.
 */
export function labelSuggestions(
  labels: Label[],
  query: string,
  opts: { exclude?: string[] } = {},
): Label[] {
  const exclude = new Set(opts.exclude ?? []);
  const available = labels.filter((l) => !exclude.has(l.id));
  const key = normalizeLabelName(query);
  if (!key) return available;

  const scored: Array<{ label: Label; rank: number }> = [];
  for (const label of available) {
    const name = normalizeLabelName(label.name);
    const at = name.indexOf(key);
    if (at === -1) continue;
    scored.push({ label, rank: at === 0 ? 0 : 1 });
  }

  return scored.sort((a, b) => a.rank - b.rank).map((s) => s.label);
}
