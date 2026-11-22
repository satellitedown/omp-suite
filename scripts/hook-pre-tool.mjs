#!/usr/bin/env node
import fs from "node:fs";
import { resolveDataDir } from "./lib/state.mjs";
import { matchTtsrRules, recordTtsrAlert } from "./lib/ttsr.mjs";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readStdin();
const toolCall = input.toolCall || {};
const toolName = toolCall.name || "";
const args = toolCall.args || {};
const cwd = input.cwd || input.workspacePaths?.[0] || process.cwd();
const dataDir = resolveDataDir();

// Extract payload text & target file path across Antigravity + OMP edit/command tools
let filePath = args.Path || args.filePath || args.TargetFile || "";
let textToCheck = "";

if (toolName === "run_command") {
  textToCheck = String(args.CommandLine || "");
} else if (toolName === "edit_file") {
  textToCheck = String(args.Replacement || "");
} else if (toolName === "write_file") {
  textToCheck = String(args.Content || "");
} else if (toolName.includes("hashline_edit")) {
  textToCheck = Array.isArray(args.edits) ? args.edits.map((e) => e.content || "").join("\n") : "";
} else {
  textToCheck = JSON.stringify(args);
}

if (!textToCheck) {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
}

const hits = matchTtsrRules({ text: textToCheck, filePath, dataDir, cwd });
if (hits.length === 0) {
  process.stdout.write(JSON.stringify({ decision: "allow" }));
  process.exit(0);
}

for (const h of hits) {
  recordTtsrAlert(dataDir, h, toolName);
}

const blocking = hits.find((h) => h.mode === "block");
if (blocking) {
  process.stdout.write(
    JSON.stringify({
      decision: "deny",
      reason: `⚠ TTSR Injecting rule: ${blocking.name} — ${blocking.message} (matched: ${JSON.stringify(blocking.matched)})`,
    })
  );
  process.exit(0);
}

process.stdout.write(JSON.stringify({ decision: "allow" }));
