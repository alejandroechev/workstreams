/**
 * discipline-guardian extension
 *
 * Enforces dev discipline through Copilot CLI hooks:
 *
 * 1. onSessionStart:
 *    - Installs SQLite triggers (auto_inject_feature_todos, block_done_with_pending_children)
 *    - Runs discipline-audit and surfaces results
 *
 * 2. onPostToolUse (edit/create):
 *    - Tracks source vs test file changes in session state
 *    - Injects warnings when ratio gets bad
 *
 * 3. onUserPromptSubmitted:
 *    - Intercepts done/complete/finished keywords
 *    - Injects Definition of Done checklist
 */
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile, spawn } from "node:child_process";
import path from "node:path";

// Session-scoped state
const state = {
  sourceEdits: 0,
  testEdits: 0,
  docEdits: 0,
  lastWarningTurn: -1,
  turnCount: 0,
};

const SOURCE_PATTERNS = [/^src[\\/]/, /^src-tauri[\\/]src[\\/]/];
const TEST_PATTERNS = [/[\\/]__tests__[\\/]/, /\.test\.(ts|tsx|js|jsx)$/];
const DOC_PATTERNS = [/^README\.md$/, /^docs[\\/]/];

const SKIP_PATTERNS = [
  /\.css$/,
  /vite\.config\.ts$/,
  /eslint\.config\.js$/,
  /vitest\.config\.ts$/,
  /\.types\.ts$/,
];

function isSource(p) {
  if (!p) return false;
  const rel = path.normalize(p).replace(/\\/g, "/");
  if (SKIP_PATTERNS.some((re) => re.test(rel))) return false;
  if (TEST_PATTERNS.some((re) => re.test(rel))) return false;
  return SOURCE_PATTERNS.some((re) => re.test(rel));
}

function isTest(p) {
  if (!p) return false;
  return TEST_PATTERNS.some((re) => re.test(p));
}

function isDoc(p) {
  if (!p) return false;
  return DOC_PATTERNS.some((re) => re.test(p));
}

function runPython(args) {
  return new Promise((resolve) => {
    execFile("python", args, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout?.toString() || "",
        stderr: stderr?.toString() || "",
      });
    });
  });
}

function runNode(args, cwd) {
  return new Promise((resolve) => {
    execFile("node", args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout?.toString() || "",
        stderr: stderr?.toString() || "",
      });
    });
  });
}

const extensionDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const installScript = path.join(extensionDir, "install-triggers.py");

const session = await joinSession({
  hooks: {
    onSessionStart: async (input, invocation) => {
      const sessionId = invocation.sessionId;
      const cwd = input.cwd;

      // 1) Install SQLite triggers
      const triggerResult = await runPython([installScript, sessionId]);
      if (triggerResult.ok) {
        await session.log(`🔒 Discipline triggers installed`, { ephemeral: false });
      } else {
        await session.log(`⚠️ Trigger install failed: ${triggerResult.stderr.trim()}`, { level: "warning" });
      }

      // 2) Run discipline audit
      const auditScript = path.join(cwd, "scripts", "discipline-audit.mjs");
      try {
        const auditResult = await runNode([auditScript], cwd);
        if (auditResult.ok && auditResult.stdout) {
          // Inject as context so agent sees it at session start
          return {
            additionalContext: `## Session-Start Discipline Audit\n\n\`\`\`\n${auditResult.stdout.trim()}\n\`\`\`\n\nReview the audit. If gaps exist, address them before starting new work.`,
          };
        }
      } catch {
        // Audit script doesn't exist or failed — non-fatal
      }
    },

    onPostToolUse: async (input) => {
      state.turnCount++;
      const tool = input.toolName;

      // Track file edits
      if (tool === "edit" || tool === "create") {
        const filePath = input.toolArgs?.path;
        if (!filePath) return;

        const isSuccess = input.toolResult?.resultType !== "failure";
        if (!isSuccess) return;

        if (isTest(filePath)) {
          state.testEdits++;
        } else if (isSource(filePath)) {
          state.sourceEdits++;
        } else if (isDoc(filePath)) {
          state.docEdits++;
        }

        // Nudge: too many source edits without tests
        const sourceWithoutTests = state.sourceEdits - state.testEdits;
        if (
          sourceWithoutTests >= 5 &&
          state.turnCount - state.lastWarningTurn >= 10
        ) {
          state.lastWarningTurn = state.turnCount;
          return {
            additionalContext: `⚠️ DISCIPLINE: ${state.sourceEdits} source edits vs only ${state.testEdits} test edits this session. Write tests before continuing (TDD: RED→GREEN→REFACTOR).`,
          };
        }

        // Nudge: many edits without docs
        if (
          state.sourceEdits >= 10 &&
          state.docEdits === 0 &&
          state.turnCount - state.lastWarningTurn >= 10
        ) {
          state.lastWarningTurn = state.turnCount;
          return {
            additionalContext: `📚 DISCIPLINE: ${state.sourceEdits} source edits with no doc updates. Consider updating README, docs/system-diagram.md, or writing an ADR.`,
          };
        }
      }

      // Reminder after git commit
      if (tool === "bash" || tool === "powershell") {
        const cmd = String(input.toolArgs?.command || "");
        if (/\bgit\s+commit\b/.test(cmd) && input.toolResult?.resultType !== "failure") {
          return {
            additionalContext: `✅ Commit done. If this was a UI feature, run \`node scripts/cdp-validate.mjs <feature-name>\` to capture a screenshot and verify clean console.`,
          };
        }
      }
    },

    onUserPromptSubmitted: async (input) => {
      const prompt = (input.prompt || "").toLowerCase();
      const doneWords = /\b(done|complete[d]?|finished|ready to commit|all set)\b/;
      if (doneWords.test(prompt)) {
        return {
          additionalContext: `📋 DEFINITION OF DONE — Before claiming complete, verify:

1. ✅ Tests written and passing (\`npm test\`)
2. ✅ Coverage ≥ 90% (\`npm run test:coverage\`)
3. ✅ Visual validation done (\`node scripts/cdp-validate.mjs <feature>\`)
4. ✅ Console clean in CDP screenshot
5. ✅ Docs updated (README / system-diagram / ADR if applicable)
6. ✅ All child todos done (if this is a feature with category='feature')

Run \`node scripts/discipline-audit.mjs\` for a final status check.`,
        };
      }
    },
  },
  tools: [],
});

await session.log("discipline-guardian extension loaded");
