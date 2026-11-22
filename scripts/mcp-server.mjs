#!/usr/bin/env node
import readline from "node:readline";
import path from "node:path";
import { resolveDataDir, readState, updateState, recordToolActivity, getGitTelemetry } from "./lib/state.mjs";
import { hashlineRead, hashlineEdit } from "./lib/hashline.mjs";
import { astGrep, astEditStage, astResolve, astReject } from "./lib/ast-codemod.mjs";
import { lspQuery, shutdownAllLsps } from "./lib/lsp-client.mjs";
import { dapLaunch, dapCommand, dapInspect, dapTerminate, shutdownAllDap } from "./lib/dap-client.mjs";
import { evalRun, evalReset, notebookRead, notebookEditCell, notebookExec, shutdownAllKernels } from "./lib/eval-kernel.mjs";
import { ttsrManage, listAllTtsrRules } from "./lib/ttsr.mjs";
import { memoryRetain, memoryRecall, memoryReflect, memoryLearn, memoryEdit } from "./lib/memory-bank.mjs";
import { vread, vwrite, resolveConflict, scanConflicts } from "./lib/virtual-fs.mjs";
import { gitAtomicPlan, postAdvisorNote } from "./lib/git-atomic.mjs";
import { buildOmpHudHtml, buildHudPayload, formatHudTextSummary } from "./lib/hud-app.mjs";

// Parse --data-dir argument
let explicitDataDir = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--data-dir" && process.argv[i + 1]) {
    explicitDataDir = process.argv[i + 1];
    i++;
  }
}
const DATA_DIR = resolveDataDir(explicitDataDir);
const HUD_RESOURCE_URI = "ui://omp-suite/hud.html";

