#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, updateState, getGitTelemetry } from "./lib/state.mjs";
import { memoryRecall } from "./lib/memory-bank.mjs";
import { scanConflicts } from "./lib/virtual-fs.mjs";
import { listAllTtsrRules } from "./lib/ttsr.mjs";

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
const git = getGitTelemetry(cwd);
const { memories } = memoryRecall({ query: "", limit: 8, cwd: git.root || cwd, dataDir });
const conflicts = scanConflicts(git.root || cwd);
const rules = listAllTtsrRules(dataDir, git.root || cwd).filter((r) => r.enabled !== false);

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

const gitBadge = git.isGitRepo
  ? `\`⎇ ${git.branch}\`${git.modified || git.staged || git.untracked ? ` (*${git.staged} ~${git.modified} +${git.untracked})` : " (clean)"}`
  : "`no-git`";

const userMarkdown = [
  `> **\`π\` OMP Suite active** · \`${git.projectName}\` · ${gitBadge} · **${memories.length}** memories · **${rules.length}** TTSR guardrails${conflicts.length ? ` · ⚠ **${conflicts.length}** merge conflicts` : ""}`,
].join("\n");

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

injectSteps.push({
  systemMessage: {
    systemMessage: modelPrompt,
    metadata: {
      user_markdown: userMarkdown,
    },
  },
});

process.stdout.write(JSON.stringify({ injectSteps }));
