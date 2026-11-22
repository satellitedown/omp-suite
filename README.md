# OMP Suite (`omp-suite`)

> **Turn `agy` inside [Tern](https://stencil.so/tern) into the exact native Oh My Pi (`omp`) chatbox experience — plus all Top 10 `omp` capabilities as a 100% sanctioned, zero-dependency Antigravity plugin.**

[![Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin%20v1-0088fa?style=flat&labelColor=18181e)](https://antigravity.google/docs/plugins)
[![Tern Surface Protocol](https://img.shields.io/badge/Tern-Native%20TSP%20v1%20Chatbox-f472d0?style=flat&labelColor=18181e)](https://github.com/stencil-hq/tern-sdk)
[![MCP Apps](https://img.shields.io/badge/MCP%20Apps-io.modelcontextprotocol%2Fui-89d281?style=flat&labelColor=18181e)](https://antigravity.google/docs/mcp-apps)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20(Node%20built--ins)-febc38?style=flat&labelColor=18181e)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-b281d6?style=flat&labelColor=18181e)](LICENSE)

---

## Install Once — Type `agy` Normally

```bash
agy plugin install https://github.com/satellitedown/omp-suite
node ~/.gemini/config/plugins/omp-suite/scripts/install-ui.mjs
```

Reload your shell (`source ~/.zshrc`) or open a new **Tern** tab and type **`agy`**:

- **Inside Tern (`$TERN_PANE` active)**: `agy` launches **`scripts/tern-agy.mjs`**, speaking **real Tern Surface Protocol (TSP v1)** (`role: "omp.session"`, `chat: true`) directly to Tern and driving the official **`agy acp --stdio`** backend. You get Tern's **exact native `omp` chatbox**:
  - `omp.welcome` hero card with Tern's built-in gradient mark
  - Native `omp.editor` multiline chatbox composer with top context-window hairline meter, mouse selection, paste, and Enter / Shift+Enter
  - Clickable model + animated effort chip (`Ctrl+P` or click) opening Tern's native `picker` overlay to switch Antigravity models live
  - User prompt bubbles (`omp.user`), collapsible thinking blocks (`omp.thinking`), 60fps streaming Markdown, native collapsible `tool` cards (`diff`/`ansi`), and interactive modal permission & staged AST Accept/Reject sheets
- **Subcommands (`agy plugin`, `agy -p`, `agy acp`, etc.) & non-Tern terminals**: pass straight through to stock `agy` automatically (with our native OMP v19 `statusLine` & `title` active in stock `agy` too!).
- Need stock `agy` inside Tern anytime? Run `OMP_PLAIN_AGY=1 agy` or `command agy`.

---

## 100% Sanctioned & ToS-Safe

Google Antigravity's Terms of Service prohibit third-party wrappers or proxies that intercept or reroute Antigravity OAuth tokens. **`omp-suite` never touches OAuth credentials or private APIs.**
- The **Tern native chatbox** is a pure **ACP client** speaking standard JSON-RPC to the official **`agy acp --stdio`** server (the exact protocol documented for Zed, JetBrains, VS Code, etc.).
- Every tool, hook, subagent, statusline, and MCP App uses Google's official Antigravity plugin & CLI APIs.

---

## The Real Top 10 `omp` (v19) Features Added to `agy`

| # | Oh My Pi Feature Missing in `agy` | Built-In Integration in `omp-suite` |
| :- | :--- | :--- |
| **1** | **Hashline Edits** (content-hash anchored patching) | `hashline_read` (`42:a3f\| code`) + atomic `hashline_edit` (`replace_line`, `replace_range`, `insert_after`, `insert_before`, `delete_range`) with stale-anchor rejection & line-move recovery hints. |
| **2** | **Staged Structural AST Search & Codemods** (`(proposed)` → `Accept`/`Reject`) | `ast_grep` + `ast_edit` (stages multi-file `$VAR`/`$$$ARGS` rewrites without touching disk) → `ast_resolve` (SHA-256 verified atomic apply) / `ast_reject`. Uses `ast-grep` when installed, else built-in balanced structural engine. |
| **3** | **LSP Code Intelligence + Auto Post-Edit Diagnostics** | Persistent stdio LSP client (`typescript-language-server`, `pyright`, `ruff`, `rust-analyzer`, `gopls`, `clangd`) + fast CLI fallbacks wired into `PostToolUse` → `PreInvocation` → `Stop` hooks automatically. |
| **4** | **Real Step-Through Debugger (DAP)** | `dap_launch`, `dap_command`, `dap_inspect`, `dap_terminate` supporting `lldb-dap`, `dlv dap`, and a zero-install built-in Python `bdb` driver (breakpoints, stepping, frames, locals, eval). |
| **5** | **Persistent Eval Kernels + Native Jupyter Notebooks** | Stateful Python 3 and Node.js REPLs (`eval_run`, `eval_reset`) retaining state across turns, plus `.ipynb` `notebook_read`, `notebook_edit_cell`, and `notebook_exec`. |
| **6** | **Time-Traveling Stream Rules (TTSR)** | Zero-context-tax dormant regex guardrails (`ttsr_manage`, `.omp-rules.json`) enforced automatically by `PreToolUse`, blocking violations with `⚠ TTSR Injecting rule: <name>`. |
| **7** | **Curated Project-Scoped Memory Bank** | Workspace-scoped SQLite (`node:sqlite`, with JSON fallback) store (`memory_retain`, `memory_recall`, `memory_reflect`, `memory_learn` with `SKILL.md` promotion, `memory_edit`), auto-injected at `SessionStart`. |
| **8** | **Unified Virtual URI Filesystem & Merge Conflict Resolver** | `vread` / `vwrite` / `conflict_resolve` across `pr://<n>`, `issue://<n>`, `conflict://N` / `conflict://*` (`@ours`, `@theirs`, `@base`, `@both`), `sqlite://<db>[/table]`, `archive://<zip\|tar>`, and `https://` → Markdown. |
| **9** | **Advisor Watchdog, P0–P3 Verdict Review & Atomic Commit Splitter** | Bundled `omp-advisor` (`aside`/`concern`/`blocker` cards) & `omp-reviewer` (P0–P3 confidence-scored Ship/Needs Changes/Block verdicts), plus `git_atomic_plan` (excludes lockfiles, dependency-orders commits). |
| **10** | **Native Tern `omp.session` Chatbox + `agy` StatusLine + App MCP App** | **(A) Native Tern Chatbox (`scripts/tern-agy.mjs`)**: real Tern Surface Protocol (TSP v1) UI driving official `agy acp --stdio`; **(B) Stock `agy` Native StatusLine & Title (`scripts/omp-statusline.mjs`)** for non-Tern terminals; **(C) Antigravity App MCP App (`omp_hud`)** for interactive Side Panel (`aux_pane`) & Full Page (`global`) views. |

---

## Uninstall / Revert Anytime

```bash
node ~/.gemini/config/plugins/omp-suite/scripts/install-ui.mjs --uninstall
agy plugin uninstall omp-suite
```

---

## Verification

```bash
node ./scripts/test-suite.mjs
agy plugin validate --strict .
```