const TOOLS = [
  // 1. Hashline Edits
  {
    name: "hashline_read",
    description: "Read a file with Oh My Pi style deterministic content-hash line anchors (`line:hash| code`) for zero-retry patching.",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string", description: "Path to file to read" },
        startLine: { type: "integer", description: "1-based start line (default 1)" },
        endLine: { type: "integer", description: "1-based inclusive end line" },
        cwd: { type: "string", description: "Optional base directory" },
      },
    },
  },
  {
    name: "hashline_edit",
    description: "Atomically apply content-hash anchored edits (`replace_line`, `replace_range`, `insert_after`, `insert_before`, `delete_range`). Rejects stale anchors before touching disk and provides recovery hints.",
    inputSchema: {
      type: "object",
      required: ["filePath", "edits"],
      properties: {
        filePath: { type: "string" },
        dryRun: { type: "boolean", description: "Preview diff without writing to disk" },
        cwd: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace_line", "replace_range", "insert_after", "insert_before", "delete_range"] },
              anchor: { type: "string", description: "Anchor in line:hash format (e.g. 42:a3f)" },
              startAnchor: { type: "string" },
              endAnchor: { type: "string" },
              content: { type: "string" },
            },
          },
        },
      },
    },
  },

  // 2. Staged Structural AST Search & Codemods
  {
    name: "ast_grep",
    description: "Structural AST pattern search supporting $VAR and $$$ARGS metavariables (uses ast-grep if installed, else built-in structural matcher).",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Pattern with $VAR / $$$ARGS metavariables (e.g. console.log($X))" },
        targetPath: { type: "string", description: "File or directory to search (default '.')" },
        lang: { type: "string", description: "Language filter (ts, js, py, rs, go, c, cpp)" },
        limit: { type: "integer" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "ast_edit",
    description: "Stage an OMP-style structural codemod preview (writes nothing to disk). Review diffs, then call ast_resolve to apply atomically or ast_reject to discard.",
    inputSchema: {
      type: "object",
      required: ["pattern", "rewrite"],
      properties: {
        pattern: { type: "string" },
        rewrite: { type: "string", description: "Replacement template referencing $VAR / $$$ARGS" },
        targetPath: { type: "string" },
        lang: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "ast_resolve",
    description: "Atomically accept and apply a staged ast_edit proposal after SHA-256 staleness verification.",
    inputSchema: {
      type: "object",
      required: ["proposalId"],
      properties: {
        proposalId: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "ast_reject",
    description: "Discard a staged ast_edit proposal without modifying files.",
    inputSchema: {
      type: "object",
      required: ["proposalId"],
      properties: {
        proposalId: { type: "string" },
        reason: { type: "string" },
      },
    },
  },

  // 3. LSP Code Intelligence & Diagnostics
  {
    name: "lsp_query",
    description: "Query live language servers (definition, references, hover, document_symbols, workspace_symbols, rename_preview, diagnostics, status).",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["status", "diagnostics", "definition", "references", "hover", "document_symbols", "workspace_symbols", "rename_preview"],
        },
        filePath: { type: "string" },
        line: { type: "integer" },
        col: { type: "integer" },
        query: { type: "string" },
        newName: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "lsp_diagnostics",
    description: "Run LSP + fast CLI syntax/type diagnostics on a file and sync issues to the OMP HUD.",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },

  // 4. DAP Step-Through Debugger
  {
    name: "dap_launch",
    description: "Launch a real step-through debug session (Python bdb built-in, lldb-dap, or dlv) with breakpoints and live frame/variable capture.",
    inputSchema: {
      type: "object",
      required: ["program"],
      properties: {
        program: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        breakpoints: {
          type: "array",
          items: {
            type: "object",
            required: ["line"],
            properties: { file: { type: "string" }, line: { type: "integer" } },
          },
        },
        stopOnEntry: { type: "boolean" },
        adapter: { type: "string", enum: ["auto", "python", "bdb", "lldb-dap", "dlv"] },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "dap_command",
    description: "Control an active DAP debug session: next, step_in, step_out, continue, evaluate, or set_breakpoints.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "action"],
      properties: {
        sessionId: { type: "string" },
        action: { type: "string", enum: ["next", "step_in", "step_out", "continue", "evaluate", "set_breakpoints"] },
        expression: { type: "string" },
        breakpoints: {
          type: "array",
          items: { type: "object", properties: { file: { type: "string" }, line: { type: "integer" } } },
        },
      },
    },
  },
  {
    name: "dap_inspect",
    description: "Inspect active DAP debug session(s), stack trace, current location, and local variables.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
    },
  },
  {
    name: "dap_terminate",
    description: "Terminate an active DAP debug session and clean up its process.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" } },
    },
  },

  // 5. Persistent Eval Kernels & Jupyter Notebooks
  {
    name: "eval_run",
    description: "Execute code in a persistent stateful Python 3 or JavaScript (Node) kernel where variables and imports survive across calls.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        language: { type: "string", enum: ["python", "javascript"] },
        code: { type: "string" },
        sessionKey: { type: "string" },
        reset: { type: "boolean" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "eval_reset",
    description: "Reset persistent Python and/or JavaScript eval kernels.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["all", "python", "javascript"] },
        sessionKey: { type: "string" },
      },
    },
  },
  {
    name: "notebook_read",
    description: "Read cells and outputs from a Jupyter (.ipynb) notebook.",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        cellIndex: { type: "integer" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "notebook_edit_cell",
    description: "Replace, insert, or delete a cell in a Jupyter (.ipynb) notebook.",
    inputSchema: {
      type: "object",
      required: ["filePath", "action"],
      properties: {
        filePath: { type: "string" },
        action: { type: "string", enum: ["replace", "insert", "delete"] },
        cellIndex: { type: "integer" },
        cellType: { type: "string", enum: ["code", "markdown"] },
        source: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "notebook_exec",
    description: "Execute code cell(s) in a Jupyter (.ipynb) notebook using a persistent Python kernel and optionally persist outputs.",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        cellIndex: { type: "integer" },
        saveOutputs: { type: "boolean" },
        cwd: { type: "string" },
      },
    },
  },

  // 6. TTSR Dormant Guardrails
  {
    name: "ttsr_manage",
    description: "Manage zero-context-tax dormant TTSR guardrails enforced automatically by PreToolUse hooks (list, add, remove, enable, disable, test).",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "enable", "disable", "test"] },
        name: { type: "string" },
        pattern: { type: "string" },
        globs: { type: "string" },
        mode: { type: "string", enum: ["block", "warn"] },
        message: { type: "string" },
        sampleText: { type: "string" },
        filePath: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },

  // 7. Curated Project Memory Bank
  {
    name: "memory_retain",
    description: "Persist a durable codebase fact, architectural decision, or pitfall into the workspace-scoped SQLite memory bank.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
        category: { type: "string", enum: ["fact", "architecture", "decision", "pitfall", "lesson"] },
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "memory_recall",
    description: "Search the workspace-scoped memory bank for previously retained facts and lessons.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        limit: { type: "integer" },
        includeGlobal: { type: "boolean" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "memory_reflect",
    description: "Synthesize a structured mental model of all retained memories for the active workspace.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
    },
  },
  {
    name: "memory_learn",
    description: "Capture a reusable lesson in the memory bank and optionally promote it into a local .agents/skills/<name>/SKILL.md.",
    inputSchema: {
      type: "object",
      required: ["lesson"],
      properties: {
        lesson: { type: "string" },
        skillName: { type: "string" },
        promoteToSkill: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "memory_edit",
    description: "Update or forget/invalidate an existing memory entry by ID.",
    inputSchema: {
      type: "object",
      required: ["id", "action"],
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["update", "forget", "delete", "invalidate"] },
        content: { type: "string" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },

  // 8. Unified Virtual URI Filesystem & Merge Conflict Resolver
  {
    name: "vread",
    description: "Unified OMP virtual URI reader supporting pr://<n>[/diff], issue://<n>, conflict://[N], sqlite://<db>[/table], archive://<zip|tar>[/path], https:// URLs (as Markdown), and local files.",
    inputSchema: {
      type: "object",
      required: ["uri"],
      properties: {
        uri: { type: "string" },
        limit: { type: "integer" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "vwrite",
    description: "Write to a local path or resolve merge conflict URIs (`conflict://1` or `conflict://*` with `@ours`, `@theirs`, `@base`, `@both`, or custom text).",
    inputSchema: {
      type: "object",
      required: ["uri", "content"],
      properties: {
        uri: { type: "string" },
        content: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
  {
    name: "conflict_resolve",
    description: "Resolve one or all Git merge conflicts cleanly using @ours, @theirs, @base, @both, or custom content.",
    inputSchema: {
      type: "object",
      required: ["target", "resolution"],
      properties: {
        target: { type: "string", description: "conflict://1, 1, or conflict://*" },
        resolution: { type: "string", description: "@ours, @theirs, @base, @both, or custom replacement text" },
        cwd: { type: "string" },
      },
    },
  },

  // 9. Atomic Commit Planner & Advisor Watchdog
  {
    name: "git_atomic_plan",
    description: "Analyze working tree changes, exclude lockfile noise, score source > tests > docs, and propose dependency-ordered atomic conventional commits.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
    },
  },
  {
    name: "advisor_note",
    description: "Post a structured OMP Advisor Watchdog note (`aside`, `concern`, or `blocker`) to the live HUD and optionally inject into the next model turn.",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        severity: { type: "string", enum: ["aside", "concern", "blocker"] },
        title: { type: "string" },
        message: { type: "string" },
        file: { type: "string" },
        line: { type: "integer" },
        injectNextTurn: { type: "boolean" },
      },
    },
  },

  // 10. OMP v19 / Tern Interactive HUD (MCP App: Side Panel + Full Page + Inline Card)
  {
    name: "omp_hud",
    description: "Open the interactive OMP v19 / Tern-style HUD dashboard (Side Panel & Full Page in Antigravity App; rich ASCII statusline card in CLI) showing live git status, staged AST codemods, DAP debugger, merge conflicts, diagnostics, TTSR rules, Advisor notes, and project memories.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        title: { type: "string", description: "Optional custom session title for the OKLCH-accented statusline" },
      },
    },
    _meta: {
      ui: { resourceUri: HUD_RESOURCE_URI },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "OMP HUD" },
          { type: "global", title: "OMP HUD" },
        ],
      },
    },
  },
  {
    name: "omp_hud_card",
    description: "Render an inline OMP v19 / Tern HUD snapshot card directly inside the conversation stream.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
      },
    },
    _meta: {
      ui: { resourceUri: HUD_RESOURCE_URI },
    },
  },
];

