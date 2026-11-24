#!/usr/bin/env node
/**
 * Native Tern Chatbox Surface for Google Antigravity (`agy`) — v1.3.0
 *
 * Frontend: Real Tern Surface Protocol (TSP v1) using Tern's exact `omp.session`
 * native layout (welcome lockup, user bubbles with copy action, collapsible
 * thinking sections, 60fps streaming Markdown, native collapsible `tool` cards,
 * `omp.editor` multiline chatbox with context hairline + clickable model, effort,
 * mode, usage, and send/stop controls, plus native `picker` & permission sheets).
 *
 * Backend: 100% official `agy acp --stdio` (Antigravity's documented Agent Client
 * Protocol server — zero OAuth interception, full omp-suite MCP/hooks/skills support).
 *
 * Outside Tern: seamlessly execs stock `agy` with all original arguments.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { TspSurfaceSession } from "./lib/tsp-client.mjs";
import { resolveDataDir, readState, getCachedGitTelemetry } from "./lib/state.mjs";
import { memoryRecall } from "./lib/memory-bank.mjs";
import { astResolve, astReject } from "./lib/ast-codemod.mjs";
import {
  readSessionTranscriptUsage,
  readTodayUsageSummary,
  formatTokenCount,
  formatRelativeTime,
  cycleEffortLevel,
  cycleModeId,
} from "./lib/usage-stats.mjs";

const RAW_ARGS = process.argv.slice(2);
const VERSION = "1.3.1";

// Parse lightweight flags while forwarding ACP-supported flags to `agy acp`
let cwd = process.cwd();
let agentFlag = "";
let sandboxFlag = false;
let skipPermsFlag = false;
let resumeContinue = false;
let conversationIdFlag = "";
let initialModelFlag = "";
let initialModeFlag = "";
let initialEffortFlag = "";
let addDirs = [];

for (let i = 0; i < RAW_ARGS.length; i++) {
  const a = RAW_ARGS[i];
  if (a === "--agent" && RAW_ARGS[i + 1]) agentFlag = RAW_ARGS[++i];
  else if (a === "--model" && RAW_ARGS[i + 1]) initialModelFlag = RAW_ARGS[++i];
  else if (a === "--mode" && RAW_ARGS[i + 1]) initialModeFlag = RAW_ARGS[++i];
  else if (a === "--effort" && RAW_ARGS[i + 1]) initialEffortFlag = RAW_ARGS[++i];
  else if (a === "--sandbox") sandboxFlag = true;
  else if (a === "--dangerously-skip-permissions") skipPermsFlag = true;
  else if (a === "-c" || a === "--continue") resumeContinue = true;
  else if ((a === "--conversation" || a === "--resume" || a === "-r") && RAW_ARGS[i + 1]) {
    conversationIdFlag = RAW_ARGS[++i];
  } else if (a === "--add-dir" && RAW_ARGS[i + 1]) addDirs.push(RAW_ARGS[++i]);
}

const DATA_DIR = resolveDataDir();
const gitInit = getCachedGitTelemetry(cwd, 500);
const WORKSPACE_DIR = gitInit.root || path.resolve(cwd);

const LOCAL_COMMANDS = [
  { name: "plan", description: "Toggle Plan mode, or run `/plan <task>` in Plan mode" },
  { name: "resume", description: "Open native picker to load a previous conversation" },
  { name: "usage", description: "Show context window fill, session tokens, cache hit %, and today's usage" },
  { name: "model", description: "Switch active Antigravity model (Ctrl+P)" },
  { name: "effort", description: "Switch model thinking level (low/medium/high/xhigh · Shift+Tab)" },
  { name: "mode", description: "Switch execution mode (default/accept-edits/auto/plan · Alt+M)" },
  { name: "hud", description: "Show OMP Suite live diagnostics, staged AST, DAP & memory summary" },
  { name: "clear", description: "Start a fresh Antigravity conversation" },
  { name: "help", description: "Show commands and keyboard shortcuts" },
  { name: "exit", description: "Close the Tern chatbox cleanly" },
];

const MODE_META = {
  default: { label: "default", tone: "muted" },
  "accept-edits": { label: "accept-edits", tone: "info" },
  auto: { label: "auto", tone: "success" },
  plan: { label: "plan", tone: "accent" },
};

const state = {
  sessionId: null,
  sessionTitle: "",
  connected: false,
  replaying: false,
  running: false,
  turnSeq: 0,
  runStartMs: 0,
  streamStartMs: 0,
  streamChars: 0,
  streamTokPerSec: null,
  workingLabel: "Thinking…",
  modelId: initialModelFlag || "",
  baseModelId: "",
  modelName: initialModelFlag || "Antigravity",
  effort: initialEffortFlag || "high",
  availableModels: [],
  availableBaseModels: [],
  availableEfforts: ["low", "medium", "high", "xhigh"],
  modeId: initialModeFlag || "default",
  previousNonPlanMode: initialModeFlag && initialModeFlag !== "plan" ? initialModeFlag : "default",
  availableModes: [
    { id: "default", name: "Default", description: "Ask before edits and commands, per your permission settings." },
    { id: "accept-edits", name: "Accept edits", description: "Approve file edits in the workspace without asking." },
    { id: "auto", name: "Auto", description: "Approve edits and safe commands; ask before irreversible actions." },
    { id: "plan", name: "Plan", description: "Plan carefully before executing a task." },
  ],
  availableCommands: [],
  planSteps: [],
  usedTokens: 0,
  contextWindow: 1048576,
  sessionUsage: readSessionTranscriptUsage(""),
  git: gitInit,
  draft: "",
  cursor: 0,
  undoStack: [],
  history: [],
  historyIdx: -1,
  entries: [], // { id, kind: "user"|"assistant"|"tool"|"notice", ... }
  activeAssistant: null,
  activeTools: new Map(),
  // Unified native Tern picker overlay: { kind, title, noun, placeholder, query, selected, items }
  picker: null,
  pendingPermission: null, // { rpcId, title, detail, options }
  stagedCodemodModal: null, // staged AST proposal id
  lastAlertKey: "",
};

let seqId = 1;
const nextId = (prefix) => `${prefix}.${seqId++}`;

// --- Helpers ---
function parseModelMeta(model) {
  const raw = String(model?.name || model?.modelId || "Antigravity");
  const m = raw.match(/\((low|medium|high|xhigh|max)\)\s*$/i);
  const effort = m ? m[1].toLowerCase() : "high";
  const label = raw.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, "").trim();
  const baseId = String(model?.modelId || raw).replace(/-(low|medium|high|xhigh|max)$/i, "");
  return { id: model?.modelId || raw, baseId, label, effort, fullName: raw };
}

function guessToolVisual(title = "", kind = "") {
  const lower = `${title} ${kind}`.toLowerCase();
  if (lower.includes("command") || lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) {
    return { name: "bash", targetKind: "command", lang: "bash" };
  }
  if (lower.includes("edit") || lower.includes("write") || lower.includes("hashline") || lower.includes("ast_")) {
    return { name: "edit", targetKind: "path" };
  }
  if (lower.includes("read") || lower.includes("view") || lower.includes("file ")) {
    return { name: "read", targetKind: "path" };
  }
  if (lower.includes("grep") || lower.includes("search") || lower.includes("find")) {
    return { name: "grep", targetKind: "pattern" };
  }
  if (lower.includes("dap") || lower.includes("debug")) {
    return { name: "debug", targetKind: "text" };
  }
  return { name: "mcp", targetKind: "text" };
}

function copyToClipboard(text) {
  if (!text) return;
  // OSC 52 works natively inside Tern and over SSH without disturbing TSP
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x1b\\`);
}

function renderProgressBar(frac, width = 18) {
  const clamped = Math.max(0, Math.min(1, Number(frac) || 0));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function refreshSessionUsage() {
  if (!state.sessionId) return;
  state.sessionUsage = readSessionTranscriptUsage(state.sessionId);
}

function syncConfigOptions(configOptions) {
  if (!Array.isArray(configOptions)) return;
  for (const opt of configOptions) {
    if (opt.id === "model" && Array.isArray(opt.options)) {
      state.availableBaseModels = opt.options.map((o) => ({ value: o.value, name: o.name }));
      if (opt.currentValue) {
        state.baseModelId = opt.currentValue;
        const found = opt.options.find((o) => o.value === opt.currentValue);
        if (found) state.modelName = found.name;
      }
    } else if (opt.id === "thought_level" && Array.isArray(opt.options)) {
      state.availableEfforts = opt.options.map((o) => String(o.value).toLowerCase());
      if (opt.currentValue) state.effort = String(opt.currentValue).toLowerCase();
    } else if (opt.id === "mode" && Array.isArray(opt.options)) {
      state.availableModes = opt.options.map((o) => ({
        id: o.value,
        name: o.name || o.value,
        description: o.description || "",
      }));
      if (opt.currentValue) {
        state.modeId = opt.currentValue;
        if (opt.currentValue !== "plan") state.previousNonPlanMode = opt.currentValue;
      }
    }
  }
}

function syncSessionMetadata(sess) {
  if (!sess) return;
  if (Array.isArray(sess.models?.availableModels)) {
    state.availableModels = sess.models.availableModels.map(parseModelMeta);
    const curId = sess.models.currentModelId;
    const cur = state.availableModels.find((m) => m.id === curId) || state.availableModels[0];
    if (cur) {
      state.modelId = cur.id;
      state.baseModelId = cur.baseId;
      state.modelName = cur.label;
      state.effort = cur.effort;
    }
  }
  if (sess.modes) {
    if (Array.isArray(sess.modes.availableModes) && sess.modes.availableModes.length > 0) {
      state.availableModes = sess.modes.availableModes;
    }
    if (sess.modes.currentModeId) {
      state.modeId = sess.modes.currentModeId;
      if (state.modeId !== "plan") state.previousNonPlanMode = state.modeId;
    }
  }
  if (Array.isArray(sess.configOptions)) {
    syncConfigOptions(sess.configOptions);
  }
}

// --- Build Exact Tern `omp.session` TSP Tree ---
function buildTspTree(tsp) {
  const supportsEffort = tsp.caps.kinds.has("effort");
  const supportsTool = tsp.caps.kinds.has("tool");
  const supportsPicker = tsp.caps.kinds.has("picker");
  const supportsRate = tsp.caps.kinds.has("rate");
  const pluginState = readState(DATA_DIR);
  const stagedList = Object.values(pluginState.stagedCodemods || {}).filter((c) => c.status === "proposed");
  const diagsList = Object.values(pluginState.diagnostics || {}).flat();
  const activeDaps = Object.values(pluginState.dapSessions || {}).filter((d) => d.status !== "terminated");
  const memoriesCount = (() => {
    try {
      return memoryRecall({ query: "", limit: 50, cwd: WORKSPACE_DIR, dataDir: DATA_DIR }).totalFound;
    } catch {
      return 0;
    }
  })();

  // 1. MAIN (Transcript)
  const main = [];

  // OMP Welcome Hero Card
  const subtitleParts = [`Antigravity ACP`, `v${VERSION}`, state.git.projectName || path.basename(WORKSPACE_DIR)];
  if (state.sessionTitle) subtitleParts.push(state.sessionTitle);

  main.push({
    id: "welcome",
    k: "card",
    p: { role: "omp.welcome" },
    c: [
      {
        id: "welcome.lockup",
        k: "row",
        p: { role: "omp.welcome.lockup", gap: "md", align: "center" },
        c: [
          {
            id: "welcome.logo",
            k: "image",
            p: { builtin: "omp", alt: "agy", w: 128, role: "omp.welcome.logo" },
          },
          {
            id: "welcome.meta",
            k: "col",
            p: { gap: "xs" },
            c: [
              {
                id: "welcome.wordmark",
                k: "text",
                p: { role: "omp.welcome.wordmark", wrap: "none", spans: [{ t: "agy · omp-suite", s: "strong" }] },
              },
              {
                id: "welcome.version",
                k: "text",
                p: {
                  role: "omp.welcome.version",
                  wrap: "none",
                  spans: [{ t: subtitleParts.join(" · "), s: "dim mono" }],
                },
              },
            ],
          },
        ],
      },
      {
        id: "welcome.tip",
        k: "row",
        p: { role: "omp.welcome.tip", gap: "sm", align: "start" },
        c: [
          { id: "welcome.tip.icon", k: "icon", p: { name: "lightbulb", role: "omp.welcome.tip-icon" } },
          {
            id: "welcome.tip.text",
            k: "text",
            p: {
              role: "omp.welcome.tip-text",
              wrap: "word",
              text: "Shift+Tab thinking · Alt+M mode · Ctrl+P models · /plan · /resume · /usage · /help · Tab on / for commands",
            },
          },
          { id: "welcome.tip.new", k: "shimmer", p: { text: `v${VERSION}`, role: "omp.welcome.new" } },
        ],
      },
    ],
  });

  // Render conversation transcript entries
  for (const ent of state.entries) {
    if (ent.kind === "user") {
      const userTools = [
        {
          id: `${ent.id}.copy`,
          k: "icon",
          p: {
            name: "copy",
            role: "omp.user.tool",
            title: "Copy message",
            aria: "Copy message",
            actions: { click: `copy.user:${ent.id}` },
          },
        },
      ];
      if (ent.time) {
        userTools.push(
          { id: `${ent.id}.dot`, k: "text", p: { text: "·" } },
          {
            id: `${ent.id}.time`,
            k: "text",
            p: { role: "omp.user.time", spans: [{ t: ent.time, s: "dim mono" }] },
          }
        );
      }
      main.push({
        id: ent.id,
        k: "card",
        p: { role: "omp.user", tone: "user" },
        c: [
          {
            id: `${ent.id}.tools`,
            k: "row",
            p: { role: "omp.user.tools", gap: "xs", align: "center" },
            c: userTools,
          },
          {
            id: `${ent.id}.md`,
            k: "md",
            p: { text: ent.text },
          },
        ],
      });
    } else if (ent.kind === "assistant") {
      const children = [];
      if (ent.thought) {
        // Fix: Tern `section.head` takes a string or a single TSP node, never a raw spans array.
        const thoughtHead = ent.thinkingLive
          ? {
              id: `${ent.id}.think.head`,
              k: "row",
              p: { gap: "sm", align: "center" },
              c: [
                { id: `${ent.id}.think.spin`, k: "spinner", p: { style: "starburst" } },
                { id: `${ent.id}.think.lbl`, k: "shimmer", p: { text: "Thinking…" } },
                { id: `${ent.id}.think.el`, k: "elapsed", p: { age: 0, format: "short" } },
              ],
            }
          : `Thought${ent.thoughtMs >= 500 ? ` for ${Math.max(1, Math.round(ent.thoughtMs / 1000))}s` : ""}`;
        children.push({
          id: `${ent.id}.think`,
          k: "section",
          p: {
            role: "omp.thinking",
            head: thoughtHead,
            collapsible: true,
            collapsed: ent.thoughtCollapsed ?? !ent.thinkingLive,
          },
          c: [{ id: `${ent.id}.think.md`, k: "md", p: { text: ent.thought, stream: ent.thinkingLive } }],
        });
      }
      if (ent.text) {
        children.push({
          id: `${ent.id}.md`,
          k: "md",
          p: { text: ent.text, stream: ent.streaming },
        });
      }
      if (children.length > 0) {
        main.push({
          id: ent.id,
          k: "col",
          p: { role: "omp.assistant", gap: "sm" },
          c: children,
        });
      }
    } else if (ent.kind === "tool") {
      const vis = guessToolVisual(ent.title, ent.toolKind);
      const bodyChildren = [];
      if (ent.output) {
        const isDiff = ent.output.includes("\n@@ ") || ent.output.startsWith("--- ");
        bodyChildren.push(
          isDiff
            ? { id: `${ent.id}.out`, k: "diff", p: { text: ent.output.slice(0, 12000), mode: "unified" } }
            : { id: `${ent.id}.out`, k: "ansi", p: { text: ent.output.slice(0, 12000), preview: { lines: 8 } } }
        );
      }
      if (supportsTool) {
        main.push({
          id: ent.id,
          k: "tool",
          p: {
            name: vis.name,
            title: ent.title,
            target: ent.target || undefined,
            targetKind: ent.target ? vis.targetKind : undefined,
            status: ent.status,
            age: ent.status === "running" ? Math.max(0, Date.now() - ent.startMs) : undefined,
            took: ent.status !== "running" && ent.tookMs > 0 ? ent.tookMs : undefined,
            frame: "card",
            collapsible: true,
            collapsed: ent.collapsed,
            preview: { lines: 6 },
          },
          c: bodyChildren,
        });
      } else {
        main.push({
          id: ent.id,
          k: "card",
          p: {
            head: ent.title,
            status: ent.status,
            collapsible: true,
            collapsed: ent.collapsed,
          },
          c: bodyChildren,
        });
      }
    } else if (ent.kind === "notice") {
      main.push({
        id: ent.id,
        k: "card",
        p: {
          role: "omp.advisor",
          tone: ent.tone || "info",
          head: ent.title,
        },
        c: [{ id: `${ent.id}.body`, k: "md", p: { text: ent.body } }],
      });
    }
  }

  // 2. DOCK (Optional Plan Checklist + Live Working HUD + Native `omp.editor` Chatbox Composer)
  const dock = [];

  if (state.planSteps.length > 0) {
    const doneCount = state.planSteps.filter((s) => s.status === "completed" || s.status === "done").length;
    const activeStep = state.planSteps.find((s) => s.status === "in_progress");
    const stepText = activeStep
      ? `${doneCount}/${state.planSteps.length} · ${activeStep.content || activeStep.title || ""}`
      : `Plan checklist: ${doneCount}/${state.planSteps.length} complete`;
    dock.push({
      id: "hud.plan",
      k: "row",
      p: { role: "omp.hud.todo", gap: "sm", align: "center" },
      c: [
        { id: "hud.plan.badge", k: "badge", p: { text: "PLAN", tone: "accent" } },
        { id: "hud.plan.text", k: "text", p: { wrap: "none", spans: [{ t: stepText, s: "muted" }] } },
      ],
    });
  }

  // Live Working / Activity HUD Row above composer
  const hudChildren = [];
  if (state.running) {
    hudChildren.push({
      id: "hud.spin",
      k: "spinner",
      p: { style: "starburst", label: state.workingLabel || "Thinking…" },
    });
    hudChildren.push({
      id: `hud.elapsed.${state.turnSeq}`,
      k: "elapsed",
      p: { age: 0, format: "short" },
    });
  }
  if (stagedList.length > 0) {
    hudChildren.push({
      id: "hud.ast",
      k: "button",
      p: {
        text: `AST: ${stagedList[0].totalReplacements} proposed`,
        icon: "diff",
        size: "sm",
        variant: "default",
        tone: "warning",
        actions: { click: "open.ast" },
      },
    });
  }
  if (activeDaps.length > 0) {
    hudChildren.push({
      id: "hud.dap",
      k: "badge",
      p: { text: `DAP ${activeDaps[0].frame || activeDaps[0].sessionId}:${activeDaps[0].line}`, tone: "accent" },
    });
  }
  if (diagsList.length > 0) {
    hudChildren.push({
      id: "hud.diag",
      k: "badge",
      p: { text: `${diagsList.length} diag`, tone: "error" },
    });
  }
  if (hudChildren.length > 0) {
    dock.push({
      id: "hud",
      k: "row",
      p: { role: "omp.hud", gap: "sm", align: "center" },
      c: hudChildren,
    });
  }

  // Context Hairline Meter across the top of the composer
  const ctxFrac = state.contextWindow > 0 ? Math.min(1, state.usedTokens / state.contextWindow) : 0;
  const ctxPctText = `${(ctxFrac * 100).toFixed(1)}%`;
  const ctxMaxLabel =
    state.contextWindow >= 1_000_000
      ? `${(state.contextWindow / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
      : `${Math.round(state.contextWindow / 1000)}K`;
  const sessTotal = state.sessionUsage.totalTokens || 0;
  const ctxTooltipLines = [
    `Context ${ctxPctText} (${state.usedTokens.toLocaleString()} / ${state.contextWindow.toLocaleString()} tokens)`,
  ];
  if (sessTotal > 0) {
    ctxTooltipLines.push(
      `Session: ${formatTokenCount(state.sessionUsage.inputTokens)} in · ${formatTokenCount(state.sessionUsage.outputTokens)} out · ${formatTokenCount(state.sessionUsage.cacheReadTokens)} cached (${state.sessionUsage.cacheHitPct.toFixed(0)}% hit)`
    );
  }

  const composerContext = {
    id: "composer.context",
    k: "meter",
    p: {
      role: "omp.composer.context",
      style: "bar",
      size: "sm",
      value: ctxFrac,
      thresholds: { warn: 0.7, bad: 0.88 },
      title: ctxTooltipLines.join("\n"),
    },
  };

  // Composer Input Line (leading `plan` chip when in plan mode + REAL native Tern `editor`)
  const lineChildren = [];
  if (state.modeId === "plan") {
    lineChildren.push({
      id: "composer.plan.chip",
      k: "row",
      p: {
        role: "omp.composer.mode",
        tone: "accent",
        gap: "xs",
        align: "center",
        title: "Plan mode active — click or run /plan to toggle (Alt+M cycles modes)",
        actions: { click: "mode.toggle_plan" },
      },
      c: [{ id: "composer.plan.label", k: "text", p: { wrap: "none", spans: [{ t: "plan", s: "accent strong" }] } }],
    });
  }
  lineChildren.push({
    id: "composer.input",
    k: "editor",
    p: {
      text: state.draft,
      cursor: state.cursor,
      sendable: !state.running && state.connected,
      placeholder: !state.connected
        ? "Connecting to official Antigravity ACP server…"
        : state.modeId === "plan"
          ? "Describe what to plan… (/plan to exit · Shift+Tab thinking · /help)"
          : "Ask Antigravity… (/plan, /resume, /usage, /help · Shift+Tab thinking)",
      maxLines: 10,
    },
  });

  const composerLine = {
    id: "composer.line",
    k: "row",
    p: { role: "omp.composer.line", align: "start", gap: "sm" },
    c: lineChildren,
  };

  // Composer Action Bar: Model + Effort glyph, Mode pill, live tok/s rate, Git & Usage facts, Send/Stop
  const modelChipChildren = [
    supportsEffort
      ? {
          id: "composer.effort.glyph",
          k: "effort",
          p: {
            level: state.effort,
            role: "omp.composer.model.effort",
            title: `Thinking effort: ${state.effort} (click or Shift+Tab to cycle)`,
            actions: { click: "thinking.cycle" },
          },
        }
      : { id: "composer.model.icon", k: "icon", p: { name: "model" } },
    {
      id: "composer.model.name",
      k: "text",
      p: {
        wrap: "none",
        spans: supportsEffort
          ? [{ t: state.modelName, s: "strong" }]
          : [
              { t: state.modelName, s: "strong" },
              { t: ` · ${state.effort}`, s: "muted" },
            ],
      },
    },
    { id: "composer.model.chev", k: "icon", p: { name: "chev" } },
  ];

  const modeMeta = MODE_META[state.modeId] || { label: state.modeId, tone: "muted" };
  const modePill = {
    id: "composer.mode.pill",
    k: "badge",
    p: {
      text: modeMeta.label,
      tone: modeMeta.tone,
      title: `Mode: ${modeMeta.label} — click or press Alt+M to cycle (/plan, /mode)`,
      actions: { click: "mode.cycle" },
    },
  };

  const factSegs = [];
  if (state.git.isGitRepo) {
    const dirty = state.git.staged + state.git.modified + state.git.untracked;
    const gText = `${state.git.branch}${dirty ? ` *${state.git.staged} ~${state.git.modified} +${state.git.untracked}` : ""}`;
    factSegs.push({
      id: "fact.git",
      k: "seg",
      p: {
        role: "omp.composer.fact",
        icon: "git",
        priority: 4,
        tone: dirty > 0 ? "warning" : "success",
        spans: [{ t: gText, s: dirty > 0 ? "warning" : "success" }],
      },
    });
  }

  const usageLabel =
    sessTotal > 0 ? `${ctxPctText}/${ctxMaxLabel} · ${formatTokenCount(sessTotal)} tok` : `${ctxPctText}/${ctxMaxLabel}`;
  factSegs.push({
    id: "fact.usage",
    k: "seg",
    p: {
      role: "omp.composer.fact",
      priority: 5,
      title: `${ctxTooltipLines.join("\n")}\nClick for full /usage breakdown`,
      actions: { click: "open.usage" },
      spans: [{ t: usageLabel, s: ctxFrac > 0.85 ? "error" : ctxFrac > 0.7 ? "warning" : "dim" }],
    },
  });

  if (memoriesCount > 0) {
    factSegs.push({
      id: "fact.mem",
      k: "seg",
      p: {
        role: "omp.composer.fact",
        priority: 2,
        spans: [{ t: `✦ ${memoriesCount} mem`, s: "info dim" }],
      },
    });
  }

  const submitControl = state.running
    ? {
        id: "composer.stop",
        k: "text",
        p: {
          role: "omp.composer.stop",
          text: "Stop",
          tone: "error",
          title: "Stop active turn (Esc)",
          actions: { click: "interrupt" },
        },
      }
    : {
        id: "composer.send",
        k: "kbd",
        p: {
          role: "omp.composer.send",
          keys: ["enter"],
          title: "Send message (Enter)",
          actions: { click: "submit" },
        },
      };

  const barChildren = [
    {
      id: "composer.model",
      k: "row",
      p: {
        role: "omp.composer.model",
        gap: "xs",
        align: "center",
        title: `Switch Antigravity model (Ctrl+P / /model) · Thinking: ${state.effort} (Shift+Tab)`,
        actions: { click: "status.model" },
      },
      c: modelChipChildren,
    },
    modePill,
  ];

  if (state.running && state.streamTokPerSec !== null && supportsRate) {
    barChildren.push({
      id: "composer.rate",
      k: "rate",
      p: {
        value: state.streamTokPerSec,
        unit: "tok/s",
        role: "omp.composer.rate",
        title: "Estimated live generation rate",
      },
    });
  }

  barChildren.push(
    {
      id: "composer.facts",
      k: "status",
      p: { role: "omp.composer.facts", transparent: true, grow: 1 },
      c: factSegs,
    },
    submitControl
  );

  const composerBar = {
    id: "composer.bar",
    k: "row",
    p: { role: "omp.composer.bar", gap: "sm", align: "center" },
    c: barChildren,
  };

  dock.push({
    id: "composer",
    k: "col",
    p: {
      role: "omp.editor",
      tone: state.running ? "pending" : state.modeId === "plan" ? "accent" : undefined,
    },
    c: [composerContext, composerLine, composerBar],
  });

  // 3. LAYER (Native Tern Modal Sheets: Unified Picker, Permission Prompt, Staged AST Codemod)
  const layer = [];

  if (state.picker && supportsPicker) {
    const pk = state.picker;
    const filtered = getFilteredPickerItems(pk);
    const selected = filtered.some((item) => item.id === pk.selected)
      ? pk.selected
      : filtered[0]?.id ?? null;
    pk.selected = selected;

    layer.push({
      id: "picker.active",
      k: "picker",
      p: {
        title: pk.title,
        noun: pk.noun,
        anchor: "composer",
        size: pk.size || "md",
        density: "snug",
        query: pk.query,
        placeholder: pk.placeholder || "Filter…",
        items: filtered.map((item) => ({
          id: item.id,
          label: item.label,
          detail: item.detail,
          mono: Boolean(item.mono),
          chips: item.chips,
        })),
        selected,
        current: pk.currentId ? [pk.currentId] : [],
        total: pk.items.length,
        actions: [
          { id: "apply", label: pk.applyLabel || "Select", keys: ["enter"], primary: true },
          { id: "close", label: "Close", keys: ["escape"], end: true },
        ],
      },
    });
  }

  if (state.pendingPermission) {
    const perm = state.pendingPermission;
    layer.push({
      id: "overlay.perm",
      k: "overlay",
      p: { anchor: "bottom", size: "md", modal: true, head: `Permission · ${perm.title}` },
      c: [
        {
          id: "overlay.perm.body",
          k: "col",
          p: { gap: "sm" },
          c: [
            { id: "overlay.perm.detail", k: "code", p: { text: perm.detail, lang: "json" } },
            {
              id: "overlay.perm.btns",
              k: "row",
              p: { gap: "sm", justify: "end" },
              c: [
                {
                  id: "perm.deny",
                  k: "button",
                  p: { text: "Deny", keys: ["n"], variant: "danger", actions: { click: "perm.deny" } },
                },
                {
                  id: "perm.always",
                  k: "button",
                  p: { text: "Always allow", keys: ["a"], variant: "default", actions: { click: "perm.always" } },
                },
                {
                  id: "perm.allow",
                  k: "button",
                  p: { text: "Allow once", keys: ["y"], variant: "primary", actions: { click: "perm.allow" } },
                },
              ],
            },
          ],
        },
      ],
    });
  }

  if (state.stagedCodemodModal) {
    const prop = pluginState.stagedCodemods?.[state.stagedCodemodModal];
    if (prop && prop.status === "proposed") {
      layer.push({
        id: "overlay.ast",
        k: "overlay",
        p: { anchor: "center", size: "lg", modal: true, head: `Staged AST Codemod · ${prop.pattern} → ${prop.rewrite}` },
        c: [
          {
            id: "overlay.ast.col",
            k: "col",
            p: { gap: "sm" },
            c: [
              {
                id: "overlay.ast.diff",
                k: "diff",
                p: { text: prop.files?.[0]?.diff || "(no diff)", mode: "unified" },
              },
              {
                id: "overlay.ast.btns",
                k: "row",
                p: { gap: "sm", justify: "end" },
                c: [
                  { id: "ast.close", k: "button", p: { text: "Close", variant: "quiet", actions: { click: "ast.close" } } },
                  { id: "ast.reject", k: "button", p: { text: "Reject", variant: "danger", actions: { click: "ast.reject" } } },
                  { id: "ast.accept", k: "button", p: { text: "Accept & Apply", variant: "primary", actions: { click: "ast.accept" } } },
                ],
              },
            ],
          },
        ],
      });
    } else {
      state.stagedCodemodModal = null;
    }
  }

  return { main, dock, layer };
}

function getFilteredPickerItems(pk) {
  const q = (pk.query || "").trim().toLowerCase();
  if (!q) return pk.items;
  return pk.items.filter((item) => {
    const hay = `${item.label || ""} ${item.detail || ""} ${item.search || ""} ${item.id || ""}`.toLowerCase();
    return hay.includes(q);
  });
}

// --- Official `agy acp --stdio` Bridge ---
let acpProc = null;
let acpSeq = 1;
const acpPending = new Map();
let acpBuf = "";
let tspSession = null;

function render() {
  if (!tspSession) return;
  const focusId = state.picker || state.pendingPermission || state.stagedCodemodModal ? null : "composer.input";
  tspSession.render(buildTspTree(tspSession), focusId);
}

function scheduleStreamRender() {
  if (!tspSession) return;
  tspSession.scheduleRender(() => render(), 16);
}

function sendAcp(msg) {
  if (!acpProc || acpProc.killed) return;
  acpProc.stdin.write(JSON.stringify(msg) + "\n");
}

function acpRequest(method, params) {
  const id = acpSeq++;
  return new Promise((resolve, reject) => {
    acpPending.set(id, { resolve, reject });
    sendAcp({ jsonrpc: "2.0", id, method, params });
  });
}

function settleActiveAssistant() {
  if (!state.activeAssistant) return;
  state.activeAssistant.streaming = false;
  if (state.activeAssistant.thinkingLive) {
    state.activeAssistant.thinkingLive = false;
    state.activeAssistant.thoughtMs = Math.max(0, Date.now() - state.activeAssistant.thoughtStartMs);
    state.activeAssistant.thoughtCollapsed = true;
  }
  state.activeAssistant = null;
}

function settleAllRunningState() {
  settleActiveAssistant();
  const now = Date.now();
  for (const ent of state.entries) {
    if (ent.kind === "assistant") {
      ent.streaming = false;
      if (ent.thinkingLive) {
        ent.thinkingLive = false;
        ent.thoughtMs = Math.max(0, now - (ent.thoughtStartMs || now));
        ent.thoughtCollapsed = true;
      }
    } else if (ent.kind === "tool" && ent.status === "running") {
      ent.status = "done";
      ent.tookMs = state.replaying ? 0 : Math.max(0, now - (ent.startMs || now));
      ent.collapsed = true;
    }
  }
  state.activeTools.clear();
  state.running = false;
  state.streamTokPerSec = null;
  state.workingLabel = "";
  tspSession?.setProgress(false);
}

function updateStreamRate(chunkLen) {
  if (!state.running || state.replaying || !chunkLen) return;
  const now = Date.now();
  if (!state.streamStartMs) state.streamStartMs = now;
  state.streamChars += chunkLen;
  const elapsedSec = (now - state.streamStartMs) / 1000;
  if (elapsedSec >= 0.35) {
    state.streamTokPerSec = Math.max(1, Math.round(state.streamChars / 4 / elapsedSec));
  }
}

function handleAcpMessage(msg) {
  if (msg.id !== undefined && acpPending.has(msg.id)) {
    const { resolve, reject } = acpPending.get(msg.id);
    acpPending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }

  // Server -> Client capability requests
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
      const tc = msg.params?.toolCall || {};
      state.pendingPermission = {
        rpcId: msg.id,
        title: tc.title || tc.kind || "Tool Action",
        detail: JSON.stringify(tc.rawInput || tc.locations || {}, null, 2).slice(0, 1200),
        options: msg.params?.options || [],
      };
      render();
      return;
    }
    sendAcp({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported method: ${msg.method}` } });
    return;
  }

  // Notifications
  if (msg.method === "session/update") {
    const upd = msg.params?.update || {};
    const kind = upd.sessionUpdate;

    if (kind === "usage_update") {
      if (typeof upd.used === "number") state.usedTokens = upd.used;
      if (typeof upd.size === "number") state.contextWindow = upd.size;
      refreshSessionUsage();
      render();
      return;
    }

    if (kind === "current_mode_update") {
      if (upd.currentModeId) {
        state.modeId = upd.currentModeId;
        if (state.modeId !== "plan") state.previousNonPlanMode = state.modeId;
        render();
      }
      return;
    }

    if (kind === "config_option_update") {
      syncConfigOptions(upd.configOptions);
      render();
      return;
    }

    if (kind === "available_commands_update") {
      if (Array.isArray(upd.availableCommands)) {
        state.availableCommands = upd.availableCommands;
      }
      return;
    }

    if (kind === "session_info_update") {
      if (upd.title) {
        state.sessionTitle = upd.title;
        render();
      }
      return;
    }

    if (kind === "plan") {
      state.planSteps = Array.isArray(upd.entries) ? upd.entries : [];
      render();
      return;
    }

    if (kind === "user_message_chunk") {
      // Replay user bubbles when loading an existing conversation via `session/load`
      if (!state.replaying) return;
      settleActiveAssistant();
      const chunk = upd.content?.text || "";
      if (!chunk) return;
      const last = state.entries[state.entries.length - 1];
      if (last && last.kind === "user" && last.replayed) {
        last.text += chunk;
      } else {
        state.entries.push({ id: nextId("usr"), kind: "user", text: chunk, time: "", replayed: true });
      }
      scheduleStreamRender();
      return;
    }

    if (kind === "agent_thought_chunk") {
      const chunk = upd.content?.text || "";
      if (!state.activeAssistant) {
        state.activeAssistant = {
          id: nextId("asst"),
          kind: "assistant",
          thought: "",
          thoughtStartMs: Date.now(),
          thoughtMs: 0,
          thinkingLive: !state.replaying,
          thoughtCollapsed: state.replaying,
          text: "",
          streaming: !state.replaying,
        };
        state.entries.push(state.activeAssistant);
      }
      state.activeAssistant.thought += chunk;
      if (!state.replaying) {
        state.workingLabel = "Thinking…";
        updateStreamRate(chunk.length);
      }
      scheduleStreamRender();
      return;
    }

    if (kind === "agent_message_chunk") {
      const chunk = upd.content?.text || "";
      if (!state.activeAssistant) {
        state.activeAssistant = {
          id: nextId("asst"),
          kind: "assistant",
          thought: "",
          thoughtStartMs: Date.now(),
          thoughtMs: 0,
          thinkingLive: false,
          thoughtCollapsed: true,
          text: "",
          streaming: !state.replaying,
        };
        state.entries.push(state.activeAssistant);
      }
      if (state.activeAssistant.thinkingLive) {
        state.activeAssistant.thinkingLive = false;
        state.activeAssistant.thoughtMs = Date.now() - state.activeAssistant.thoughtStartMs;
        state.activeAssistant.thoughtCollapsed = true;
      }
      state.activeAssistant.text += chunk;
      if (!state.replaying) {
        state.workingLabel = "Streaming…";
        updateStreamRate(chunk.length);
      }
      scheduleStreamRender();
      return;
    }

    if (kind === "tool_call") {
      settleActiveAssistant();
      const tcId = upd.toolCallId || nextId("tc");
      const rawIn = upd.rawInput || upd.args || {};
      const target = rawIn.CommandLine || rawIn.Path || rawIn.filePath || rawIn.pattern || rawIn.uri || "";
      const rawStatus = String(upd.status || "").toLowerCase();
      const isTerminalFail = rawStatus === "failed" || rawStatus === "error" || rawStatus === "cancelled" || rawStatus === "canceled";
      const isTerminalOk = rawStatus === "completed" || rawStatus === "done" || rawStatus === "succeeded";
      const initialStatus = isTerminalFail ? "error" : isTerminalOk ? "done" : "running";
      const chunkText = (upd.content || [])
        .map((c) => c.content?.text || c.text || "")
        .filter(Boolean)
        .join("\n");
      const ent = {
        id: nextId("tool"),
        tcId,
        kind: "tool",
        toolKind: upd.kind || "",
        title: upd.title || upd.name || upd.kind || "Tool",
        target: String(target).slice(0, 120),
        status: initialStatus,
        startMs: Date.now(),
        tookMs: 0,
        output: chunkText,
        collapsed: initialStatus === "done",
      };
      if (initialStatus === "running") {
        state.activeTools.set(tcId, ent);
        if (!state.replaying) state.workingLabel = ent.title;
      }
      state.entries.push(ent);
      if (state.replaying) scheduleStreamRender();
      else render();
      return;
    }

    if (kind === "tool_call_update") {
      const tcId = upd.toolCallId;
      const ent = state.activeTools.get(tcId) || state.entries.find((e) => e.kind === "tool" && e.tcId === tcId);
      if (!ent) return;
      if (upd.title) ent.title = upd.title;
      const chunkText = (upd.content || [])
        .map((c) => c.content?.text || c.text || "")
        .filter(Boolean)
        .join("\n");
      if (chunkText) ent.output = chunkText;
      const updStatus = String(upd.status || "").toLowerCase();
      if (["completed", "done", "succeeded", "failed", "error", "cancelled", "canceled"].includes(updStatus)) {
        const failed = updStatus === "failed" || updStatus === "error" || updStatus === "cancelled" || updStatus === "canceled";
        ent.status = failed ? "error" : "done";
        ent.tookMs = state.replaying ? 0 : Date.now() - ent.startMs;
        ent.collapsed = !failed;
        state.activeTools.delete(tcId);
        if (!state.replaying) state.git = getCachedGitTelemetry(WORKSPACE_DIR, 500);
      }
      if (state.replaying) scheduleStreamRender();
      else render();
    }
  }
}

function answerPermission(choice) {
  const perm = state.pendingPermission;
  if (!perm) return;
  const opts = perm.options || [];
  let chosen;
  if (choice === "deny") {
    chosen = opts.find((o) => o.kind === "reject_once" || o.kind === "reject_always") || opts[opts.length - 1];
  } else if (choice === "always") {
    chosen = opts.find((o) => o.kind === "allow_always") || opts[0];
  } else {
    chosen = opts.find((o) => o.kind === "allow_once") || opts[0];
  }
  sendAcp({
    jsonrpc: "2.0",
    id: perm.rpcId,
    result: { outcome: { outcome: "selected", optionId: chosen?.optionId || (choice === "deny" ? "reject" : "allow") } },
  });
  state.pendingPermission = null;
  render();
}

// --- Official ACP Control Actions (Model, Effort, Mode, Resume) ---
async function switchModel(modelId) {
  const found = state.availableModels.find((m) => m.id === modelId);
  if (!found || !state.sessionId) return;
  try {
    await acpRequest("session/set_model", { sessionId: state.sessionId, modelId: found.id });
    state.modelId = found.id;
    state.baseModelId = found.baseId;
    state.modelName = found.label;
    state.effort = found.effort;
  } catch (err) {
    state.entries.push({ id: nextId("n"), kind: "notice", tone: "error", title: "Model switch failed", body: err.message });
  }
  state.picker = null;
  render();
}

async function setEffort(level, { announce = false } = {}) {
  const target = String(level || "").toLowerCase();
  if (!target || !state.sessionId) return;
  try {
    const res = await acpRequest("session/set_config_option", {
      sessionId: state.sessionId,
      configId: "thought_level",
      value: target,
    });
    if (Array.isArray(res?.configOptions)) {
      syncConfigOptions(res.configOptions);
    } else {
      state.effort = target;
    }
    if (announce) {
      state.entries.push({
        id: nextId("eff"),
        kind: "notice",
        tone: "info",
        title: `Thinking level → ${state.effort}`,
        body: `Active model: **${state.modelName}** (\`${state.effort}\`). Press \`Shift+Tab\` anytime to cycle.`,
      });
    }
  } catch {
    // Fallback: match same base model with target effort via session/set_model
    const alt = state.availableModels.find(
      (m) => m.label.toLowerCase() === state.modelName.toLowerCase() && m.effort === target
    );
    if (alt) {
      await switchModel(alt.id);
      return;
    }
    state.entries.push({
      id: nextId("efferr"),
      kind: "notice",
      tone: "warning",
      title: `Thinking level "${target}" unavailable`,
      body: `Available levels for **${state.modelName}**: ${state.availableEfforts.map((e) => `\`${e}\``).join(", ")}`,
    });
  }
  state.picker = null;
  render();
}

async function cycleEffort() {
  if (!state.connected || !state.sessionId) return;
  const next = cycleEffortLevel(state.effort, state.availableEfforts);
  await setEffort(next, { announce: false });
}

async function setMode(modeId, { announce = false } = {}) {
  const target = String(modeId || "").toLowerCase();
  if (!target || !state.sessionId) return;
  try {
    await acpRequest("session/set_mode", { sessionId: state.sessionId, modeId: target });
    if (state.modeId !== "plan") state.previousNonPlanMode = state.modeId;
    state.modeId = target;
    if (target !== "plan") state.previousNonPlanMode = target;
    if (announce) {
      const m = state.availableModes.find((x) => x.id === target);
      state.entries.push({
        id: nextId("mode"),
        kind: "notice",
        tone: target === "plan" ? "accent" : "info",
        title: `Mode → ${m?.name || target}`,
        body: m?.description || `Execution mode set to \`${target}\`.`,
      });
    }
  } catch (err) {
    state.entries.push({ id: nextId("modeerr"), kind: "notice", tone: "error", title: "Mode switch failed", body: err.message });
  }
  state.picker = null;
  render();
}

async function cycleMode() {
  if (!state.connected || !state.sessionId) return;
  const modeIds = state.availableModes.map((m) => m.id);
  const next = cycleModeId(state.modeId, modeIds);
  await setMode(next, { announce: false });
}

async function loadConversation(sessionId, targetCwd = WORKSPACE_DIR) {
  if (!sessionId) return false;
  state.picker = null;
  state.entries = [];
  state.activeAssistant = null;
  state.activeTools.clear();
  state.planSteps = [];
  state.sessionTitle = "";
  state.replaying = true;
  render();
  try {
    const sess = await acpRequest("session/load", {
      sessionId,
      cwd: targetCwd || WORKSPACE_DIR,
      mcpServers: [],
    });
    settleAllRunningState();
    state.replaying = false;
    state.sessionId = sess?.sessionId || sessionId;
    state.connected = true;
    syncSessionMetadata(sess);
    refreshSessionUsage();
    render();
    return true;
  } catch (err) {
    state.replaying = false;
    state.entries.push({
      id: nextId("loaderr"),
      kind: "notice",
      tone: "error",
      title: `Could not resume session ${sessionId.slice(0, 8)}`,
      body: err.message || String(err),
    });
    render();
    return false;
  }
}

// --- Native Picker Openers ---
function openModelPicker(initialQuery = "") {
  state.picker = {
    kind: "model",
    title: "Antigravity Models",
    noun: "models",
    placeholder: "Filter models…",
    query: initialQuery,
    selected: state.modelId || state.availableModels[0]?.id || null,
    currentId: state.modelId,
    applyLabel: "Select",
    items: state.availableModels.map((m) => ({
      id: m.id,
      label: m.label,
      detail: m.effort,
      search: m.fullName,
      chips: [{ text: m.effort, on: m.id === state.modelId }],
    })),
  };
  render();
}

function openModePicker() {
  state.picker = {
    kind: "mode",
    title: "Execution Mode (Alt+M)",
    noun: "modes",
    placeholder: "Filter modes…",
    query: "",
    selected: state.modeId,
    currentId: state.modeId,
    applyLabel: "Switch",
    items: state.availableModes.map((m) => ({
      id: m.id,
      label: m.name || m.id,
      detail: m.description || "",
      chips: [{ text: m.id, on: m.id === state.modeId }],
    })),
  };
  render();
}

function openEffortPicker() {
  state.picker = {
    kind: "effort",
    title: "Thinking Effort (Shift+Tab)",
    noun: "levels",
    placeholder: "Filter effort levels…",
    query: "",
    selected: state.effort,
    currentId: state.effort,
    applyLabel: "Set",
    items: state.availableEfforts.map((lv) => ({
      id: lv,
      label: lv.toUpperCase(),
      detail: lv === "xhigh" ? "Deepest reasoning budget" : lv === "high" ? "Strong reasoning" : lv === "medium" ? "Balanced speed & depth" : "Fastest response",
      chips: [{ text: lv, on: lv === state.effort }],
    })),
  };
  render();
}

async function openResumePicker(initialQuery = "") {
  if (!state.connected) return;
  try {
    const res = await acpRequest("session/list", {});
    const raw = Array.isArray(res?.sessions) ? res.sessions : [];
    const sorted = [...raw].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    if (sorted.length === 0) {
      state.entries.push({
        id: nextId("nores"),
        kind: "notice",
        tone: "info",
        title: "No previous conversations found",
        body: "Start chatting here and your session will appear in `/resume`.",
      });
      render();
      return;
    }
    state.picker = {
      kind: "resume",
      title: "Resume Conversation (/resume)",
      noun: "conversations",
      size: "lg",
      placeholder: "Search by title, workspace, or ID…",
      query: initialQuery,
      selected: sorted[0]?.sessionId || null,
      currentId: state.sessionId,
      applyLabel: "Resume",
      items: sorted.map((s) => {
        const folder = s.cwd ? path.basename(s.cwd) : "";
        const rel = formatRelativeTime(s.updatedAt);
        const sameCwd = s.cwd && path.resolve(s.cwd) === path.resolve(WORKSPACE_DIR);
        return {
          id: s.sessionId,
          label: s.title || s.sessionId.slice(0, 12),
          detail: [folder, rel, s.sessionId.slice(0, 8)].filter(Boolean).join(" · "),
          search: `${s.title || ""} ${s.cwd || ""} ${s.sessionId}`,
          cwd: s.cwd || WORKSPACE_DIR,
          chips: sameCwd ? [{ text: "here", on: true }] : folder ? [{ text: folder, on: false }] : undefined,
        };
      }),
    };
    render();
  } catch (err) {
    state.entries.push({
      id: nextId("reserr"),
      kind: "notice",
      tone: "error",
      title: "Could not list conversations",
      body: err.message || String(err),
    });
    render();
  }
}

function openCommandPicker(initialQuery = "") {
  const seen = new Set();
  const items = [];
  for (const c of LOCAL_COMMANDS) {
    seen.add(c.name);
    items.push({
      id: `/${c.name}`,
      label: `/${c.name}`,
      detail: c.description,
      mono: true,
      chips: [{ text: "ui", on: true }],
    });
  }
  for (const c of state.availableCommands) {
    if (!c?.name || seen.has(c.name)) continue;
    seen.add(c.name);
    items.push({
      id: `/${c.name}`,
      label: `/${c.name}`,
      detail: String(c.description || "").slice(0, 96),
      mono: true,
      chips: [{ text: "acp", on: false }],
    });
  }
  state.picker = {
    kind: "command",
    title: "Slash Commands & Skills",
    noun: "commands",
    size: "lg",
    placeholder: "Filter commands…",
    query: initialQuery,
    selected: items[0]?.id || null,
    applyLabel: "Run / Insert",
    items,
  };
  render();
}

async function activatePickerItem(itemId) {
  const pk = state.picker;
  if (!pk || !itemId) return;
  const item = pk.items.find((x) => x.id === itemId);
  if (pk.kind === "model") {
    await switchModel(itemId);
  } else if (pk.kind === "mode") {
    await setMode(itemId, { announce: true });
  } else if (pk.kind === "effort") {
    await setEffort(itemId, { announce: true });
  } else if (pk.kind === "resume") {
    await loadConversation(itemId, item?.cwd || WORKSPACE_DIR);
  } else if (pk.kind === "command") {
    state.picker = null;
    const immediateLocal = new Set(["/resume", "/usage", "/model", "/effort", "/mode", "/hud", "/clear", "/help", "/exit", "/plan"]);
    if (immediateLocal.has(itemId)) {
      state.draft = "";
      state.cursor = 0;
      render();
      await submitText(itemId);
    } else {
      state.draft = `${itemId} `;
      state.cursor = state.draft.length;
      render();
    }
  }
}

// --- Rich Usage & Help Cards ---
function showUsageCard() {
  refreshSessionUsage();
  const u = state.sessionUsage;
  const today = readTodayUsageSummary();
  const ctxFrac = state.contextWindow > 0 ? Math.min(1, state.usedTokens / state.contextWindow) : 0;
  const ctxPct = (ctxFrac * 100).toFixed(1);
  const bar = renderProgressBar(ctxFrac, 20);

  const lines = [
    `**Context Window**: \`[${bar}]\` **${ctxPct}%** (${state.usedTokens.toLocaleString()} / ${state.contextWindow.toLocaleString()} tokens)`,
    `**Active**: \`${state.modelName}\` · effort \`${state.effort}\` · mode \`${state.modeId}\``,
    "",
    "#### This Session (Local Antigravity Transcript)",
  ];

  if (u.turns > 0) {
    lines.push(
      `- **Turns**: ${u.turns} · **Total**: **${formatTokenCount(u.totalTokens)}** tokens`,
      `- **Input**: ${formatTokenCount(u.inputTokens)} · **Output**: ${formatTokenCount(u.outputTokens)} · **Cache Read**: ${formatTokenCount(u.cacheReadTokens)} (**${u.cacheHitPct.toFixed(1)}%** cache hit)`
    );
    const modelRows = Object.entries(u.byModel);
    if (modelRows.length > 0) {
      lines.push("", "| Model | Turns | Input | Output | Cached |", "| :--- | ---: | ---: | ---: | ---: |");
      for (const [m, st] of modelRows) {
        lines.push(
          `| \`${m}\` | ${st.turns} | ${formatTokenCount(st.inputTokens)} | ${formatTokenCount(st.outputTokens)} | ${formatTokenCount(st.cacheReadTokens)} |`
        );
      }
    }
  } else {
    lines.push("- *No completed model turns recorded in this session yet.*");
  }

  lines.push("", "#### Today Across Local Sessions");
  if (today.turns > 0) {
    lines.push(
      `- **Sessions**: ${today.sessionsCount} · **Turns**: ${today.turns} · **Total**: **${formatTokenCount(today.totalTokens)}** tokens`,
      `- **Input**: ${formatTokenCount(today.inputTokens)} · **Output**: ${formatTokenCount(today.outputTokens)} · **Cache Read**: ${formatTokenCount(today.cacheReadTokens)} (**${today.cacheHitPct.toFixed(1)}%** cache hit)`
    );
  } else {
    lines.push("- *No local turns recorded today yet.*");
  }

  state.entries.push({
    id: nextId("usage"),
    kind: "notice",
    tone: "info",
    title: `Usage & Context · ${state.sessionTitle || state.git.projectName || "Session"}`,
    body: lines.join("\n"),
  });
  render();
}

function showHelpCard() {
  const acpCmdNames = state.availableCommands.slice(0, 14).map((c) => `\`/${c.name}\``).join(", ");
  const lines = [
    "#### Keyboard Shortcuts",
    "- `Shift+Tab` — cycle thinking effort (`low` → `medium` → `high` → `xhigh`)",
    "- `Alt+M` — cycle execution mode (`default` → `accept-edits` → `auto` → `plan`)",
    "- `Ctrl+P` — open Model Picker · `Tab` on `/` — open Slash Command Picker",
    "- `Shift+Enter` — insert newline · `Esc` — stop active turn / close overlay",
    "- `agy -raw` / `agy --raw` (from shell) — launch stock `agy` bypassing `omp-suite` UI & hooks",
    "",
    "#### Built-In Commands",
    "- `/plan [task]` — toggle Plan mode, or run `/plan <task>` directly in Plan mode",
    "- `/resume` (`/switch`) — open native conversation picker (`session/list` + `session/load`)",
    "- `/usage` (`/stats`, `/cost`) — show context fill, session token breakdown & today's local usage",
    "- `/model [query]` · `/effort [level]` · `/mode [mode]` · `/commands` · `/hud` · `/clear` · `/exit`",
  ];
  if (acpCmdNames) {
    lines.push("", "#### Official Antigravity ACP Commands & Skills", acpCmdNames);
  }
  state.entries.push({
    id: nextId("help"),
    kind: "notice",
    tone: "info",
    title: `OMP Suite Tern Chatbox · v${VERSION}`,
    body: lines.join("\n"),
  });
  render();
}

// --- Prompt Submission & Slash Command Router ---
async function submitText(rawText) {
  const text = rawText.trim();
  if (!text) return;

  state.history.push(text);
  if (state.history.length > 200) state.history.shift();
  state.historyIdx = -1;

  const lower = text.toLowerCase();

  if (lower === "/quit" || lower === "/exit") {
    shutdown(0);
    return;
  }
  if (lower === "/clear" || lower === "/new") {
    state.entries = [];
    state.activeAssistant = null;
    state.activeTools.clear();
    state.planSteps = [];
    state.sessionTitle = "";
    state.usedTokens = 0;
    state.sessionUsage = readSessionTranscriptUsage("");
    if (state.connected) {
      const sess = await acpRequest("session/new", { cwd: WORKSPACE_DIR, mcpServers: [] }).catch(() => null);
      if (sess?.sessionId) {
        state.sessionId = sess.sessionId;
        syncSessionMetadata(sess);
      }
    }
    render();
    return;
  }
  if (lower === "/help" || lower === "/?") {
    showHelpCard();
    return;
  }
  if (lower === "/commands") {
    openCommandPicker("");
    return;
  }
  if (lower === "/usage" || lower === "/stats" || lower === "/cost") {
    showUsageCard();
    return;
  }
  if (lower === "/resume" || lower === "/switch" || lower === "/conversation") {
    await openResumePicker("");
    return;
  }
  if (lower.startsWith("/resume ") || lower.startsWith("/switch ") || lower.startsWith("/conversation ")) {
    const arg = text.split(/\s+/).slice(1).join(" ").trim();
    if (/^[0-9a-f-]{32,36}$/i.test(arg)) {
      await loadConversation(arg, WORKSPACE_DIR);
    } else {
      await openResumePicker(arg);
    }
    return;
  }
  if (lower === "/model" || lower === "/models") {
    openModelPicker("");
    return;
  }
  if (lower.startsWith("/model ")) {
    const q = text.slice(7).trim().toLowerCase();
    const hit = state.availableModels.find((m) => m.id.toLowerCase() === q || m.fullName.toLowerCase().includes(q));
    if (hit) await switchModel(hit.id);
    else openModelPicker(q);
    return;
  }
  if (lower === "/effort" || lower === "/thinking") {
    openEffortPicker();
    return;
  }
  if (lower.startsWith("/effort ") || lower.startsWith("/thinking ")) {
    const arg = text.split(/\s+/)[1]?.trim().toLowerCase() || "";
    if (arg) await setEffort(arg, { announce: true });
    else openEffortPicker();
    return;
  }
  if (lower === "/mode") {
    openModePicker();
    return;
  }
  if (lower.startsWith("/mode ")) {
    const arg = text.split(/\s+/)[1]?.trim().toLowerCase() || "";
    if (arg) await setMode(arg, { announce: true });
    else openModePicker();
    return;
  }
  if (lower === "/plan") {
    const nextMode = state.modeId === "plan" ? state.previousNonPlanMode || "default" : "plan";
    await setMode(nextMode, { announce: true });
    return;
  }
  if (lower === "/hud") {
    refreshSessionUsage();
    const ps = readState(DATA_DIR);
    const staged = Object.values(ps.stagedCodemods || {}).filter((c) => c.status === "proposed");
    const diags = Object.values(ps.diagnostics || {}).flat();
    const daps = Object.values(ps.dapSessions || {}).filter((d) => d.status !== "terminated");
    const mems = memoryRecall({ query: "", limit: 20, cwd: WORKSPACE_DIR, dataDir: DATA_DIR }).totalFound;
    const ctxPct = state.contextWindow > 0 ? ((state.usedTokens / state.contextWindow) * 100).toFixed(1) : "0.0";
    state.entries.push({
      id: nextId("hudcard"),
      kind: "notice",
      tone: "info",
      title: `OMP Suite Live Status · ${state.git.projectName || path.basename(WORKSPACE_DIR)}`,
      body: [
        `- **Model**: \`${state.modelName}\` · **Effort**: \`${state.effort}\` · **Mode**: \`${state.modeId}\``,
        `- **Context**: ${ctxPct}% (${state.usedTokens.toLocaleString()} / ${state.contextWindow.toLocaleString()}) · **Session**: ${formatTokenCount(state.sessionUsage.totalTokens)} tok`,
        `- **Workspace**: \`${WORKSPACE_DIR}\` (\`${state.git.branch || "no-git"}\`)`,
        `- **Diagnostics**: ${diags.length} · **Staged AST**: ${staged.length} · **DAP**: ${daps.length} · **Memories**: ${mems}`,
      ].join("\n"),
    });
    render();
    return;
  }

  // `/plan <task>` switches to official ACP plan mode first, then submits to Antigravity ACP
  if (lower.startsWith("/plan ") && state.modeId !== "plan" && state.connected && state.sessionId) {
    await setMode("plan", { announce: false });
  }

  if (!state.connected || !state.sessionId || state.running) return;

  const now = new Date();
  const hhmm = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  state.entries.push({ id: nextId("usr"), kind: "user", text, time: hhmm });
  state.turnSeq += 1;
  state.running = true;
  state.runStartMs = Date.now();
  state.streamStartMs = 0;
  state.streamChars = 0;
  state.streamTokPerSec = null;
  state.workingLabel = state.modeId === "plan" ? "Planning…" : "Thinking…";
  state.activeAssistant = null;
  tspSession?.setProgress(true);
  render();

  try {
    const promptRes = await acpRequest("session/prompt", {
      sessionId: state.sessionId,
      prompt: [{ type: "text", text }],
    });
    if (promptRes?.usage && typeof promptRes.usage.totalTokens === "number") {
      state.usedTokens = Math.max(state.usedTokens, promptRes.usage.totalTokens);
    }
  } catch (err) {
    state.entries.push({
      id: nextId("err"),
      kind: "notice",
      tone: "error",
      title: "Antigravity ACP Error",
      body: err.message || String(err),
    });
  } finally {
    settleAllRunningState();
    state.git = getCachedGitTelemetry(WORKSPACE_DIR, 200);
    refreshSessionUsage();
    // Surface any newly recorded TTSR alert from hooks
    const ps = readState(DATA_DIR);
    const alert = ps.ttsrAlerts?.[0];
    if (alert && alert.timestamp !== state.lastAlertKey && Date.now() - Date.parse(alert.timestamp) < 15000) {
      state.lastAlertKey = alert.timestamp;
      state.entries.push({
        id: nextId("ttsr"),
        kind: "notice",
        tone: "warning",
        title: `⚠ TTSR Rule: ${alert.rule}`,
        body: alert.message,
      });
    }
    render();
  }
}

function pushUndo() {
  state.undoStack.push({ draft: state.draft, cursor: state.cursor });
  if (state.undoStack.length > 100) state.undoStack.shift();
}

function insertAtCursor(str) {
  pushUndo();
  state.draft = state.draft.slice(0, state.cursor) + str + state.draft.slice(state.cursor);
  state.cursor += str.length;
  render();
}

function handleKey(key) {
  // Permission modal shortcuts
  if (state.pendingPermission) {
    if (key.name === "y" || key.name === "enter") answerPermission("allow");
    else if (key.name === "a") answerPermission("always");
    else if (key.name === "n" || key.name === "escape") answerPermission("deny");
    return;
  }

  // Unified native picker navigation (models, resume, modes, effort, commands)
  if (state.picker) {
    const pk = state.picker;
    const list = getFilteredPickerItems(pk);
    const idx = Math.max(0, list.findIndex((item) => item.id === pk.selected));
    if (key.name === "escape") {
      state.picker = null;
      render();
    } else if (key.name === "up") {
      if (list.length) pk.selected = list[(idx - 1 + list.length) % list.length].id;
      render();
    } else if (key.name === "down") {
      if (list.length) pk.selected = list[(idx + 1) % list.length].id;
      render();
    } else if (key.name === "enter") {
      if (pk.selected) void activatePickerItem(pk.selected);
    } else if (key.name === "backspace") {
      pk.query = pk.query.slice(0, -1);
      render();
    } else if (key.text && !key.ctrl && !key.alt && !key.meta) {
      pk.query += key.text;
      render();
    }
    return;
  }

  // Option B: Shift+Tab cycles model thinking effort (`low` -> `medium` -> `high` -> `xhigh`)
  if (key.name === "tab" && key.shift) {
    void cycleEffort();
    return;
  }

  // Alt+M cycles execution modes (`default` -> `accept-edits` -> `auto` -> `plan`)
  if (key.alt && key.name === "m") {
    void cycleMode();
    return;
  }

  // Tab on a `/prefix` opens the interactive Slash Command Picker
  if (key.name === "tab" && !key.shift && !key.ctrl && !key.alt) {
    if (state.draft.startsWith("/") && !state.draft.includes(" ") && !state.draft.includes("\n")) {
      openCommandPicker(state.draft.slice(1));
      return;
    }
  }

  // Global interrupts & exit
  if (key.ctrl && key.name === "c") {
    if (state.running && state.sessionId) {
      sendAcp({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: state.sessionId } });
      return;
    }
    if (state.draft.length > 0) {
      pushUndo();
      state.draft = "";
      state.cursor = 0;
      render();
      return;
    }
    shutdown(0);
    return;
  }
  if (key.ctrl && key.name === "p") {
    openModelPicker("");
    return;
  }
  if (key.ctrl && key.name === "d" && state.draft.length === 0) {
    shutdown(0);
    return;
  }
  if (key.name === "escape") {
    if (state.stagedCodemodModal) {
      state.stagedCodemodModal = null;
      render();
    } else if (state.running && state.sessionId) {
      sendAcp({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: state.sessionId } });
    }
    return;
  }

  // Composer text editing
  if (key.name === "enter") {
    if (key.shift || key.alt) {
      insertAtCursor("\n");
    } else {
      const toSend = state.draft;
      state.draft = "";
      state.cursor = 0;
      render();
      void submitText(toSend);
    }
    return;
  }
  if (key.name === "backspace") {
    if (state.cursor > 0) {
      pushUndo();
      state.draft = state.draft.slice(0, state.cursor - 1) + state.draft.slice(state.cursor);
      state.cursor--;
      render();
    }
    return;
  }
  if (key.name === "delete") {
    if (state.cursor < state.draft.length) {
      pushUndo();
      state.draft = state.draft.slice(0, state.cursor) + state.draft.slice(state.cursor + 1);
      render();
    }
    return;
  }
  if (key.name === "left") {
    if (state.cursor > 0) {
      state.cursor--;
      render();
    }
    return;
  }
  if (key.name === "right") {
    if (state.cursor < state.draft.length) {
      state.cursor++;
      render();
    }
    return;
  }
  if ((key.ctrl && key.name === "a") || key.name === "home") {
    state.cursor = 0;
    render();
    return;
  }
  if ((key.ctrl && key.name === "e") || key.name === "end") {
    state.cursor = state.draft.length;
    render();
    return;
  }
  if (key.ctrl && key.name === "u") {
    pushUndo();
    state.draft = state.draft.slice(state.cursor);
    state.cursor = 0;
    render();
    return;
  }
  if (key.ctrl && key.name === "z") {
    const prev = state.undoStack.pop();
    if (prev) {
      state.draft = prev.draft;
      state.cursor = prev.cursor;
      render();
    }
    return;
  }
  if (key.name === "up" && !state.draft.includes("\n") && state.history.length > 0) {
    if (state.historyIdx === -1) state.historyIdx = state.history.length - 1;
    else if (state.historyIdx > 0) state.historyIdx--;
    state.draft = state.history[state.historyIdx] || "";
    state.cursor = state.draft.length;
    render();
    return;
  }
  if (key.name === "down" && !state.draft.includes("\n") && state.historyIdx !== -1) {
    if (state.historyIdx < state.history.length - 1) {
      state.historyIdx++;
      state.draft = state.history[state.historyIdx] || "";
    } else {
      state.historyIdx = -1;
      state.draft = "";
    }
    state.cursor = state.draft.length;
    render();
    return;
  }
  if (key.text && !key.ctrl && !key.alt && !key.meta) {
    insertAtCursor(key.text);
  }
}

function handleTspEvent(ev) {
  // Native Tern selection edit inside `composer.input`
  if (ev.ev === "edit" && ev.id === "composer.input") {
    if (ev.len === state.draft.length) {
      pushUndo();
      state.draft = state.draft.slice(0, ev.from) + ev.text + state.draft.slice(ev.to);
      state.cursor = Math.max(0, Math.min(state.draft.length, ev.cursor));
      render();
    }
    return;
  }
  if (ev.ev === "undo" && ev.id === "composer.input") {
    const prev = state.undoStack.pop();
    if (prev) {
      state.draft = prev.draft;
      state.cursor = prev.cursor;
      render();
    }
    return;
  }
  // Fix: Clear draft + cursor immediately on native Tern `send` event so text never sticks
  if (ev.ev === "send" && ev.id === "composer.input") {
    const toSend = typeof ev.text === "string" ? ev.text : state.draft;
    state.draft = "";
    state.cursor = 0;
    render();
    void submitText(toSend);
    return;
  }
  // Toggle tool cards or thinking sections natively on click
  if (ev.ev === "toggle") {
    const ent = state.entries.find((e) => e.id === ev.id || `${e.id}.think` === ev.id);
    if (ent) {
      if (ev.id.endsWith(".think")) ent.thoughtCollapsed = ev.collapsed;
      else ent.collapsed = ev.collapsed;
      render();
    }
    return;
  }
  // Unified picker select / activate
  if (ev.ev === "select" && ev.id === "picker.active" && state.picker) {
    state.picker.selected = ev.item;
    render();
    return;
  }
  if (ev.ev === "activate" && ev.id === "picker.active" && state.picker) {
    void activatePickerItem(ev.item);
    return;
  }
  // Button & chip click actions
  if (ev.ev === "action") {
    if (ev.act === "submit") {
      const toSend = state.draft;
      state.draft = "";
      state.cursor = 0;
      render();
      void submitText(toSend);
    } else if (ev.act === "interrupt") {
      if (state.running && state.sessionId) {
        sendAcp({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: state.sessionId } });
      }
    } else if (ev.act === "status.model") {
      if (state.picker?.kind === "model") {
        state.picker = null;
        render();
      } else {
        openModelPicker("");
      }
    } else if (ev.act === "thinking.cycle") {
      void cycleEffort();
    } else if (ev.act === "mode.cycle") {
      void cycleMode();
    } else if (ev.act === "mode.toggle_plan") {
      const next = state.modeId === "plan" ? state.previousNonPlanMode || "default" : "plan";
      void setMode(next, { announce: false });
    } else if (ev.act === "open.usage") {
      showUsageCard();
    } else if (ev.act?.startsWith("copy.user:")) {
      const id = ev.act.slice("copy.user:".length);
      const ent = state.entries.find((e) => e.id === id);
      if (ent?.text) copyToClipboard(ent.text);
    } else if (ev.act === "close" && ev.id === "picker.active") {
      state.picker = null;
      render();
    } else if (ev.act === "apply" && ev.id === "picker.active" && state.picker?.selected) {
      void activatePickerItem(state.picker.selected);
    } else if (ev.act === "perm.allow") {
      answerPermission("allow");
    } else if (ev.act === "perm.always") {
      answerPermission("always");
    } else if (ev.act === "perm.deny") {
      answerPermission("deny");
    } else if (ev.act === "open.ast") {
      const ps = readState(DATA_DIR);
      const first = Object.values(ps.stagedCodemods || {}).find((c) => c.status === "proposed");
      if (first) state.stagedCodemodModal = first.id;
      render();
    } else if (ev.act === "ast.close") {
      state.stagedCodemodModal = null;
      render();
    } else if (ev.act === "ast.accept" && state.stagedCodemodModal) {
      try {
        const res = astResolve({ proposalId: state.stagedCodemodModal, reason: "Accepted in Tern UI", dataDir: DATA_DIR });
        state.entries.push({
          id: nextId("astok"),
          kind: "notice",
          tone: "success",
          title: `✓ Accepted AST Codemod (${res.totalReplacements} replacements)`,
          body: `Applied cleanly to: ${res.filesApplied.join(", ")}`,
        });
      } catch (err) {
        state.entries.push({ id: nextId("asterr"), kind: "notice", tone: "error", title: "AST Apply Failed", body: err.message });
      }
      state.stagedCodemodModal = null;
      render();
    } else if (ev.act === "ast.reject" && state.stagedCodemodModal) {
      try {
        astReject({ proposalId: state.stagedCodemodModal, reason: "Rejected in Tern UI", dataDir: DATA_DIR });
      } catch {
        // ignore
      }
      state.stagedCodemodModal = null;
      render();
    }
  }
}

async function startAcpBackend() {
  const args = ["acp", "--stdio"];
  if (agentFlag) args.push("--agent", agentFlag);
  if (sandboxFlag) args.push("--sandbox");
  if (skipPermsFlag) args.push("--dangerously-skip-permissions");
  for (const d of addDirs) args.push("--add-dir", d);

  acpProc = spawn("agy", args, { cwd: WORKSPACE_DIR, stdio: ["pipe", "pipe", "pipe"] });
  acpProc.stdout.on("data", (chunk) => {
    acpBuf += chunk.toString("utf8");
    const lines = acpBuf.split("\n");
    acpBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleAcpMessage(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  });
  acpProc.on("exit", (code) => {
    state.connected = false;
    settleAllRunningState();
    if (!tspSession?.closed) {
      state.entries.push({
        id: nextId("exit"),
        kind: "notice",
        tone: "error",
        title: `agy acp exited (code ${code})`,
        body: "Press Ctrl+C or Ctrl+D to exit.",
      });
      render();
    }
  });

  await acpRequest("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "omp-suite-tern", version: VERSION },
  });

  // Resolve `-c` / `--continue` to most recent session for this workspace
  let targetSessionId = conversationIdFlag;
  let targetSessionCwd = WORKSPACE_DIR;
  if (!targetSessionId && resumeContinue) {
    const listed = await acpRequest("session/list", {}).catch(() => null);
    const sessions = Array.isArray(listed?.sessions) ? listed.sessions : [];
    sessions.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const sameWs = sessions.find((s) => s.cwd && path.resolve(s.cwd) === path.resolve(WORKSPACE_DIR));
    const pick = sameWs || sessions[0];
    if (pick) {
      targetSessionId = pick.sessionId;
      targetSessionCwd = pick.cwd || WORKSPACE_DIR;
    }
  }

  let loaded = false;
  if (targetSessionId) {
    loaded = await loadConversation(targetSessionId, targetSessionCwd);
  }

  if (!loaded) {
    const sess = await acpRequest("session/new", { cwd: WORKSPACE_DIR, mcpServers: [] });
    state.sessionId = sess.sessionId;
    state.connected = true;
    syncSessionMetadata(sess);
  }

  // Apply explicit CLI flags if requested
  if (initialModelFlag) {
    const q = initialModelFlag.toLowerCase();
    const hit = state.availableModels.find((m) => m.id.toLowerCase() === q || m.fullName.toLowerCase().includes(q));
    if (hit && hit.id !== state.modelId) {
      await acpRequest("session/set_model", { sessionId: state.sessionId, modelId: hit.id }).catch(() => {});
      state.modelId = hit.id;
      state.baseModelId = hit.baseId;
      state.modelName = hit.label;
      state.effort = hit.effort;
    }
  }
  if (initialEffortFlag && initialEffortFlag.toLowerCase() !== state.effort) {
    await setEffort(initialEffortFlag, { announce: false });
  }
  if (initialModeFlag && initialModeFlag.toLowerCase() !== state.modeId) {
    await setMode(initialModeFlag, { announce: false });
  }

  refreshSessionUsage();
  render();
}

function shutdown(code = 0) {
  try {
    if (acpProc && !acpProc.killed) acpProc.kill();
  } catch {
    // ignore
  }
  try {
    tspSession?.close(true);
  } catch {
    // ignore
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// --- Main Entrypoint ---
async function main() {
  // Fast fallback: if not inside Tern TTY or raw/plain mode requested, pass through to stock `agy`
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.OMP_PLAIN_AGY === "1" || process.env.OMP_RAW_AGY === "1") {
    const res = spawnSync("agy", RAW_ARGS, { stdio: "inherit" });
    process.exit(res.status ?? 0);
  }

  tspSession = new TspSurfaceSession({ app: "omp", version: VERSION });
  const ok = await tspSession.connect(600);
  if (!ok) {
    // Terminal did not answer TSP hello (e.g. non-Tern terminal) -> seamlessly exec stock `agy`
    const res = spawnSync("agy", RAW_ARGS, { stdio: "inherit" });
    process.exit(res.status ?? 0);
  }

  tspSession.onKey = handleKey;
  tspSession.onPaste = (text) => insertAtCursor(text);
  tspSession.onEvent = handleTspEvent;

  tspSession.open({
    id: "s:1",
    mode: "inline",
    title: `agy · ${state.git.projectName || path.basename(WORKSPACE_DIR)}`,
    role: "omp.session",
    chat: true,
  });
  tspSession.setProgress(false);
  render();

  try {
    await startAcpBackend();
  } catch (err) {
    state.entries.push({
      id: nextId("booterr"),
      kind: "notice",
      tone: "error",
      title: "Failed to start agy acp",
      body: err.message || String(err),
    });
    render();
  }
}

void main();
