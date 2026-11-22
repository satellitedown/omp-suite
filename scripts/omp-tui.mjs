#!/usr/bin/env node
/**
 * OMP Suite — Sanctioned Newest-OMP (v19 / Tern) Terminal UI for Antigravity CLI
 *
 * Drives the official `agy acp --stdio` Agent Client Protocol server over stdio
 * (zero OAuth interception, zero private API proxying — 100% sanctioned ACP client).
 *
 * Usage:
 *   node scripts/omp-tui.mjs               # Live interactive session backed by `agy acp --stdio`
 *   node scripts/omp-tui.mjs --demo        # Interactive visual showcase of the OMP v19 / Tern UI
 *   node scripts/omp-tui.mjs --snapshot    # Render one non-interactive ANSI frame and exit
 *   node scripts/omp-tui.mjs --title "Fix Auth" --cwd /path/to/repo
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { OMP_DARK_THEME as T, getSessionAccentHex, fgHex } from "./lib/session-color.mjs";
import { resolveDataDir, readState, getGitTelemetry } from "./lib/state.mjs";
import { scanConflicts } from "./lib/virtual-fs.mjs";
import { memoryRecall } from "./lib/memory-bank.mjs";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Parse CLI args
const cliArgs = {
  demo: false,
  snapshot: false,
  cwd: process.cwd(),
  title: "",
  model: "",
  agent: "",
  sandbox: false,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--demo") cliArgs.demo = true;
  else if (a === "--snapshot") cliArgs.snapshot = true;
  else if (a === "--sandbox") cliArgs.sandbox = true;
  else if (a === "--cwd" && process.argv[i + 1]) cliArgs.cwd = path.resolve(process.argv[++i]);
  else if (a === "--title" && process.argv[i + 1]) cliArgs.title = process.argv[++i];
  else if (a === "--model" && process.argv[i + 1]) cliArgs.model = process.argv[++i];
  else if (a === "--agent" && process.argv[i + 1]) cliArgs.agent = process.argv[++i];
  else if (a === "-h" || a === "--help") {
    console.log(`OMP Suite Terminal UI (sanctioned agy acp client)

Usage:
  omp-tui [options]

Options:
  --cwd <dir>       Workspace directory (default: current directory)
  --title <name>    Session title (derives OKLCH accent color for statusline frame)
  --agent <name>    Antigravity agent profile passed to \`agy acp --agent\`
  --sandbox         Enable Antigravity terminal sandbox
  --demo            Interactive preview of the newest OMP v19 / Tern UI
  --snapshot        Print one non-interactive ANSI frame and exit

Keybindings:
  Enter             Send prompt (or run /command)
  Ctrl+O            Toggle expanded / collapsed tool cards
  Ctrl+L            Redraw screen
  Esc               Cancel active turn
  Ctrl+C / Ctrl+D   Quit

Slash commands:
  /title <name>     Rename session & recompute OKLCH accent frame color
  /model [id]       List or switch ACP models
  /hud              Insert a live OMP HUD summary card
  /expand           Toggle tool card expansion
  /clear            Clear transcript
  /help             Show shortcuts & commands
  /quit             Exit`);
    process.exit(0);
  }
}

const DATA_DIR = resolveDataDir();
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function visLen(str) {
  return str.replace(ANSI_RE, "").length;
}

function padVis(str, width) {
  const len = visLen(str);
  return len >= width ? str : str + " ".repeat(width - len);
}

function truncVis(str, maxWidth) {
  if (visLen(str) <= maxWidth) return str;
  const plain = str.replace(ANSI_RE, "");
  return plain.slice(0, Math.max(0, maxWidth - 1)) + "…";
}

function wrapPlain(text, width) {
  const w = Math.max(20, width);
  const out = [];
  for (const rawLine of String(text || "").split("\n")) {
    if (rawLine.length <= w) {
      out.push(rawLine);
      continue;
    }
    let idx = 0;
    while (idx < rawLine.length) {
      out.push(rawLine.slice(idx, idx + w));
      idx += w;
    }
  }
  return out;
}

function styleMarkdownLine(line) {
  if (/^#{1,3}\s+/.test(line)) {
    return BOLD + fgHex(T.accent, line.replace(/^#{1,3}\s+/, "")) + RESET;
  }
  let out = line.replace(/`([^`]+)`/g, (_, code) => fgHex(T.lavender, code));
  if (/^\s*[-*]\s+/.test(out)) {
    return out.replace(/^(\s*)([-*])(\s+)/, (_, s, _b, sp) => s + fgHex(T.accent, "•") + sp);
  }
  if (/^\s*\d+\.\s+/.test(out)) {
    return out.replace(/^(\s*)(\d+\.)(\s+)/, (_, s, n, sp) => s + fgHex(T.cyan, n) + sp);
  }
  return out;
}

function renderOmpToolCard({ title, status = "ok", sections = [], expanded = false, width = 88 }) {
  const w = Math.max(40, width);
  const innerW = w - 4;
  const icon =
    status === "ok"
      ? fgHex(T.green, "✓")
      : status === "error"
        ? fgHex(T.red, "✕")
        : status === "proposed"
          ? fgHex(T.accent, "◆")
          : fgHex(T.cyan, "●");

  const border = (s) => fgHex(T.borderMuted, s);
  const hdrLabel = ` ${icon} ${BOLD}${fgHex(T.textBright, title)}${RESET} `;
  const topDash = Math.max(1, w - 3 - visLen(hdrLabel));
  const lines = [border("┌─") + hdrLabel + border("─".repeat(topDash) + "┐")];

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];
    if (sec.label) {
      const subLbl = ` ${fgHex(T.muted, sec.label)} `;
      const subDash = Math.max(1, w - 4 - visLen(subLbl));
      lines.push(border("├─") + subLbl + border("─".repeat(subDash) + "┤"));
    }
    const rawLines = wrapPlain(sec.body || "", innerW);
    const isDiff = sec.diff || rawLines.some((l) => l.startsWith("@@ ") || l.startsWith("--- "));
    const maxLines = expanded ? rawLines.length : (sec.maxLines ?? 6);
    const shown = rawLines.slice(0, maxLines);
    for (const l of shown) {
      let styled = l;
      if (isDiff && l.startsWith("+") && !l.startsWith("+++")) styled = fgHex(T.green, l);
      else if (isDiff && l.startsWith("-") && !l.startsWith("---")) styled = fgHex(T.red, l);
      else if (isDiff && l.startsWith("@@")) styled = fgHex(T.cyan, l);
      else styled = fgHex(T.foreground, l);
      lines.push(border("│ ") + padVis(styled, innerW) + border(" │"));
    }
    if (!expanded && rawLines.length > maxLines) {
      const more = fgHex(T.dim, `… ${rawLines.length - maxLines} more lines (Ctrl+O for more)`);
      lines.push(border("│ ") + padVis(more, innerW) + border(" │"));
    }
  }

  lines.push(border("└" + "─".repeat(w - 2) + "┘"));
  return lines;
}

function renderCallout({ kind = "advisor", title, body, width = 88 }) {
  const color = kind === "ttsr" ? T.accent : kind === "blocker" ? T.red : T.cyan;
  const prefix = kind === "ttsr" ? "⚠" : "i";
  const lines = [fgHex(color, `${prefix} ${BOLD}${title}${RESET}`)];
  for (const l of wrapPlain(body, width - 4)) {
    lines.push(fgHex(color, "│ ") + fgHex(T.foreground, l));
  }
  return lines;
}

function renderStatusFrameTop({ model, effort, project, git, usedTokens, maxTokens, sessionTitle, accentHex, width }) {
  const w = Math.max(50, width);
  const pct = maxTokens > 0 ? ((usedTokens / maxTokens) * 100).toFixed(1) : "0.0";
  const maxLabel = maxTokens >= 1_000_000 ? `${Math.round(maxTokens / 1_000_000)}M` : `${Math.round(maxTokens / 1000)}K`;

  const gitStr = git?.isGitRepo
    ? (() => {
        const dirty = (git.staged || 0) + (git.modified || 0) + (git.untracked || 0);
        const col = dirty > 0 ? T.gitDirty : T.gitClean;
        const bits = [`⎇ ${git.branch || "HEAD"}`];
        if (git.staged) bits.push(`*${git.staged}`);
        if (git.modified) bits.push(`~${git.modified}`);
        if (git.untracked) bits.push(`+${git.untracked}`);
        if (git.conflicts) bits.push(`⚠${git.conflicts}`);
        return fgHex(col, bits.join(" "));
      })()
    : fgHex(T.dim, "no-git");

  const left = [
    fgHex("#38bdf8", `${BOLD}π${RESET}`),
    fgHex(T.dim, "❯"),
    fgHex(T.cyan, `⚙ ${model}`) + fgHex(T.purple, ` · ● ${effort}`),
    fgHex(T.textBright, `📁 ${project}`),
    gitStr,
    fgHex(T.contextBar, `◫ ${pct}%/${maxLabel} ✦`),
  ].join("  ");

  const leftLen = visLen(left);
  const maxRightLen = Math.max(8, w - 10 - leftLen);
  const fittedTitle = sessionTitle.length > maxRightLen ? sessionTitle.slice(0, maxRightLen - 1) + "…" : sessionTitle;
  const right = fgHex(accentHex, `${BOLD}${fittedTitle}${RESET}`);
  const rightLen = visLen(right);
  const availDash = w - 8 - leftLen - rightLen;

  if (availDash >= 2) {
    return (
      fgHex(accentHex, "╭─ ") +
      left +
      " " +
      fgHex(accentHex, "─".repeat(availDash)) +
      " " +
      right +
      fgHex(accentHex, " ─╮")
    );
  }
  const compact = truncVis(left, w - 6);
  return fgHex(accentHex, "╭─ ") + padVis(compact, w - 6) + fgHex(accentHex, " ─╮");
}

function renderTernTray({ pluginState, conflicts, memoriesCount, activeTools, width }) {
  const staged = Object.values(pluginState.stagedCodemods || {}).filter((c) => c.status === "proposed");
  const diags = Object.values(pluginState.diagnostics || {}).flat();
  const activeDap = Object.values(pluginState.dapSessions || {}).filter((d) => d.status !== "terminated");
  const notes = pluginState.advisorNotes || [];

  const pills = [];
  if (activeTools.length > 0) {
    pills.push(fgHex(T.cyan, `● running: ${activeTools.map((t) => t.title).join(", ")}`));
  }
  if (staged.length > 0) {
    pills.push(fgHex(T.accent, `◆ AST: ${staged.length} proposed (${staged[0].totalReplacements} hits)`));
  }
  if (activeDap.length > 0) {
    pills.push(fgHex(T.purple, `◉ DAP: ${activeDap[0].sessionId} :${activeDap[0].line}`));
  }
  if (conflicts.length > 0) {
    pills.push(fgHex(T.red, `⚠ conflicts: ${conflicts.length}`));
  }
  pills.push(diags.length > 0 ? fgHex(T.red, `✕ diag: ${diags.length}`) : fgHex(T.green, `✓ diag: 0`));
  pills.push(fgHex(T.teal, `✦ mem: ${memoriesCount}`));
  if (notes.length > 0) {
    pills.push(fgHex(T.accent, `i advisor: ${notes[0].severity}`));
  }
  const line = " " + pills.join(fgHex(T.borderMuted, "  │  "));
  return truncVis(line, width);
}

// --- Application State ---
const gitInit = getGitTelemetry(cliArgs.cwd);
const app = {
  cwd: gitInit.root || cliArgs.cwd,
  git: gitInit,
  sessionId: null,
  sessionTitle: cliArgs.title || gitInit.projectName || path.basename(cliArgs.cwd),
  model: cliArgs.model || "Gemini 4 Neon",
  effort: "high",
  availableModels: [],
  usedTokens: 0,
  contextWindow: 1048576,
  expandedTools: false,
  busy: false,
  busyLabel: "",
  busyStartMs: 0,
  spinIdx: 0,
  inputBuf: "",
  transcript: [],
  liveAssistantText: "",
  liveThoughtText: "",
  activeTools: new Map(),
  pendingPermission: null,
  acpProc: null,
  acpNextId: 1,
  acpPending: new Map(),
  acpBuf: "",
};

function populateDemoTranscript() {
  app.sessionTitle = cliArgs.title || "Migrate console.log & Debug xorshift32";
  app.usedTokens = 44200;
  app.transcript = [
    {
      type: "user",
      text: "Use ast_edit to migrate console.log($X) → logger.debug($X), inspect the active DAP frame, and check Advisor notes.",
    },
    {
      type: "tool",
      title: "AST Edit: console.log($X) (proposed)",
      status: "proposed",
      sections: [
        {
          label: "Preview · 3 replacements · 1 file",
          body: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -14,3 +14,3 @@\n-  console.log('token refreshed', uid);\n+  logger.debug('token refreshed', uid);",
        },
      ],
    },
    {
      type: "tool",
      title: "Accept: 3 replacements in 1 file (AST Edit)",
      status: "ok",
      sections: [{ body: "Applied 3 replacements atomically in src/auth.ts (SHA-256 verified)." }],
    },
    {
      type: "tool",
      title: "Debug variables",
      status: "ok",
      sections: [
        {
          label: "Session",
          body: "Session debug-1\nAdapter: python-bdb (dap-compat)\nStatus: stopped\nFrame: xorshift32\nLocation: demo.py:6",
        },
        {
          label: "Output",
          body: "Variables:\n- x = 57351 (int)\n- mask = 0xffffffff (int)",
        },
      ],
    },
    {
      type: "callout",
      kind: "ttsr",
      title: "TTSR Injecting rule: no-hardcoded-secrets",
      body: "Blocked write containing token pattern before touching disk. Load credentials from environment variables.",
    },
    {
      type: "callout",
      kind: "advisor",
      title: "Advisor 1 note",
      body: "(concern) Scoped catch to ENOENT; double-check whether callers also expect EACCES to return an empty object.",
    },
    {
      type: "assistant",
      text: "Applied `logger.debug($X)` cleanly and verified `x: 7 → 57351` at `demo.py:6`.\n- All post-edit diagnostics are clean (`0 errors`).\n- Retained architecture decision in project SQLite memory bank.",
    },
  ];
}

function buildFrame() {
  const cols = Math.max(60, process.stdout.columns || 100);
  const rows = Math.max(18, process.stdout.rows || 30);
  const accentHex = getSessionAccentHex(app.sessionTitle);
  const pluginState = readState(DATA_DIR);
  const conflicts = scanConflicts(app.cwd);
  const { memories } = memoryRecall({ query: "", limit: 20, cwd: app.cwd, dataDir: DATA_DIR });

  const bodyLines = [];

  for (const item of app.transcript) {
    if (item.type === "user") {
      bodyLines.push("");
      for (const l of wrapPlain(item.text, cols - 4)) {
        bodyLines.push(fgHex(accentHex, "▎ ") + BOLD + fgHex(T.textBright, l) + RESET);
      }
      bodyLines.push("");
    } else if (item.type === "assistant") {
      for (const l of wrapPlain(item.text, cols - 2)) {
        bodyLines.push(" " + styleMarkdownLine(l));
      }
      bodyLines.push("");
    } else if (item.type === "tool") {
      bodyLines.push(
        ...renderOmpToolCard({
          title: item.title,
          status: item.status,
          sections: item.sections,
          expanded: app.expandedTools,
          width: cols - 2,
        }).map((l) => " " + l)
      );
      bodyLines.push("");
    } else if (item.type === "callout") {
      bodyLines.push(
        ...renderCallout({
          kind: item.kind,
          title: item.title,
          body: item.body,
          width: cols - 2,
        }).map((l) => " " + l)
      );
      bodyLines.push("");
    }
  }

  if (app.liveThoughtText) {
    const preview = app.liveThoughtText.trim().split("\n").slice(-2).join(" ");
    bodyLines.push(" " + ITALIC + fgHex(T.muted, `⋮ ${truncVis(preview, cols - 6)}`) + RESET);
  }
  if (app.liveAssistantText) {
    for (const l of wrapPlain(app.liveAssistantText, cols - 2)) {
      bodyLines.push(" " + styleMarkdownLine(l));
    }
  }

  // Footer area: optional permission banner + working row + Tern tray + signature rounded composer
  const footerLines = [];

  if (app.pendingPermission) {
    const p = app.pendingPermission;
    footerLines.push(
      ...renderOmpToolCard({
        title: `Permission Required: ${p.title}`,
        status: "proposed",
        sections: [{ body: `${p.detail}\nPress [y] Allow once   [a] Always allow   [n] Deny` }],
        expanded: true,
        width: cols - 2,
      }).map((l) => " " + l)
    );
  }

  if (app.busy) {
    const secs = ((Date.now() - app.busyStartMs) / 1000).toFixed(1);
    const spin = fgHex(accentHex, SPINNER[app.spinIdx % SPINNER.length]);
    footerLines.push(` ${spin} ${fgHex(T.muted, `${app.busyLabel || "thinking"} · ${secs}s`)} ${fgHex(T.dim, "<esc>")}`);
  }

  footerLines.push(
    renderTernTray({
      pluginState,
      conflicts,
      memoriesCount: memories.length,
      activeTools: [...app.activeTools.values()],
      width: cols,
    })
  );

  // Signature OMP v19 Rounded Composer Frame
  footerLines.push(
    renderStatusFrameTop({
      model: app.model,
      effort: app.effort,
      project: app.git.projectName || path.basename(app.cwd),
      git: app.git,
      usedTokens: app.usedTokens,
      maxTokens: app.contextWindow,
      sessionTitle: app.sessionTitle,
      accentHex,
      width: cols,
    })
  );

  const promptPrefix = fgHex(accentHex, "│ ") + fgHex(T.cyan, "❯ ");
  const promptMax = cols - 6;
  const shownInput =
    app.inputBuf.length > 0
      ? fgHex(T.textBright, truncVis(app.inputBuf, promptMax - 1)) + fgHex(accentHex, "█")
      : fgHex(T.dim, app.demo ? "Demo mode — try /title New Name, /hud, Ctrl+O, or /quit" : "Ask Antigravity… (/help, /model, /hud, Ctrl+O)");
  footerLines.push(promptPrefix + padVis(shownInput, promptMax) + fgHex(accentHex, " │"));
  footerLines.push(fgHex(accentHex, "╰" + "─".repeat(Math.max(2, cols - 2)) + "╯"));

  if (cliArgs.snapshot) {
    return [...bodyLines, ...footerLines].join("\n");
  }

  const maxBodyRows = Math.max(4, rows - footerLines.length - 1);
  const visibleBody = bodyLines.slice(-maxBodyRows);
  while (visibleBody.length < maxBodyRows) visibleBody.unshift("");

  return [...visibleBody, ...footerLines].join("\n");
}

function renderScreen() {
  if (cliArgs.snapshot) {
    process.stdout.write(buildFrame() + "\n");
    return;
  }
  process.stdout.write(SYNC_START + "\x1b[2J\x1b[H" + buildFrame() + SYNC_END);
}

// --- Official `agy acp --stdio` JSON-RPC Client ---
function sendAcp(msg) {
  if (!app.acpProc || app.acpProc.killed) return;
  app.acpProc.stdin.write(JSON.stringify(msg) + "\n");
}

function acpRequest(method, params) {
  const id = app.acpNextId++;
  return new Promise((resolve, reject) => {
    app.acpPending.set(id, { resolve, reject });
    sendAcp({ jsonrpc: "2.0", id, method, params });
  });
}

function handleAcpMessage(msg) {
  if (msg.id !== undefined && app.acpPending.has(msg.id)) {
    const { resolve, reject } = app.acpPending.get(msg.id);
    app.acpPending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }

  // Host capability requests from `agy acp`
  if (msg.id !== undefined && msg.method) {
    if (msg.method === "fs/read_text_file") {
      try {
        const content = fs.readFileSync(msg.params.path, "utf8");
        sendAcp({ jsonrpc: "2.0", id: msg.id, result: { content } });
      } catch (err) {
        sendAcp({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } });
      }
      return;
    }
    if (msg.method === "fs/write_text_file") {
      try {
        fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
        fs.writeFileSync(msg.params.path, msg.params.content, "utf8");
        sendAcp({ jsonrpc: "2.0", id: msg.id, result: {} });
      } catch (err) {
        sendAcp({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } });
      }
      return;
    }
    if (msg.method === "session/request_permission") {
      const toolCall = msg.params?.toolCall || {};
      const options = msg.params?.options || [];
      app.pendingPermission = {
        rpcId: msg.id,
        title: toolCall.title || toolCall.kind || "Tool Action",
        detail: JSON.stringify(toolCall.rawInput || toolCall.locations || {}).slice(0, 180),
        options,
      };
      renderScreen();
      return;
    }
    sendAcp({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported client method: ${msg.method}` } });
    return;
  }

  // Notifications from `agy acp`
  if (msg.method === "session/update") {
    const upd = msg.params?.update || {};
    const kind = upd.sessionUpdate;
    if (kind === "usage_update") {
      if (typeof upd.used === "number") app.usedTokens = upd.used;
      if (typeof upd.size === "number") app.contextWindow = upd.size;
    } else if (kind === "agent_thought_chunk") {
      app.liveThoughtText += upd.content?.text || "";
      app.busyLabel = "thinking";
    } else if (kind === "agent_message_chunk") {
      app.liveThoughtText = "";
      app.liveAssistantText += upd.content?.text || "";
      app.busyLabel = "streaming";
    } else if (kind === "tool_call") {
      const id = upd.toolCallId || `tc-${Date.now()}`;
      app.activeTools.set(id, {
        id,
        title: upd.title || upd.kind || "tool",
        status: "running",
        body: "",
      });
      app.busyLabel = upd.title || "running tool";
    } else if (kind === "tool_call_update") {
      const id = upd.toolCallId;
      const existing = app.activeTools.get(id) || { id, title: upd.title || "tool", body: "" };
      if (upd.title) existing.title = upd.title;
      const chunkText = (upd.content || [])
        .map((c) => c.content?.text || c.text || "")
        .filter(Boolean)
        .join("\n");
      if (chunkText) existing.body = chunkText;
      if (upd.status === "completed" || upd.status === "failed") {
        app.activeTools.delete(id);
        app.transcript.push({
          type: "tool",
          title: existing.title,
          status: upd.status === "failed" ? "error" : "ok",
          sections: existing.body ? [{ label: "Output", body: existing.body }] : [],
        });
      } else {
        app.activeTools.set(id, existing);
      }
    }
    renderScreen();
  }
}

async function startAcp() {
  const args = ["acp", "--stdio"];
  if (cliArgs.agent) args.push("--agent", cliArgs.agent);
  if (cliArgs.sandbox) args.push("--sandbox");

  app.acpProc = spawn("agy", args, { cwd: app.cwd, stdio: ["pipe", "pipe", "pipe"] });
  app.acpProc.stdout.on("data", (chunk) => {
    app.acpBuf += chunk.toString("utf8");
    const lines = app.acpBuf.split("\n");
    app.acpBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleAcpMessage(JSON.parse(line));
      } catch {
        // ignore non-JSON
      }
    }
  });
  app.acpProc.on("exit", (code) => {
    app.busy = false;
    app.transcript.push({
      type: "callout",
      kind: "blocker",
      title: `agy acp exited (code ${code})`,
      body: "Press Ctrl+C or type /quit to exit.",
    });
    renderScreen();
  });

  await acpRequest("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "omp-suite-tui", version: "1.0.0" },
  });

  const sess = await acpRequest("session/new", { cwd: app.cwd, mcpServers: [] });
  app.sessionId = sess.sessionId;
  if (sess.models?.availableModels) {
    app.availableModels = sess.models.availableModels;
    const cur = sess.models.availableModels.find((m) => m.modelId === sess.models.currentModelId) || sess.models.availableModels[0];
    if (cur) app.model = cur.name || cur.modelId;
  }
  app.transcript.push({
    type: "callout",
    kind: "advisor",
    title: "Connected to official Antigravity ACP Server",
    body: `Session ${app.sessionId.slice(0, 8)} · ${app.model} · Type a prompt or /help.`,
  });
  renderScreen();
}

async function submitPrompt(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  // Built-in local TUI slash commands
  if (trimmed === "/quit" || trimmed === "/exit") {
    shutdown();
    return;
  }
  if (trimmed === "/clear") {
    app.transcript = [];
    renderScreen();
    return;
  }
  if (trimmed === "/expand") {
    app.expandedTools = !app.expandedTools;
    renderScreen();
    return;
  }
  if (trimmed.startsWith("/title ")) {
    app.sessionTitle = trimmed.slice(7).trim() || app.sessionTitle;
    renderScreen();
    return;
  }
  if (trimmed === "/hud") {
    const st = readState(DATA_DIR);
    app.git = getGitTelemetry(app.cwd);
    const diags = Object.values(st.diagnostics || {}).flat();
    const staged = Object.values(st.stagedCodemods || {}).filter((c) => c.status === "proposed");
    app.transcript.push({
      type: "tool",
      title: "OMP Live HUD Snapshot",
      status: "ok",
      sections: [
        {
          label: "Workspace",
          body: `Path: ${app.cwd}\nBranch: ${app.git.branch || "none"}\nDiagnostics: ${diags.length}\nStaged AST Codemods: ${staged.length}\nRecent Tools: ${(st.recentTools || []).length}`,
        },
      ],
    });
    renderScreen();
    return;
  }
  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    const target = trimmed.slice(6).trim();
    if (!target) {
      app.transcript.push({
        type: "tool",
        title: "Available Antigravity Models",
        status: "ok",
        sections: [
          {
            body: app.availableModels.length
              ? app.availableModels.map((m) => `- ${m.modelId} (${m.name})`).join("\n")
              : "No ACP models loaded (demo mode).",
          },
        ],
      });
      renderScreen();
      return;
    }
    if (app.sessionId) {
      try {
        await acpRequest("session/set_model", { sessionId: app.sessionId, modelId: target });
        app.model = target;
      } catch (err) {
        app.transcript.push({ type: "callout", kind: "blocker", title: "Model switch failed", body: err.message });
      }
      renderScreen();
      return;
    }
  }
  if (trimmed === "/help") {
    app.transcript.push({
      type: "tool",
      title: "OMP Suite TUI Controls",
      status: "ok",
      sections: [
        {
          body: "/title <name>  Set session title & OKLCH frame accent\n/model [id]    List or switch Antigravity models\n/hud           Show live OMP HUD card\n/expand        Toggle expanded tool cards (Ctrl+O)\n/clear         Clear transcript\n/quit          Exit cleanly\nEsc            Cancel running turn",
        },
      ],
    });
    renderScreen();
    return;
  }

  app.transcript.push({ type: "user", text: trimmed });
  if (cliArgs.demo) {
    app.transcript.push({
      type: "assistant",
      text: `Demo mode received: \`${trimmed}\`. Run without \`--demo\` to stream live turns from \`agy acp --stdio\`.`,
    });
    renderScreen();
    return;
  }

  app.busy = true;
  app.busyStartMs = Date.now();
  app.busyLabel = "thinking";
  app.liveAssistantText = "";
  app.liveThoughtText = "";
  renderScreen();

  try {
    await acpRequest("session/prompt", {
      sessionId: app.sessionId,
      prompt: [{ type: "text", text: trimmed }],
    });
    if (app.liveAssistantText.trim()) {
      app.transcript.push({ type: "assistant", text: app.liveAssistantText.trim() });
    }
  } catch (err) {
    app.transcript.push({ type: "callout", kind: "blocker", title: "ACP Prompt Error", body: err.message });
  } finally {
    app.liveAssistantText = "";
    app.liveThoughtText = "";
    app.busy = false;
    app.git = getGitTelemetry(app.cwd);
    renderScreen();
  }
}

function shutdown() {
  try {
    if (app.acpProc) app.acpProc.kill();
  } catch {
    // ignore
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?1049l\x1b[?25h");
  }
  process.exit(0);
}

// --- Entrypoint ---
if (cliArgs.snapshot) {
  populateDemoTranscript();
  renderScreen();
  process.exit(0);
}

if (cliArgs.demo) {
  populateDemoTranscript();
}

if (process.stdin.isTTY) {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const spinTimer = setInterval(() => {
    if (app.busy) {
      app.spinIdx++;
      renderScreen();
    }
  }, 120);
  spinTimer.unref();

  process.stdout.on("resize", renderScreen);

  process.stdin.on("data", (key) => {
    // Handle permission prompt keys first
    if (app.pendingPermission) {
      const p = app.pendingPermission;
      const lower = key.toLowerCase();
      if (lower === "y" || lower === "a" || lower === "n") {
        const allowOpt = p.options.find((o) => o.kind === (lower === "a" ? "allow_always" : "allow_once")) || p.options[0];
        const denyOpt = p.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always") || p.options[p.options.length - 1];
        const chosen = lower === "n" ? denyOpt : allowOpt;
        sendAcp({
          jsonrpc: "2.0",
          id: p.rpcId,
          result: { outcome: { outcome: "selected", optionId: chosen?.optionId || (lower === "n" ? "reject" : "allow") } },
        });
        app.pendingPermission = null;
        renderScreen();
      }
      return;
    }

    if (key === "\x03" || (key === "\x04" && app.inputBuf.length === 0)) {
      shutdown();
      return;
    }
    if (key === "\x0f") {
      // Ctrl+O toggle expand tool cards
      app.expandedTools = !app.expandedTools;
      renderScreen();
      return;
    }
    if (key === "\x0c") {
      // Ctrl+L redraw
      renderScreen();
      return;
    }
    if (key === "\x1b" && app.busy && app.sessionId) {
      // Esc cancels current turn
      sendAcp({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: app.sessionId } });
      return;
    }
    if (key === "\r" || key === "\n") {
      const line = app.inputBuf;
      app.inputBuf = "";
      void submitPrompt(line);
      return;
    }
    if (key === "\x7f" || key === "\b") {
      app.inputBuf = app.inputBuf.slice(0, -1);
      renderScreen();
      return;
    }
    // Ignore escape sequences (arrows/etc.) for clean editing
    if (key.startsWith("\x1b")) return;
    app.inputBuf += key;
    renderScreen();
  });

  renderScreen();
  if (!cliArgs.demo) {
    startAcp().catch((err) => {
      app.transcript.push({ type: "callout", kind: "blocker", title: "Failed to start agy acp", body: err.message });
      renderScreen();
    });
  }
} else {
  populateDemoTranscript();
  cliArgs.snapshot = true;
  renderScreen();
}
