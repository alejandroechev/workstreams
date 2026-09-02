#!/bin/sh
# Deterministic verifier for the workstreams-ui-features loop.
#
# The loop has no evaluator, so this script is the only gate. It must therefore
# prove two things without any agent judgement:
#
#   1. The assigned task was committed. A clean working tree is the observable
#      evidence: uncommitted edits mean the task is not actually finished, and
#      they would otherwise leak into the next task's diff.
#   2. The repository still passes its authoritative checks.
#
# Ordered cheapest-first so an obvious failure reports in seconds rather than
# after the multi-minute browser suite.
set -eu

fail() {
    echo "VERIFY FAILED: $1" >&2
    exit 1
}

echo "== committed-work check =="
if [ -n "$(git status --porcelain)" ]; then
    git status --short >&2
    fail "working tree is not clean; commit the assigned task (and nothing else)"
fi
echo "working tree clean"

echo "== typecheck =="
npx tsc --noEmit -p tsconfig.json || fail "tsc reported type errors"

echo "== lint =="
npm run lint || fail "eslint reported errors"

echo "== unit tests + coverage =="
npm run test:coverage || fail "vitest suite or coverage threshold failed"

echo "== browser end-to-end =="
npm run test:e2e -- --workers=1 --retries=2 || fail "playwright suite failed"

echo "VERIFY OK"
