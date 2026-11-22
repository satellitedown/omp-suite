#!/usr/bin/env node
import fs from "node:fs";
import { resolveDataDir, readState, writeState } from "./lib/state.mjs";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readStdin();
const dataDir = resolveDataDir();
const state = readState(dataDir);

const diagQueue = state.pendingDiagnosticsInjection || [];
const advisorQueue = state.pendingAdvisorInjection || [];

state.session = {
  ...(state.session || {}),
  turns: (state.session?.turns || 0) + 1,
  model: input.modelName || state.session?.model || "Antigravity",
};

if (diagQueue.length === 0 && advisorQueue.length === 0) {
  writeState(dataDir, state);
  process.stdout.write(JSON.stringify({ injectSteps: [] }));
  process.exit(0);
}

const modelLines = [];
const mdLines = [];

if (diagQueue.length > 0) {
  modelLines.push("[OMP Suite — Post-Edit Diagnostics Detected]");
  mdLines.push("> **⚠ OMP Post-Edit Diagnostics**");
  for (const item of diagQueue) {
    for (const d of item.diagnostics.slice(0, 6)) {
      modelLines.push(`- [${d.severity}] ${d.file}:${d.line} (${d.source}): ${d.message}`);
      mdLines.push(`> - \`${d.file}:${d.line}\` — ${d.message}`);
    }
  }
  modelLines.push("Please fix these syntax/type diagnostics before completing your task.");
}

if (advisorQueue.length > 0) {
  modelLines.push("\n[OMP Advisor Watchdog Notes]");
  for (const n of advisorQueue) {
    modelLines.push(`- (${n.severity}) ${n.title}: ${n.message}`);
    mdLines.push(`> **ℹ Advisor (${n.severity}) · ${n.title}** — ${n.message}`);
  }
}

state.pendingDiagnosticsInjection = [];
state.pendingAdvisorInjection = [];
writeState(dataDir, state);

process.stdout.write(
  JSON.stringify({
    injectSteps: [
      {
        systemMessage: {
          systemMessage: modelLines.join("\n").trim(),
          metadata: {
            user_markdown: mdLines.join("\n"),
          },
        },
      },
    ],
  })
);
