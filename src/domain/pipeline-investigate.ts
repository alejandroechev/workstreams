/**
 * Investigating a failed pipeline run (ADR 038 amendment). The native side
 * (`src-tauri/src/pipeline_investigate.rs`) is the source of truth; this
 * mirror lets the in-memory backend behave the same in tests and E2E.
 */
import type { PipelineItem } from "./pipeline-inbox";
import type { DigestRun, PipelineDigest } from "./pipeline-digest";

/** What Investigate started: the workstream, and whether it is new. */
export interface InvestigationStarted {
  workstream_id: string;
  created: boolean;
}

/** An investigation whose Copilot session hasn't been started yet. */
export interface PendingInvestigation {
  event_id: string;
  workstream_id: string;
  directory: string;
  prompt: string;
}

export type InvestigationPlacement =
  | { kind: "worktree"; repo: string; branch: string; base: string }
  | { kind: "standalone"; repo: string; failure: string | null };

function slug(text: string): string {
  let out = "";
  for (const raw of text) {
    const c = /[A-Za-z0-9._-]/.test(raw) ? raw : "-";
    if ((c === "-" || c === ".") && out.endsWith(c)) continue;
    out += c;
  }
  return out.replace(/^[-.]+|[-.]+$/g, "");
}

export function investigationName(item: PipelineItem): string {
  return `Investigate ${item.pipeline_name} #${item.run_number}`;
}

export function investigationBranch(item: PipelineItem): string {
  return `investigate/${slug(item.pipeline_name)}-${slug(item.run_number)}`;
}

/** The run's branch on origin, or null for a non-branch ref (PR merge, tag). */
export function investigationBase(item: PipelineItem): string | null {
  const branch = item.branch.trim();
  return branch && !branch.startsWith("refs/") ? `origin/${branch}` : null;
}

export function investigationPrompt(item: PipelineItem, placement: InvestigationPlacement): string {
  const repo = placement.repo || "none linked";
  const location = placement.kind === "worktree"
    ? investigationBase(item)
      ? `You are in a worktree of ${repo} on a new branch ${placement.branch}, created from ${placement.base}: the code that failed.`
      : `You are in a worktree of ${repo} on a new branch ${placement.branch}, created from ${placement.base} (the default branch); the run built ${item.branch}.`
    : placement.failure
      ? `There is no local checkout: creating a worktree of ${repo} failed (${placement.failure.trim()}). Work from Azure DevOps.`
      : "There is no local checkout of this pipeline's repo; work from Azure DevOps.";
  let org = "<organization>";
  try { org = decodeURIComponent(new URL(item.url).pathname.split("/")[1] || org); } catch { /* keep the placeholder */ }
  return `Investigate a failed Azure DevOps pipeline run.

- Pipeline: ${item.pipeline_name} (project ${item.project})
- Run: #${item.run_number} (id ${item.run_id}), result: ${item.result}
- Branch: ${item.branch}
- Trigger: ${item.trigger}
- Finished: ${item.finished_at}
- Repo: ${repo}
- Run: ${item.url}

${location}

Get the run's failing steps and logs yourself with the Azure CLI (az), for example \`az pipelines runs show --id ${item.run_id} --org https://dev.azure.com/${org} --project "${item.project}"\`, then the build timeline and logs through \`az devops invoke --area build\`.

Goal: find the root cause and classify it as code, pipeline, infrastructure or flakiness, and propose a fix. Don't change any code, commit, push or re-run anything until I ask: report your diagnosis first.`;
}

// ── A daily digest, as one batch (ADR 045) ──

/** How an investigation reports back (as ADR 044's notify-in-Inbox instruction). */
export const CONCLUSION_INSTRUCTION =
  "When you are done, use the ws-message skill to send me one message in the Workstreams Inbox with your conclusion: the groups, flaky or broken, and the fixes you propose.";

export function batchBranchName(digest: PipelineDigest): string {
  return `investigate/${slug(digest.pipeline_name)}-failures-${digest.created_at.slice(0, 10).replace(/-/g, "")}`;
}

export function batchWorkstreamName(digest: PipelineDigest): string {
  return `Investigate ${digest.pipeline_name} failures ${digest.created_at.slice(0, 10)}`;
}

function runLines(runs: DigestRun[]): string {
  return runs.map((r) => `- #${r.run_number} (id ${r.run_id}), branch ${r.branch}, commit ${r.commit || "unknown"}, finished ${r.finished_at}${r.step ? `, failing step "${r.step}"` : ""}: ${r.url}`).join("\n");
}

/** What a digest's investigation session is asked first (mirror of pipeline_investigate::batch_prompt). */
export function batchPrompt(digest: PipelineDigest, placement: InvestigationPlacement): string {
  const repo = placement.repo || "none linked";
  const location = placement.kind === "worktree"
    ? `You are in a worktree of ${repo} on a new branch ${placement.branch}, created from ${placement.base} (the default branch's tip); each run's commit is listed above.`
    : placement.failure
      ? `There is no local checkout: creating a worktree of ${repo} failed (${placement.failure.trim()}). Work from Azure DevOps.`
      : "There is no local checkout of this pipeline's repo; work from Azure DevOps.";
  const state = digest.state === "passed_since" ? "the newest run passed since" : "it is still failing";
  return `Investigate the failed runs of an Azure DevOps pipeline, from its daily digest.

- Pipeline: ${digest.pipeline_name} (project ${digest.project})
- ${digest.failed} of ${digest.total} runs failed between ${digest.window_start} and ${digest.window_end}; ${state}.
- Repo: ${repo}

Failed runs:
${runLines(digest.runs)}

${location}

Get each run's failing steps and logs yourself with the Azure CLI (az), for example \`az pipelines runs show --id ${digest.runs[0]?.run_id ?? 0} --org https://dev.azure.com/${digest.organization} --project "${digest.project}"\`, then the build timeline and logs through \`az devops invoke --area build\`.

Goal: Group the runs by root cause. For each group, say whether it looks flaky (intermittent, unrelated to the code that ran) or broken (fails every time from some commit on), and propose a fix. Change nothing until I ask: don't edit code, commit, push or re-run anything; report your diagnosis first.

${CONCLUSION_INSTRUCTION}`;
}

/** What an existing investigation is sent when a later digest of its pipeline has new failed runs. */
export function followupPrompt(digest: PipelineDigest): string {
  const state = digest.state === "passed_since" ? "the newest run passed since" : "it is still failing";
  return `A new daily digest of ${digest.pipeline_name} (project ${digest.project}): ${digest.failed} of ${digest.total} runs failed between ${digest.window_start} and ${digest.window_end}; ${state}.

New failed runs:
${runLines(digest.runs)}

Add them to your investigation: Group the runs by root cause, with the earlier ones; say whether each group looks flaky or broken, and propose fixes. Change nothing until I ask: don't edit code, commit, push or re-run anything.

${CONCLUSION_INSTRUCTION}`;
}
