#!/usr/bin/env node
if (process.env.OMP_RAW_AGY === "1") {
  process.stdout.write("{}");
  process.exit(0);
}
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, updateState, recordToolActivity } from "./lib/state.mjs";
import { runFastDiagnostics } from "./lib/lsp-client.mjs";

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

const touchedPath = args.Path || args.filePath || args.TargetFile || "";

recordToolActivity(dataDir, {
  tool: toolName || "tool",
  status: input.error ? "error" : "ok",
  summary: touchedPath
    ? path.basename(touchedPath)
    : args.CommandLine
      ? String(args.CommandLine).slice(0, 60)
      : "",
});

if (touchedPath && !input.error) {
  const absPath = path.resolve(cwd, touchedPath);
  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    const diags = runFastDiagnostics(absPath, cwd);
    updateState(dataDir, (s) => {
      if (diags.length > 0) {
        s.diagnostics[absPath] = diags;
        s.pendingDiagnosticsInjection = s.pendingDiagnosticsInjection || [];
        s.pendingDiagnosticsInjection.push({
          file: absPath,
          diagnostics: diags,
          timestamp: new Date().toISOString(),
        });
      } else {
        delete s.diagnostics[absPath];
      }
    });
  }
}

// PostToolUse contract strictly expects `{}` on stdout
process.stdout.write("{}");
