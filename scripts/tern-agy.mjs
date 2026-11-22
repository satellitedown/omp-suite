#!/usr/bin/env node
/**
 * Native Tern Chatbox Surface for Google Antigravity (`agy`)
 *
 * Frontend: Real Tern Surface Protocol (TSP v1) using Tern's exact `omp.session`
 * native layout (welcome lockup, user bubbles, collapsible thinking sections,
 * streaming Markdown, native collapsible `tool` cards, `omp.editor` multiline
 * chatbox with context hairline + clickable model/effort/send bar, and native
 * `picker` / permission overlays).
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

const RAW_ARGS = process.argv.slice(2);
const VERSION = "1.2.0";

// Parse lightweight flags while forwarding ACP-supported flags to `agy acp`
let cwd = process.cwd();
let agentFlag = "";
let sandboxFlag = false;
let skipPermsFlag = false;
let resumeContinue = false;
let conversationIdFlag = "";
let initialModelFlag = "";
let addDirs = [];

for (let i = 0; i < RAW_ARGS.length; i++) {
  const a = RAW_ARGS[i];
  if (a === "--agent" && RAW_ARGS[i + 1]) agentFlag = RAW_ARGS[++i];
  else if (a === "--model" && RAW_ARGS[i + 1]) initialModelFlag = RAW_ARGS[++i];
  else if (a === "--sandbox") sandboxFlag = true;
  else if (a === "--dangerously-skip-permissions") skipPermsFlag = true;
  else if (a === "-c" || a === "--continue") resumeContinue = true;
  else if (a === "--conversation" && RAW_ARGS[i + 1]) conversationIdFlag = RAW_ARGS[++i];
  else if (a === "--add-dir" && RAW_ARGS[i + 1]) addDirs.push(RAW_ARGS[++i]);
}

const DATA_DIR = resolveDataDir();
const gitInit = getCachedGitTelemetry(cwd, 500);
const WORKSPACE_DIR = gitInit.root || path.resolve(cwd);

const state = {
  sessionId: null,
  connected: false,
  running: false,
  runStartMs: 0,
  workingLabel: "Thinking…",
  modelId: initialModelFlag || "",
  modelName: initialModelFlag || "Antigravity",
  effort: "xhigh",
  availableModels: [],
  usedTokens: 0,
  contextWindow: 1048576,
  git: gitInit,
  draft: "",
  cursor: 0,
  undoStack: [],
  history: [],
  historyIdx: -1,
  entries: [], // { id, kind: "user"|"assistant"|"tool"|"advisor"|"notice", ... }
  activeAssistant: null,
  activeTools: new Map(),
  // Native overlays
  modelPickerOpen: false,
  modelPickerQuery: "",
  modelPickerSelected: null,
  pendingPermission: null, // { rpcId, title, detail, options }
  stagedCodemodModal: null, // staged AST proposal id
  lastAlertKey: "",
};

let seqId = 1;
const nextId = (prefix) => `${prefix}.${seqId++}`;

// --- Model helpers ---
function parseModelMeta(model) {
  const raw = String(model?.name || model?.modelId || "Antigravity");
  const m = raw.match(/\((low|medium|high|xhigh|max)\)\s*$/i);
  const effort = m ? m[1].toLowerCase() : "high";
  const label = raw.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, "").trim();
  return { id: model?.modelId || raw, label, effort, fullName: raw };
}

function guessToolVisual(title = "", kind = "") {
  const lower = `${title} ${kind}`.toLowerCase();
  if (lower.includes("command") || lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) {
    return { name: "bash", targetKind: "command", lang: "bash" };
  }
  if (lower.includes("edit") || lower.includes("write") || lower.includes("hashline") || lower.includes("ast_")) {
    return { name: "edit", targetKind: "path" };
  }
  if (lower.includes("read") || lower.includes("view")) {
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

// --- Build Exact Tern `omp.session` TSP Tree ---
function buildTspTree(tsp) {
  const supportsEffort = tsp.caps.kinds.has("effort");
  const supportsTool = tsp.caps.kinds.has("tool");
  const supportsPicker = tsp.caps.kinds.has("picker");
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
                  spans: [{ t: `Antigravity ACP · v${VERSION} · ${state.git.projectName}`, s: "dim mono" }],
                },
              },
            ],
          },
        ],
      },
      {
        id: "welcome.tip",
        k: "row",
        p: { role: "omp.welcome.tip", gap: "sm", align: "center" },
        c: [
          { id: "welcome.tip.icon", k: "icon", p: { name: "lightbulb", role: "omp.welcome.tip-icon" } },
          {
            id: "welcome.tip.text",
            k: "text",
            p: {
              role: "omp.welcome.tip-text",
              wrap: "word",
              text: "Native Tern chatbox driving official agy acp — click the model chip to switch models, Shift+Enter for newline, Esc to stop.",
            },
          },
          { id: "welcome.tip.new", k: "shimmer", p: { text: "Native Tern", role: "omp.welcome.new" } },
        ],
      },
    ],
  });

  // Render conversation transcript entries
  for (const ent of state.entries) {
    if (ent.kind === "user") {
      main.push({
        id: ent.id,
        k: "card",
        p: { role: "omp.user", tone: "user" },
        c: [
          {
            id: `${ent.id}.tools`,
            k: "row",
            p: { role: "omp.user.tools", gap: "xs", align: "center" },
            c: [
              {
                id: `${ent.id}.time`,
                k: "text",
                p: { role: "omp.user.time", spans: [{ t: ent.time, s: "dim mono" }] },
              },
            ],
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
        const thoughtHead = ent.thinkingLive
          ? [
              { t: "Thinking… ", s: "muted" },
            ]
          : `Thought${ent.thoughtMs ? ` for ${Math.max(1, Math.round(ent.thoughtMs / 1000))}s` : ""}`;
        children.push({
          id: `${ent.id}.think`,
          k: "section",
          p: {
            role: "omp.thinking",
            head: thoughtHead,
            collapsible: true,
            collapsed: ent.thoughtCollapsed ?? !ent.thinkingLive,
            took: ent.thinkingLive ? undefined : ent.thoughtMs,
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
            took: ent.status !== "running" && ent.tookMs ? ent.tookMs : undefined,
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

  // 2. DOCK (Working HUD + Native `omp.editor` Chatbox Composer)
  const dock = [];

  // Live Working / Tern Activity HUD Row above composer
  const hudChildren = [];
  if (state.running) {
    hudChildren.push({
      id: "hud.spin",
      k: "spinner",
      p: { style: "starburst", label: state.workingLabel || "Thinking…" },
    });
    hudChildren.push({
      id: "hud.elapsed",
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
  const ctxMaxLabel = state.contextWindow >= 1_000_000 ? `${Math.round(state.contextWindow / 1_000_000)}M` : `${Math.round(state.contextWindow / 1000)}K`;

  const composerContext = {
    id: "composer.context",
    k: "meter",
    p: {
      role: "omp.composer.context",
      style: "bar",
      size: "sm",
      value: ctxFrac,
      thresholds: { warn: 0.7, bad: 0.88 },
      title: `Context ${ctxPctText} (${state.usedTokens.toLocaleString()} / ${state.contextWindow.toLocaleString()} tokens)`,
    },
  };

  // Composer Input Line (REAL native Tern `editor`!)
  const composerLine = {
    id: "composer.line",
    k: "row",
    p: { role: "omp.composer.line", align: "start", gap: "sm" },
    c: [
      {
        id: "composer.input",
        k: "editor",
        p: {
          text: state.draft,
          cursor: state.cursor,
          sendable: !state.running && state.connected,
          placeholder: state.connected
            ? "Ask Antigravity… (/model, /clear, /exit)"
            : "Connecting to official Antigravity ACP server…",
          maxLines: 10,
        },
      },
    ],
  };

  // Composer Action Bar (Model + Effort chip, Status facts, Send/Stop button)
  const modelChipChildren = [
    supportsEffort
      ? {
          id: "composer.effort.glyph",
          k: "effort",
          p: {
            level: state.effort,
            role: "omp.composer.model.effort",
            title: `Effort: ${state.effort} (click to switch model/effort)`,
            actions: { click: "status.model" },
          },
        }
      : { id: "composer.model.icon", k: "icon", p: { name: "model" } },
    {
      id: "composer.model.name",
      k: "text",
      p: { wrap: "none", spans: [{ t: state.modelName, s: "strong" }, { t: ` · ${state.effort}`, s: "muted" }] },
    },
    { id: "composer.model.chev", k: "icon", p: { name: "chev" } },
  ];

  const factSegs = [
    {
      id: "fact.path",
      k: "seg",
      p: {
        role: "omp.composer.fact",
        icon: "folder",
        priority: 5,
        spans: [{ t: state.git.projectName || path.basename(WORKSPACE_DIR), s: "path dim" }],
      },
    },
  ];
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
  factSegs.push({
    id: "fact.ctx",
    k: "seg",
    p: {
      role: "omp.composer.fact",
      priority: 3,
      spans: [{ t: `${ctxPctText}/${ctxMaxLabel}`, s: ctxFrac > 0.85 ? "error" : "dim" }],
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

  const composerBar = {
    id: "composer.bar",
    k: "row",
    p: { role: "omp.composer.bar", gap: "sm", align: "center" },
    c: [
      {
        id: "composer.model",
        k: "row",
        p: {
          role: "omp.composer.model",
          gap: "xs",
          align: "center",
          title: "Click to switch Antigravity model (/model)",
          actions: { click: "status.model" },
        },
        c: modelChipChildren,
      },
      {
        id: "composer.facts",
        k: "status",
        p: { role: "omp.composer.facts", transparent: true, grow: 1 },
        c: factSegs,
      },
      submitControl,
    ],
  };

  dock.push({
    id: "composer",
    k: "col",
    p: {
      role: "omp.editor",
      tone: state.running ? "pending" : undefined,
    },
    c: [composerContext, composerLine, composerBar],
  });

  // 3. LAYER (Native Tern Modal Sheets: Model Picker, Permission Prompt, Staged AST Codemod)
  const layer = [];

  if (state.modelPickerOpen && supportsPicker) {
    const q = state.modelPickerQuery.toLowerCase();
    const filtered = state.availableModels.filter(
      (m) => !q || m.fullName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    );
    const items = filtered.map((m) => ({
      id: m.id,
      label: m.label,
      detail: m.effort,
      mono: false,
      chips: [{ text: m.effort, on: m.id === state.modelId }],
    }));
    const selected =
      filtered.some((m) => m.id === state.modelPickerSelected)
        ? state.modelPickerSelected
        : filtered[0]?.id ?? null;
    state.modelPickerSelected = selected;

    layer.push({
      id: "picker.models",
      k: "picker",
      p: {
        title: "Antigravity Models",
        noun: "models",
        anchor: "composer",
        size: "md",
        density: "snug",
        query: state.modelPickerQuery,
        placeholder: "Filter models…",
        items,
        selected,
        current: state.modelId ? [state.modelId] : [],
        total: state.availableModels.length,
        actions: [
          { id: "apply", label: "Select", keys: ["enter"], primary: true },
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

// --- Official `agy acp --stdio` Bridge ---
let acpProc = null;
let acpSeq = 1;
const acpPending = new Map();
let acpBuf = "";
let tspSession = null;

function render() {
  if (!tspSession) return;
  const focusId = state.modelPickerOpen || state.pendingPermission || state.stagedCodemodModal ? null : "composer.input";
  tspSession.render(buildTspTree(tspSession), focusId);
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
      render();
      return;
    }

    if (kind === "agent_thought_chunk") {
      if (!state.activeAssistant) {
        state.activeAssistant = {
          id: nextId("asst"),
          kind: "assistant",
          thought: "",
          thoughtStartMs: Date.now(),
          thoughtMs: 0,
          thinkingLive: true,
          thoughtCollapsed: false,
          text: "",
          streaming: true,
        };
        state.entries.push(state.activeAssistant);
      }
      state.activeAssistant.thought += upd.content?.text || "";
      state.workingLabel = "Thinking…";
      render();
      return;
    }

    if (kind === "agent_message_chunk") {
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
          streaming: true,
        };
        state.entries.push(state.activeAssistant);
      }
      if (state.activeAssistant.thinkingLive) {
        state.activeAssistant.thinkingLive = false;
        state.activeAssistant.thoughtMs = Date.now() - state.activeAssistant.thoughtStartMs;
        state.activeAssistant.thoughtCollapsed = true;
      }
      state.activeAssistant.text += upd.content?.text || "";
      state.workingLabel = "Streaming…";
      render();
      return;
    }

    if (kind === "tool_call") {
      // Settle any current assistant text before the tool card so timeline stays chronological
      if (state.activeAssistant) {
        state.activeAssistant.streaming = false;
        if (state.activeAssistant.thinkingLive) {
          state.activeAssistant.thinkingLive = false;
          state.activeAssistant.thoughtMs = Date.now() - state.activeAssistant.thoughtStartMs;
          state.activeAssistant.thoughtCollapsed = true;
        }
        state.activeAssistant = null;
      }
      const tcId = upd.toolCallId || nextId("tc");
      const rawIn = upd.rawInput || {};
      const target = rawIn.CommandLine || rawIn.Path || rawIn.filePath || rawIn.pattern || rawIn.uri || "";
      const ent = {
        id: nextId("tool"),
        tcId,
        kind: "tool",
        toolKind: upd.kind || "",
        title: upd.title || upd.kind || "Tool",
        target: String(target).slice(0, 120),
        status: "running",
        startMs: Date.now(),
        tookMs: 0,
        output: "",
        collapsed: false,
      };
      state.activeTools.set(tcId, ent);
      state.entries.push(ent);
      state.workingLabel = ent.title;
      render();
      return;
    }

    if (kind === "tool_call_update") {
      const tcId = upd.toolCallId;
      const ent = state.activeTools.get(tcId);
      if (!ent) return;
      if (upd.title) ent.title = upd.title;
      const chunkText = (upd.content || [])
        .map((c) => c.content?.text || c.text || "")
        .filter(Boolean)
        .join("\n");
      if (chunkText) ent.output = chunkText;
      if (upd.status === "completed" || upd.status === "failed") {
        ent.status = upd.status === "failed" ? "error" : "done";
        ent.tookMs = Date.now() - ent.startMs;
        ent.collapsed = upd.status !== "failed";
        state.activeTools.delete(tcId);
        state.git = getCachedGitTelemetry(WORKSPACE_DIR, 500);
      }
      render();
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

async function switchModel(modelId) {
  const found = state.availableModels.find((m) => m.id === modelId);
  if (!found || !state.sessionId) return;
  try {
    await acpRequest("session/set_model", { sessionId: state.sessionId, modelId: found.id });
    state.modelId = found.id;
    state.modelName = found.label;
    state.effort = found.effort;
  } catch (err) {
    state.entries.push({ id: nextId("n"), kind: "notice", tone: "error", title: "Model switch failed", body: err.message });
  }
  state.modelPickerOpen = false;
  state.modelPickerQuery = "";
  render();
}

async function submitText(rawText) {
  const text = rawText.trim();
  if (!text) return;

  state.history.push(text);
  if (state.history.length > 200) state.history.shift();
  state.historyIdx = -1;

  if (text === "/quit" || text === "/exit") {
    shutdown(0);
    return;
  }
  if (text === "/clear" || text === "/new") {
    state.entries = [];
    state.activeAssistant = null;
    if (state.connected) {
      const sess = await acpRequest("session/new", { cwd: WORKSPACE_DIR, mcpServers: [] }).catch(() => null);
      if (sess?.sessionId) state.sessionId = sess.sessionId;
    }
    render();
    return;
  }
  if (text === "/model" || text === "/models") {
    state.modelPickerOpen = true;
    state.modelPickerQuery = "";
    state.modelPickerSelected = state.modelId || state.availableModels[0]?.id || null;
    render();
    return;
  }
  if (text === "/hud") {
    const ps = readState(DATA_DIR);
    const staged = Object.values(ps.stagedCodemods || {}).filter((c) => c.status === "proposed");
    const diags = Object.values(ps.diagnostics || {}).flat();
    const daps = Object.values(ps.dapSessions || {}).filter((d) => d.status !== "terminated");
    const mems = memoryRecall({ query: "", limit: 20, cwd: WORKSPACE_DIR, dataDir: DATA_DIR }).totalFound;
    state.entries.push({
      id: nextId("hudcard"),
      kind: "notice",
      tone: "info",
      title: `OMP Suite Live Status · ${state.git.projectName}`,
      body: [
        `- **Model**: \`${state.modelName}\` (\`${state.effort}\`)`,
        `- **Workspace**: \`${WORKSPACE_DIR}\` (\`${state.git.branch || "no-git"}\`)`,
        `- **Diagnostics**: ${diags.length} · **Staged AST**: ${staged.length} · **DAP**: ${daps.length} · **Memories**: ${mems}`,
      ].join("\n"),
    });
    render();
    return;
  }
  if (text.startsWith("/model ")) {
    const q = text.slice(7).trim().toLowerCase();
    const hit = state.availableModels.find((m) => m.id.toLowerCase() === q || m.fullName.toLowerCase().includes(q));
    if (hit) await switchModel(hit.id);
    else {
      state.modelPickerOpen = true;
      state.modelPickerQuery = q;
      render();
    }
    return;
  }

  if (!state.connected || !state.sessionId || state.running) return;

  const now = new Date();
  const hhmm = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  state.entries.push({ id: nextId("usr"), kind: "user", text, time: hhmm });
  state.running = true;
  state.runStartMs = Date.now();
  state.workingLabel = "Thinking…";
  state.activeAssistant = null;
  render();

  try {
    await acpRequest("session/prompt", {
      sessionId: state.sessionId,
      prompt: [{ type: "text", text }],
    });
  } catch (err) {
    state.entries.push({
      id: nextId("err"),
      kind: "notice",
      tone: "error",
      title: "Antigravity ACP Error",
      body: err.message || String(err),
    });
  } finally {
    if (state.activeAssistant) {
      state.activeAssistant.streaming = false;
      if (state.activeAssistant.thinkingLive) {
        state.activeAssistant.thinkingLive = false;
        state.activeAssistant.thoughtMs = Date.now() - state.activeAssistant.thoughtStartMs;
        state.activeAssistant.thoughtCollapsed = true;
      }
      state.activeAssistant = null;
    }
    state.running = false;
    state.git = getCachedGitTelemetry(WORKSPACE_DIR, 200);
    // Surface any newly recorded Advisor or TTSR note from hooks
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

  // Model picker navigation
  if (state.modelPickerOpen) {
    const q = state.modelPickerQuery.toLowerCase();
    const list = state.availableModels.filter(
      (m) => !q || m.fullName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
    );
    const idx = Math.max(0, list.findIndex((m) => m.id === state.modelPickerSelected));
    if (key.name === "escape") {
      state.modelPickerOpen = false;
      render();
    } else if (key.name === "up") {
      if (list.length) state.modelPickerSelected = list[(idx - 1 + list.length) % list.length].id;
      render();
    } else if (key.name === "down") {
      if (list.length) state.modelPickerSelected = list[(idx + 1) % list.length].id;
      render();
    } else if (key.name === "enter") {
      if (state.modelPickerSelected) void switchModel(state.modelPickerSelected);
    } else if (key.name === "backspace") {
      state.modelPickerQuery = state.modelPickerQuery.slice(0, -1);
      render();
    } else if (key.text && !key.ctrl && !key.alt && !key.meta) {
      state.modelPickerQuery += key.text;
      render();
    }
    return;
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
    state.modelPickerOpen = !state.modelPickerOpen;
    state.modelPickerQuery = "";
    state.modelPickerSelected = state.modelId || state.availableModels[0]?.id || null;
    render();
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
  if (ev.ev === "send" && ev.id === "composer.input") {
    void submitText(ev.text);
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
  // Picker select / activate
  if (ev.ev === "select" && ev.id === "picker.models") {
    state.modelPickerSelected = ev.item;
    render();
    return;
  }
  if (ev.ev === "activate" && ev.id === "picker.models") {
    void switchModel(ev.item);
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
      state.modelPickerOpen = !state.modelPickerOpen;
      state.modelPickerQuery = "";
      state.modelPickerSelected = state.modelId || state.availableModels[0]?.id || null;
      render();
    } else if (ev.act === "close" && ev.id === "picker.models") {
      state.modelPickerOpen = false;
      render();
    } else if (ev.act === "apply" && ev.id === "picker.models" && state.modelPickerSelected) {
      void switchModel(state.modelPickerSelected);
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
        // ignore
      }
    }
  });
  acpProc.on("exit", (code) => {
    state.connected = false;
    state.running = false;
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

  let sess;
  if (conversationIdFlag) {
    sess = await acpRequest("session/load", { sessionId: conversationIdFlag, cwd: WORKSPACE_DIR, mcpServers: [] }).catch(() => null);
  }
  if (!sess) {
    sess = await acpRequest("session/new", { cwd: WORKSPACE_DIR, mcpServers: [] });
  }
  state.sessionId = sess.sessionId;
  state.connected = true;

  if (Array.isArray(sess.models?.availableModels)) {
    state.availableModels = sess.models.availableModels.map(parseModelMeta);
    const cur =
      state.availableModels.find((m) => m.id === (initialModelFlag || sess.models.currentModelId)) ||
      state.availableModels[0];
    if (cur) {
      state.modelId = cur.id;
      state.modelName = cur.label;
      state.effort = cur.effort;
      if (initialModelFlag && cur.id !== sess.models.currentModelId) {
        await acpRequest("session/set_model", { sessionId: state.sessionId, modelId: cur.id }).catch(() => {});
      }
    }
  }
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
  // Fast fallback: if not inside Tern TTY, pass through directly to stock `agy`
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.OMP_PLAIN_AGY === "1") {
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