async function executeTool(name, args = {}) {
  const start = Date.now();
  const cwd = args.cwd || process.cwd();
  try {
    let result;
    switch (name) {
      case "hashline_read":
        result = hashlineRead({ ...args, cwd });
        break;
      case "hashline_edit":
        result = hashlineEdit({ ...args, cwd });
        recordToolActivity(DATA_DIR, {
          tool: "hashline_edit",
          summary: `${path.basename(result.path)} (${result.editsCount} op${result.editsCount === 1 ? "" : "s"})`,
          durationMs: Date.now() - start,
        });
        break;
      case "ast_grep":
        result = astGrep({ ...args, cwd });
        break;
      case "ast_edit":
        result = astEditStage({ ...args, cwd, dataDir: DATA_DIR });
        recordToolActivity(DATA_DIR, {
          tool: "ast_edit",
          summary: `${args.pattern} (${result.status}: ${result.totalReplacements} hits in ${result.filesMatched} files)`,
          durationMs: Date.now() - start,
        });
        break;
      case "ast_resolve":
        result = astResolve({ ...args, dataDir: DATA_DIR });
        recordToolActivity(DATA_DIR, {
          tool: "ast_resolve",
          summary: `Accept ${args.proposalId} (${result.totalReplacements} replacements)`,
          durationMs: Date.now() - start,
        });
        break;
      case "ast_reject":
        result = astReject({ ...args, dataDir: DATA_DIR });
        recordToolActivity(DATA_DIR, {
          tool: "ast_reject",
          summary: `Reject ${args.proposalId}`,
          durationMs: Date.now() - start,
        });
        break;
      case "lsp_query":
        result = await lspQuery({ ...args, cwd, dataDir: DATA_DIR });
        break;
      case "lsp_diagnostics":
        result = await lspQuery({ action: "diagnostics", filePath: args.filePath, cwd, dataDir: DATA_DIR });
        break;
      case "dap_launch":
        result = await dapLaunch({ ...args, cwd, dataDir: DATA_DIR });
        recordToolActivity(DATA_DIR, {
          tool: "dap_launch",
          summary: `${result.adapter} · ${path.basename(result.program)} (${result.status})`,
          durationMs: Date.now() - start,
        });
        break;
      case "dap_command":
        result = await dapCommand({ ...args, dataDir: DATA_DIR });
        break;
      case "dap_inspect":
        result = dapInspect(args);
        break;
      case "dap_terminate":
        result = dapTerminate({ ...args, dataDir: DATA_DIR });
        break;
      case "eval_run":
        result = await evalRun({ ...args, cwd });
        break;
      case "eval_reset":
        result = evalReset(args);
        break;
      case "notebook_read":
        result = notebookRead({ ...args, cwd });
        break;
      case "notebook_edit_cell":
        result = notebookEditCell({ ...args, cwd });
        break;
      case "notebook_exec":
        result = await notebookExec({ ...args, cwd });
        break;
      case "ttsr_manage":
        result = ttsrManage({ ...args, cwd, dataDir: DATA_DIR });
        break;
      case "memory_retain":
        result = memoryRetain({ ...args, cwd, dataDir: DATA_DIR });
        recordToolActivity(DATA_DIR, {
          tool: "memory_retain",
          summary: `[${result.category}] ${result.content.slice(0, 60)}`,
          durationMs: Date.now() - start,
        });
        break;
      case "memory_recall":
        result = memoryRecall({ ...args, cwd, dataDir: DATA_DIR });
        break;
      case "memory_reflect":
        result = memoryReflect({ cwd, dataDir: DATA_DIR });
        break;
      case "memory_learn":
        result = memoryLearn({ ...args, cwd, dataDir: DATA_DIR });
        break;
      case "memory_edit":
        result = memoryEdit({ ...args, dataDir: DATA_DIR });
        break;
      case "vread":
        result = await vread({ ...args, cwd });
        break;
      case "vwrite":
        result = vwrite({ ...args, cwd });
        break;
      case "conflict_resolve":
        result = resolveConflict({ ...args, cwd });
        recordToolActivity(DATA_DIR, {
          tool: "conflict_resolve",
          summary: `${args.target} → ${args.resolution} (${result.resolved} resolved)`,
          durationMs: Date.now() - start,
        });
        break;
      case "git_atomic_plan":
        result = gitAtomicPlan({ cwd });
        break;
      case "advisor_note":
        result = postAdvisorNote({ ...args, dataDir: DATA_DIR });
        recordToolActivity(DATA_DIR, {
          tool: "advisor_note",
          summary: `(${result.severity}) ${result.title}`,
          durationMs: Date.now() - start,
        });
        break;
      case "omp_hud":
      case "omp_hud_card": {
        if (args.title) {
          updateState(DATA_DIR, (s) => {
            s.session = { ...(s.session || {}), title: args.title, cwd };
          });
        }
        const st = readState(DATA_DIR);
        const git = getGitTelemetry(cwd);
        st.git = git;
        const conflicts = scanConflicts(git.root || cwd);
        const { memories } = memoryRecall({ query: "", limit: 25, cwd: git.root || cwd, dataDir: DATA_DIR });
        const ttsrRules = listAllTtsrRules(DATA_DIR, git.root || cwd);
        const payload = buildHudPayload({
          cwd: git.root || cwd,
          dataDir: DATA_DIR,
          state: st,
          conflicts,
          memories,
          ttsrRules,
        });
        return {
          content: [{ type: "text", text: formatHudTextSummary(payload) }],
          structuredContent: payload,
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const textOut =
      name === "hashline_read"
        ? `# ${result.path} (${result.startLine}-${result.endLine}/${result.totalLines}, ${result.eol}, sha:${result.sha256})\n${result.content}`
        : JSON.stringify(result, null, 2);

    return {
      content: [{ type: "text", text: textOut }],
      structuredContent: result,
    };
  } catch (err) {
    recordToolActivity(DATA_DIR, {
      tool: name,
      status: "error",
      summary: err.message || String(err),
      durationMs: Date.now() - start,
    });
    return {
      isError: true,
      content: [{ type: "text", text: `Error in ${name}: ${err.message || String(err)}` }],
    };
  }
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (!method) return;

  try {
    if (method === "initialize") {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-03-26",
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            extensions: {
              "io.modelcontextprotocol/ui": {},
              "com.google.antigravity/ui": { entrypoints: ["aux_pane", "global"] },
            },
          },
          serverInfo: {
            name: "omp-suite-core",
            version: "1.0.0",
          },
        },
      });
      return;
    }

    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return;
    }

    if (method === "ping") {
      if (id !== undefined) writeMessage({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      writeMessage({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const toolResult = await executeTool(params?.name, params?.arguments || {});
      writeMessage({ jsonrpc: "2.0", id, result: toolResult });
      return;
    }

    if (method === "resources/list") {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: HUD_RESOURCE_URI,
              name: "OMP v19 / Tern HUD",
              description: "Interactive OMP-inspired side panel and inline HUD for staged AST codemods, DAP debugging, conflicts, TTSR rules, advisor notes, and project memory.",
              mimeType: "text/html;profile=mcp-app",
              _meta: {
                ui: {
                  csp: { connectDomains: [], resourceDomains: [] },
                },
              },
            },
          ],
        },
      });
      return;
    }

    if (method === "resources/read") {
      if (params?.uri === HUD_RESOURCE_URI) {
        writeMessage({
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri: HUD_RESOURCE_URI,
                mimeType: "text/html;profile=mcp-app",
                text: buildOmpHudHtml(),
              },
            ],
          },
        });
        return;
      }
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown resource URI: ${params?.uri}` },
      });
      return;
    }

    if (id !== undefined) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    if (id !== undefined) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message || String(err) },
      });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("Content-Length:")) return;
  try {
    const msg = JSON.parse(trimmed);
    void handleRequest(msg);
  } catch {
    // ignore non-JSON framing lines
  }
});

function cleanup() {
  shutdownAllLsps();
  shutdownAllDap();
  shutdownAllKernels();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
rl.on("close", cleanup);
