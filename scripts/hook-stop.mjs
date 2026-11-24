#!/usr/bin/env node
if (process.env.OMP_RAW_AGY === "1") {
  process.stdout.write("{}");
  process.exit(0);
}
import fs from "node:fs";
import { resolveDataDir, readState } from "./lib/state.mjs";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readStdin();
// Never loop infinitely if Stop already forced continuation once this turn
if (input.continuationActive || input.terminationReason !== "NO_TOOL_CALL") {
  process.stdout.write("{}");
  process.exit(0);
}

const dataDir = resolveDataDir();
const state = readState(dataDir);
const errorDiags = Object.values(state.diagnostics || {})
  .flat()
  .filter((d) => d.severity === "error");

if (errorDiags.length > 0) {
  const preview = errorDiags
    .slice(0, 3)
    .map((d) => `${d.file}:${d.line} (${d.message})`)
    .join("; ");
  process.stdout.write(
    JSON.stringify({
      decision: "continue",
      reason: `OMP Diagnostics Gate: ${errorDiags.length} unresolved error diagnostic(s) remain in edited files: ${preview}. Please inspect and fix them before finishing.`,
    })
  );
  process.exit(0);
}

process.stdout.write("{}");
