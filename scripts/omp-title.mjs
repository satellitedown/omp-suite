#!/usr/bin/env node
/**
 * Native Antigravity CLI (`agy`) Terminal Window Title Renderer — OMP Style
 * Wired into `~/.gemini/antigravity-cli/settings.json` (`title.command`).
 */

import fs from "node:fs";
import path from "node:path";

let p = {};
try {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (raw) p = JSON.parse(raw);
} catch {
  // ignore
}

const cwd = p.workspace?.current_dir || p.workspace?.project_dir || p.cwd || process.cwd();
const proj = path.basename(cwd);
const state = p.agent_state || "idle";
const icon =
  p.tool_confirmation_pending
    ? "!"
    : state === "working" || state === "tool_use"
      ? "⚡"
      : state === "error"
        ? "✕"
        : "π";

const parts = [icon, proj];
if (p.conversation_title) parts.push(p.conversation_title.slice(0, 48));
process.stdout.write(parts.join(" · ") + "\n");
