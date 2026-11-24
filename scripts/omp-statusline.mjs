#!/usr/bin/env node
/**
 * Native Antigravity CLI (`agy`) Status Line Renderer — Newest OMP v19 / Tern Style
 *
 * Wired into `~/.gemini/antigravity-cli/settings.json` (`statusLine.command`).
 * Whenever `agy` updates session state, `agy` pipes live JSON telemetry to stdin
 * and renders stdout natively in the TUI chrome below the prompt box (multi-line
 * ANSI truecolor supported, zero manual commands required).
 */

import fs from "node:fs";
import path from "node:path";
import { OMP_DARK_THEME as T, getSessionAccentHex, fgHex } from "./lib/session-color.mjs";
import { resolveDataDir, readState, getCachedGitTelemetry } from "./lib/state.mjs";
import { memoryRecall } from "./lib/memory-bank.mjs";
import { writeCachedQuota } from "./lib/usage-stats.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function visLen(s) {
  return s.replace(ANSI_RE, "").length;
}

function truncVis(str, maxW) {
  if (visLen(str) <= maxW) return str;
  const plain = str.replace(ANSI_RE, "");
  return plain.slice(0, Math.max(0, maxW - 1)) + "…";
}

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function effortColor(effort) {
  const e = String(effort || "").toLowerCase();
  if (e === "xhigh" || e === "max") return T.lavender;
  if (e === "high") return T.purple;
  if (e === "medium") return T.cyan;
  if (e === "low") return T.blue;
  return T.muted;
}

function cleanModelName(modelObj) {
  if (!modelObj) return { name: "Antigravity", effort: "" };
  const rawName = String(modelObj.display_name || modelObj.id || "Antigravity");
  // Strip trailing "(XHigh)" etc. when effort is already rendered as its own OMP chip
  const effort = modelObj.effort || (rawName.match(/\((low|medium|high|xhigh|max)\)\s*$/i)?.[1]?.toLowerCase() ?? "");
  const name = rawName.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, "").trim();
  return { name, effort };
}

