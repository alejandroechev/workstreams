#!/bin/sh
# Deterministic verifier for the playwright-demo-media loop.
#
# The loop has a semantic evaluator for visual quality, but that evaluator is
# not allowed to substitute taste for measurable correctness. This script
# independently proves that every task is committed, the media contract passes
# once it exists, and the repository remains healthy.
#
# RATCHETING GATE
# ---------------
# `npm run demos:check` is created by the loop's first task. Until then there is
# nothing to invoke, so the verifier skips that one check. Once declared, it is
# mandatory for every later task. This avoids the impossible state where task 1
# cannot pass because the checker it is assigned to create does not exist yet.
#
# The recording command itself is intentionally not run on every cycle.
# Re-recording video is slow and codec output is not byte-for-byte stable. The
# checker instead validates the committed manifest's source hash, dimensions,
# duration, codecs, size budgets, required poster/fallback assets, HTML/README
# references, and absence of the retired 3.3 MB GIF.
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

echo "== demo media contract =="
if node -e "process.exit(require('./package.json').scripts['demos:check'] ? 0 : 1)" 2>/dev/null; then
    npm run demos:check || fail "recorded demo media is missing, stale, oversized, or malformed"
else
    echo "demos:check not declared yet (expected until the recorder task lands)"
fi

echo "== typecheck =="
npx tsc --noEmit -p tsconfig.json || fail "tsc reported type errors"

echo "== lint =="
npm run lint || fail "eslint reported errors"

echo "== unit tests + coverage =="
npm run test:coverage || fail "vitest suite or coverage threshold failed"

echo "== browser end-to-end =="
npm run test:e2e -- --workers=1 --retries=2 || fail "playwright suite failed"

echo "== production build =="
npm run build || fail "production build failed"

echo "VERIFY OK"
