#!/bin/sh
# Deterministic verifier for the keymap-generation loop.
#
# The loop has no evaluator, so this script is the only gate. It proves the
# assigned task was committed, that the repository still passes its
# authoritative checks, and — once the generator exists — that the committed
# keymap documentation is not stale.
#
# RATCHETING GATE
# ---------------
# `npm run keymaps:check` does not exist when the loop starts; building the
# generator is the loop's job. So this verifier runs it *conditionally*.
#
# That is deliberate, and it is not a weakened gate. A verifier must describe
# what has to hold after EVERY task, not the loop's final end state — if it
# demanded full completion up front, the first task could never pass and the
# loop would deadlock. Once the script is declared, it is enforced for every
# subsequent task.
#
# Playwright IS run here, unlike the sibling ADR loop. This loop refactors
# src/domain/keyboard.ts, which every keyboard shortcut in the app routes
# through; a regression there is exactly the class of bug that unit tests with
# a mocked DOM can miss and a real browser catches.
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

echo "== keymap staleness =="
if node -e "process.exit(require('./package.json').scripts['keymaps:check'] ? 0 : 1)" 2>/dev/null; then
    npm run keymaps:check || fail "docs/keymaps.md is stale — regenerate it and commit"
else
    echo "keymaps:check not declared yet (expected until the generator task lands)"
fi

echo "== typecheck =="
npx tsc --noEmit -p tsconfig.json || fail "tsc reported type errors"

echo "== lint =="
npm run lint || fail "eslint reported errors"

echo "== unit tests + coverage =="
npm run test:coverage || fail "vitest suite or coverage threshold failed"

echo "== browser end-to-end =="
npm run test:e2e -- --workers=1 --retries=2 || fail "playwright suite failed"

echo "VERIFY OK"
