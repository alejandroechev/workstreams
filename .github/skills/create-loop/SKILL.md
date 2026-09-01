---
name: create-loop
description: >-
  Create or revise a strict Workstreams loop definition in
  the current Copilot session's files/loops/*.loop.yaml from a natural-language request. Use when the
  user says "create this loop", "make a loop", "define an autonomous loop",
  or asks for a reusable Workstreams loop YAML file.
---

# Create Loop

Create a reviewable loop definition in the current Copilot session-state
folder. The YAML file is the authoritative configuration; Workstreams SQLite
stores only bindings and runtime history.

## Non-negotiable behavior

- Write only `<current-session-folder>/files/loops/<id>.loop.yaml` and
  explicitly requested
  supporting files such as verifier scripts, feedback, or golden patterns.
- Never enable or run the loop unless the user separately asks.
- Always validate the final file:

  ```bash
  npm run loop:cli -- validate <repo-root> <definition-file>
  ```

- Fix every validation error. Never bypass or weaken the schema.
- Treat `schemas/loop-definition-v1alpha1.schema.json` and the
  `workstreams loop validate` parser as authoritative. This document is
  authoring guidance, not a second schema.
- Use one small task per run. This DSL is not a DAG or arbitrary workflow
  language.
- At least one independent sensor is required: `spec.verification`,
  `spec.evaluator`, or `spec.humanApproval`. They may be combined.
- `publicEffects` is always `deny`.

## Authoring workflow

1. Inspect the repository's build/test/lint commands and existing
   `<current-session-folder>/files/loops/*.loop.yaml` definitions.
2. Identify:
   - desired end state (`spec.objective`);
   - how the orchestrator selects the smallest next correction;
   - worker instructions and any golden patterns;
   - deterministic verifier and/or semantic evaluator;
   - a safe run timeout.
3. Prefer a deterministic verifier whenever correctness can be measured.
4. If a custom verifier is needed, create it in a suitable repository folder
   such as `scripts/loops/<id>.*`, then reference it from the YAML. Paths are
   resolved from the repository root, not from the YAML file's folder.
5. Generate the YAML using the exact syntax below.
6. Validate it with the CLI and report the definition path, sensors, tool
   permissions, and portability.

## Exact v1 syntax

<!-- loop-example:start -->
```yaml
apiVersion: workstreams.dev/v1alpha1
kind: Loop

metadata:
  id: example-loop
  name: Example loop
  description: Optional short description.
  tags:
    - optional

spec:
  objective: >
    The desired repository end state.

  trigger:
    type: manual

  orchestrator:
    model: inherit
    prompt: |
      Inspect the current repository and choose the next useful tasks.
      Return an empty task list only when the overall objective is complete.
    maxTasksPerRun: 3

  worker:
    model: inherit
    prompt: |
      Implement only the assigned task and keep the diff narrowly scoped.

  verification:
    command:
      program: npm
      args:
        - test
      cwd: .
      timeout: 10m

  evaluator:
    model: inherit
    prompt: |
      Judge whether the assigned task is correct and supported by evidence.
    onReject:
      action: revise

  humanApproval:
    prompt: |
      Review the task result and all automated evidence before accepting it.

  limits:
    runTimeout: 30m
    taskAttempts: 2

  permissions:
    tools: full
    publicEffects: deny

  flowControl:
    maxActiveRuns: 1
```
<!-- loop-example:end -->

## Optional blocks

`metadata.description`, `metadata.tags`, `worker.skills`, `worker.context`,
`verification`, `evaluator`, and `humanApproval` are optional.

At least one of these must exist:

```yaml
spec:
  verification: ...
```

```yaml
spec:
  evaluator: ...
```

```yaml
spec:
  humanApproval: ...
```

When combined, the order is deterministic verification, evaluator, then human
approval. A verifier failure cannot be overridden.

## Verifier paths

`verification.command.program` supports:

- a command name resolved through `PATH`, such as `npm` or `cargo`;
- a repository-relative script, such as `scripts/loops/verify.sh`;
- an absolute external script path.

Relative paths and `cwd` resolve from the repository root. Relative paths may
not escape it. Absolute paths are allowed but make the definition
**non-portable**; call this out to the user.

Keep `program` and `args` separate. Do not use a shell command string:

```yaml
# Correct
program: npm
args: [run, test:coverage]

# Invalid design
program: "npm run test:coverage && npm run lint"
```

Create a wrapper verifier script when several deterministic commands must run.

## v1 constraints

- `apiVersion`: `workstreams.dev/v1alpha1`
- `kind`: `Loop`
- `trigger.type`: `manual`
- `orchestrator.maxTasksPerRun`: a positive orchestration batch size
- `evaluator.onReject.action`: `revise`
- `limits.taskAttempts`: a positive integer total attempt budget
- `permissions.tools`: `full`
- `permissions.publicEffects`: `deny`
- `flowControl.maxActiveRuns`: `1`

`limits.taskAttempts` counts total worker attempts. Use `1` for no revisions,
`2` for one revision, or `N` for up to `N - 1` revisions. Run timeout remains
the outer safety bound.

After every accepted batch, Workstreams invokes the orchestrator again with
the accumulated accepted task keys. The run completes only when a later cycle
returns `{"tasks":[]}`. `maxTasksPerRun` limits one batch, not the whole run.

Durations are positive integers followed by `s`, `m`, or `h`, for example
`90s`, `10m`, or `2h`.

Unknown keys are validation errors. Do not add schedules, expressions, secrets,
steps, DAG edges, recursive agents, publication rules, or provider-specific
integration blocks.

## Stable task keys

The orchestrator prompt must teach the agent to derive a stable key from the
source work and its revision where applicable, for example:

- `src/api/user.ts:createUser`
- `issue-42@commit-sha`
- `package-name:missing-test:function-name`

Accepted or in-flight keys are deduplicated within this loop definition.

## Completion response

Report:

- YAML path;
- verifier/evaluator configuration;
- whether it is portable;
- validator result;
- supporting files created;
- that the loop was **not run**.
