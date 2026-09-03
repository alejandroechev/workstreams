#!/bin/sh
# Deterministic verifier for the adr-front-matter loop.
#
# The loop has no evaluator, so this script is the only gate. It proves two
# things without any agent judgement:
#
#   1. The assigned task was committed. A clean working tree is the observable
#      evidence: uncommitted edits mean the task is not finished, and they
#      would otherwise leak into the next task's diff.
#   2. The repository still passes its authoritative checks, and the ADR
#      validator — once it exists — still passes.
#
# RATCHETING GATE
# ---------------
# `scripts/check-adrs.mjs` does not exist when the loop starts; building it is
# the loop's first task. So this verifier runs it *conditionally*.
#
# That is deliberate, and it is not a weakened gate. A verifier must describe
# what has to hold after EVERY task, not the loop's final end state — if it
# demanded full completion up front, the very first task could never pass and
# the loop would deadlock. Once the validator lands, it is enforced for every
# subsequent task and can never be silently dropped, because deleting it would
# also have to delete the npm script and the test the loop is told to keep.
#
# Playwright is deliberately NOT run here. This loop edits markdown under
# docs/adrs/ and one Node script; it cannot affect the rendered UI, and the
# browser suite would add ~13 minutes to every cycle for no signal.
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

echo "== ADR validator =="
if [ -f scripts/check-adrs.mjs ]; then
    node scripts/check-adrs.mjs || fail "ADR validation failed"
else
    echo "scripts/check-adrs.mjs not present yet (expected until the first task lands)"
fi

echo "== ADR numbering is unique =="
dupes=$(ls docs/adrs/ | grep -E '^[0-9]{3}-' | sed 's/-.*//' | sort | uniq -d || true)
if [ -n "$dupes" ]; then
    echo "$dupes" >&2
    fail "duplicate ADR numbers found"
fi
echo "ADR numbers unique"

echo "== typecheck =="
npx tsc --noEmit -p tsconfig.json || fail "tsc reported type errors"

echo "== lint =="
npm run lint || fail "eslint reported errors"

echo "== unit tests + coverage =="
npm run test:coverage || fail "vitest suite or coverage threshold failed"

echo "VERIFY OK"
