#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir, updateState, getGitTelemetry } from "./lib/state.mjs";
import { memoryRecall } from "./lib/memory-bank.mjs";
import { scanConflicts } from "./lib/virtual-fs.mjs";
import { installNativeUi } from "./install-ui.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readStdin();
const cwd = input.cwd || input.workspacePaths?.[0] || process.cwd();
const dataDir = resolveDataDir();

// Auto-wire the native `agy` statusLine & terminal title into ~/.gemini/antigravity-cli/settings.json
// on first run (non-destructive: never overwrites a user's unrelated custom statusLine).
let autoWiredUi = false;
if (process.env.OMP_NO_AUTO_STATUSLINE !== "1") {
  try {
    const res = installNativeUi({ pluginRoot: PLUGIN_ROOT, force: false });
    autoWiredUi = res.changed;
  } catch {
    // Never fail session startup if settings.json is read-only
  }
}

const git = getGitTelemetry(cwd);
const { memories } = memoryRecall({ query: "", limit: 8, cwd: git.root || cwd, dataDir });
const conflicts = scanConflicts(git.root || cwd);

updateState(dataDir, (s) => {
  s.session = {
    ...(s.session || {}),
    title: git.projectName || path.basename(cwd),
    model: input.modelName || s.session?.model || "Antigravity",
    cwd: git.root || cwd,
    turns: 0,
  };
  s.pendingDiagnosticsInjection = [];
  s.pendingAdvisorInjection = [];
});

const injectSteps = [];
let modelPrompt = "";

if (memories.length > 0) {
  modelPrompt += `[OMP Suite — Curated Project Memory for ${git.projectName}]\n`;
  modelPrompt += memories.map((m) => `- (${m.category}) [${m.id}] ${m.content}`).join("\n");
}
if (conflicts.length > 0) {
  modelPrompt += `\n\n[OMP Suite — Merge Conflicts Detected (${conflicts.length})]\n`;
  modelPrompt += conflicts.slice(0, 5).map((c) => `- ${c.uri} → ${c.relFile}:${c.line}`).join("\n");
  modelPrompt += `\nUse \`conflict_resolve\` or \`vwrite("conflict://N", "@ours|@theirs|@base")\` to resolve cleanly.`;
}

// Keep chat noise-free like `omp`: only emit a visible note if we just wired the native statusLine
// for the first time or if merge conflicts need immediate attention.
const noticeLines = [];
if (autoWiredUi) {
  noticeLines.push("> **`π` OMP Suite** wired its native OMP v19 status line into `agy` (`~/.gemini/antigravity-cli/settings.json`).");
}
if (conflicts.length > 0) {
  noticeLines.push(`> **⚠ ${conflicts.length} git merge conflict(s)** detected — ready for \`conflict://\` resolution.`);
}

if (modelPrompt || noticeLines.length > 0) {
  const sysMsg = { systemMessage: modelPrompt.trim() };
  if (noticeLines.length > 0) {
    sysMsg.metadata = { user_markdown: noticeLines.join("\n") };
  }
  injectSteps.push({ systemMessage: sysMsg });
}

process.stdout.write(JSON.stringify({ injectSteps }));