function formatWindowSize(bytesOrTokens) {
  if (!bytesOrTokens || bytesOrTokens <= 0) return "";
  if (bytesOrTokens >= 1_000_000) {
    const m = bytesOrTokens / 1_000_000;
    return `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(bytesOrTokens / 1000)}K`;
}

function formatCost(costObj, planTier) {
  if (!costObj || typeof costObj.total_usd !== "number") return "";
  const usd = `$${costObj.total_usd.toFixed(2)}`;
  const isSub = planTier && !/api|free/i.test(planTier);
  return isSub ? `${usd} (sub)` : usd;
}

function minQuotaWarning(quotaObj) {
  if (!quotaObj || typeof quotaObj !== "object") return null;
  let lowest = 1;
  for (const bucket of Object.values(quotaObj)) {
    if (bucket && typeof bucket.remaining_fraction === "number" && bucket.remaining_fraction < lowest) {
      lowest = bucket.remaining_fraction;
    }
  }
  return lowest < 0.25 ? Math.round(lowest * 100) : null;
}

const p = readPayload();
const width = Math.max(56, Number(p.terminal_width) || process.stdout.columns || 100);
const cwd = p.workspace?.current_dir || p.workspace?.project_dir || p.cwd || process.cwd();
const dataDir = resolveDataDir();
if (p.quota && typeof p.quota === "object") {
  writeCachedQuota(dataDir, p);
}
const pluginState = readState(dataDir);
const git = getCachedGitTelemetry(cwd, 1500);

const projectName = git.projectName || path.basename(cwd);
const rawTitle = (p.conversation_title || "").trim();
const sessionTitle = rawTitle || projectName;
const accentHex = getSessionAccentHex(rawTitle || p.conversation_id || projectName);

const { name: modelName, effort } = cleanModelName(p.model);
const isWorking = ["working", "tool_use", "reviewing", "initializing"].includes(p.agent_state);

// --- Build Signature OMP v19 Main Bar ---
const leftSegs = [];

// 1. Brand π glyph + separator
leftSegs.push(fgHex("#38bdf8", `${BOLD}π${RESET}`) + " " + fgHex(T.dim, "❯"));

// 2. Model + live activity bolt + OMP effort dot
let modelSeg = fgHex(T.cyan, `⚙ ${modelName}`);
if (isWorking) modelSeg += fgHex(T.accent, " ⚡");
if (effort) modelSeg += fgHex(T.dim, " · ") + fgHex(effortColor(effort), `● ${effort}`);
if (p.agent?.name) modelSeg += fgHex(T.rose, ` [${p.agent.name}]`);
leftSegs.push(modelSeg);

// 3. Workspace folder
leftSegs.push(fgHex(T.textBright, `📁 ${projectName}`));

// 4. Git branch & dirty counters (matching omp's exact git colors)
if (git.isGitRepo) {
  const dirty = git.staged + git.modified + git.untracked;
  const parts = [fgHex(dirty > 0 ? T.gitDirty : T.gitClean, `⎇ ${git.branch || "HEAD"}`)];
  if (git.staged) parts.push(fgHex(T.green, `*${git.staged}`));
  if (git.modified) parts.push(fgHex(T.accent, `~${git.modified}`));
  if (git.untracked) parts.push(fgHex("#38bdf8", `+${git.untracked}`));
  if (git.conflicts) parts.push(fgHex(T.red, `⚠${git.conflicts}`));
  leftSegs.push(parts.join(" "));
}

// 5. Context Window fill (`◫ 4.3%/1M ✦`)
const cw = p.context_window;
if (cw && typeof cw.used_percentage === "number") {
  const pct = cw.used_percentage.toFixed(1);
  const sz = formatWindowSize(cw.context_window_size);
  const col = cw.used_percentage >= 88 ? T.red : cw.used_percentage >= 70 ? T.accent : T.contextBar;
  leftSegs.push(fgHex(col, `◫ ${pct}%${sz ? `/${sz}` : ""} ✦`));
}

// 6. Spend (`$0.45 (sub)`)
const costStr = formatCost(p.cost, p.plan_tier);
if (costStr) {
  leftSegs.push(fgHex("#d7af5f", costStr));
}

// 7. Mode / Vim / Sandbox / Low Quota chips
const modeBits = [];
if (p.cycle_mode) {
  const mCol = p.cycle_mode === "plan" ? T.lavender : p.cycle_mode === "auto" ? T.green : T.cyan;
  modeBits.push(fgHex(mCol, p.cycle_mode));
}
if (p.vim?.mode) modeBits.push(fgHex(T.accent, p.vim.mode));
if (p.sandbox?.enabled) modeBits.push(fgHex(T.teal, "🔒"));
const lowQ = minQuotaWarning(p.quota);
if (lowQ !== null) modeBits.push(fgHex(T.red, `quota:${lowQ}%`));
if (modeBits.length) leftSegs.push(modeBits.join(" "));

const leftFull = leftSegs.join("  ");
const leftLen = visLen(leftFull);
const maxTitleLen = Math.max(8, width - 10 - leftLen);
const fittedTitle =
  sessionTitle.length > maxTitleLen ? sessionTitle.slice(0, Math.max(1, maxTitleLen - 1)) + "…" : sessionTitle;
const rightTitle = fgHex(accentHex, `${BOLD}${fittedTitle}${RESET}`);
const rightLen = visLen(rightTitle);
const dashSpace = width - 8 - leftLen - rightLen;

let mainRow;
if (dashSpace >= 2) {
  mainRow =
    fgHex(accentHex, "╰─ ") +
    leftFull +
    " " +
    fgHex(accentHex, "─".repeat(dashSpace)) +
    " " +
    rightTitle +
    fgHex(accentHex, " ─╯");
} else {
  // Narrow terminal fallback: gracefully fit left segments inside accent corners
  const inner = truncVis(leftFull, Math.max(20, width - 6));
  const pad = Math.max(0, width - 6 - visLen(inner));
  mainRow = fgHex(accentHex, "╰─ ") + inner + " ".repeat(pad) + fgHex(accentHex, " ─╯");
}

// --- Build Optional Tern Live Activity Tray Row (only when live items exist) ---
const trayItems = [];

if (p.tool_confirmation_pending) {
  trayItems.push(fgHex(T.accent, `${BOLD}⚠ awaiting approval${RESET}`));
} else if (isWorking) {
  trayItems.push(fgHex(accentHex, `⋮ ${p.agent_state}`));
}

const subagents = Array.isArray(p.subagents) ? p.subagents : [];
const runningSubs = subagents.filter((s) => s.status === "running");
const doneSubs = subagents.filter((s) => s.status === "completed");
if (runningSubs.length > 0) {
  const names = runningSubs
    .slice(0, 2)
    .map((s) => s.role || s.name)
    .join(", ");
  const extra = runningSubs.length > 2 ? ` +${runningSubs.length - 2}` : "";
  trayItems.push(fgHex(T.cyan, `◉ ${names}${extra}`));
} else if (doneSubs.length > 0) {
  trayItems.push(fgHex(T.green, `✓ ${doneSubs.length} agent${doneSubs.length === 1 ? "" : "s"}`));
}

if (p.task_count > 0) {
  trayItems.push(fgHex(T.purple, `⚡ ${p.task_count} task${p.task_count === 1 ? "" : "s"}`));
}
if (p.artifact_count > 0) {
  trayItems.push(fgHex(T.teal, `▤ ${p.artifact_count} artifact${p.artifact_count === 1 ? "" : "s"}`));
}

// Live OMP Suite plugin telemetry (staged AST codemods, DAP, diagnostics, advisor, TTSR, memories)
const staged = Object.values(pluginState.stagedCodemods || {}).filter((c) => c.status === "proposed");
if (staged.length > 0) {
  trayItems.push(fgHex(T.accent, `◆ AST: ${staged.length} proposed (${staged[0].totalReplacements} hits)`));
}

const activeDap = Object.values(pluginState.dapSessions || {}).filter((d) => d.status !== "terminated");
if (activeDap.length > 0) {
  trayItems.push(fgHex(T.purple, `◉ DAP: ${activeDap[0].frame || activeDap[0].sessionId}:${activeDap[0].line}`));
}

const diags = Object.values(pluginState.diagnostics || {}).flat();
if (diags.length > 0) {
  trayItems.push(fgHex(T.red, `✕ diag: ${diags.length}`));
}

const recentAlert = (pluginState.ttsrAlerts || [])[0];
if (recentAlert && Date.now() - Date.parse(recentAlert.timestamp || 0) < 120_000) {
  trayItems.push(fgHex(T.accent, `⚠ rule:${recentAlert.rule}`));
}

const latestNote = (pluginState.advisorNotes || [])[0];
if (latestNote && Date.now() - Date.parse(latestNote.timestamp || 0) < 180_000) {
  const nCol = latestNote.severity === "blocker" ? T.red : latestNote.severity === "concern" ? T.accent : T.cyan;
  trayItems.push(fgHex(nCol, `i advisor:${latestNote.severity}`));
}

// Lightweight memory count badge when workspace has curated memories
let memCount = 0;
try {
  memCount = memoryRecall({ query: "", limit: 50, cwd: git.root || cwd, dataDir }).totalFound;
} catch {
  // ignore
}
if (memCount > 0 && trayItems.length > 0) {
  trayItems.push(fgHex(T.teal, `✦ ${memCount} mem`));
}

const outLines = [];
if (trayItems.length > 0) {
  const sep = fgHex(T.borderMuted, "  │  ");
  outLines.push(truncVis(" " + trayItems.join(sep), width));
}
outLines.push(mainRow);

process.stdout.write(outLines.join("\n") + "\n");
