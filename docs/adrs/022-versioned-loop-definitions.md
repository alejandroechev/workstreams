# ADR 022: Versioned YAML loop definitions

## Status

Accepted (2026-08-28).

## Context

ADR 021 proved the durable manual loop controller, but its setup form made loop
configuration local, difficult to review, and impractical to reuse. Agents can
already author repository files from natural-language instructions, so a
workflow-specific visual editor would duplicate that capability while making
definitions less portable.

The runtime also needs stronger provenance. A run must remain explainable when
the source definition changes later, and deterministic verification often lives
in a repository script rather than beside the definition.

## Decision

### YAML is the authoring authority

Repository-owned loop definitions live at:

```text
.workstreams/loops/*.loop.yaml
```

They use `apiVersion: workstreams.dev/v1alpha1` and `kind: Loop`. The parser
rejects duplicate keys, unknown fields, invalid identifiers, unsupported
limits, and paths that escape the workstream. The JSON Schema at
`schemas/loop-definition-v1alpha1.schema.json` documents the same contract for
editors and tooling.

The `create-loop` skill is the primary natural-language authoring workflow. It
may create and validate a definition, but it never runs or enables one
implicitly. The Goal Loop tile is a catalog and runtime monitor, not a form
editor: it lists valid definitions, exact validation failures, feedback mode,
tags, and portability, then runs the selected file.

### The controller shape remains fixed

YAML configures the existing orchestrator → worker pipeline; it does not define
an arbitrary DAG. In v1:

- the trigger is manual;
- the orchestrator emits at most one task per run;
- a task has at most two worker attempts;
- a workstream has at most one active run;
- Copilot tools are fully available, while public effects remain denied;
- at least one of deterministic verification, independent evaluation, or
  human approval is required.

Sensors run in a fixed order: verifier, evaluator, then human approval.
Any non-empty combination is valid. A verifier failure is authoritative and
cannot be overridden by a later sensor. Human approval semantics are defined
by ADR 023.

### Paths resolve from the workstream root

Relative worker context, golden-pattern, verifier program, and verifier working
directory paths resolve from the workstream root, not the YAML file directory.
They may not escape the workstream. A bare command such as `cargo` or `npm`
remains a `PATH` lookup.

Absolute verifier program and working-directory paths are allowed for local
automation but mark the definition non-portable in the catalog. This supports a
custom verification script in any folder without pretending that a
machine-specific definition is repository-portable.

### SQLite stores runtime bindings and immutable evidence

YAML remains authoritative for authoring. Before a run, Workstreams validates
and materializes the selected definition into the existing `loop_specs` row.
The run stores the exact raw YAML and its SHA-256 hash. Later file edits cannot
change the evidence associated with an existing run.

Task-key deduplication is scoped by definition id as well as materialized spec
id, so two definitions may intentionally emit the same stable task key without
sharing history.

The CLI uses the same parser and runtime:

```text
workstreams loop validate <workspace> <definition-file>
workstreams loop list <workspace>
workstreams loop run-file <db-path> <workspace> <definition-file>
```

CLI workspaces are canonicalized before SDK sessions start so relative paths
cannot make an agent operate in the Workstreams application's own directory.

## Consequences

Definitions are reviewable, reusable, versioned with their repository, and
straightforward for agents to generate. Runtime history remains queryable in
SQLite while retaining immutable source provenance. External scripts can
provide precise sensors without requiring integration-specific scaffolding.

The v1 contract is intentionally narrow. Scheduling, cloud execution, arbitrary
graphs, multiple tasks per orchestration, and automatic public effects remain
out of scope.

## Validation

Rust tests cover strict parsing, discovery, path confinement, portability,
optional sensors, the create-loop skill example, materialization, immutable
snapshots, and definition-scoped deduplication. Vitest covers backend parity
and catalog behavior. Playwright exercises catalog selection, loop controls,
and human approval. The CLI is validated with deterministic controller and
approval scenarios plus authenticated YAML loops.
