# OMP Suite (`omp-suite`)

> **The Top 10 capabilities of [Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi) packaged as a 100% sanctioned, zero-dependency Google Antigravity plugin — complete with an OMP v19 / Tern-style interactive HUD (MCP App) and an official `agy acp` Terminal UI.**

[![Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin%20v1-0088fa?style=flat&labelColor=18181e)](https://antigravity.google/docs/plugins)
[![MCP Apps](https://img.shields.io/badge/MCP%20Apps-io.modelcontextprotocol%2Fui-89d281?style=flat&labelColor=18181e)](https://antigravity.google/docs/mcp-apps)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20(Node%20built--ins)-febc38?style=flat&labelColor=18181e)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-b281d6?style=flat&labelColor=18181e)](LICENSE)

---

## Why This Exists (100% Sanctioned & ToS-Safe)

Google Antigravity's Terms of Service prohibit third-party wrappers or proxies that harvest or reroute Antigravity OAuth tokens. **`omp-suite` never touches OAuth credentials or private endpoints.** Instead, it brings Oh My Pi's highest-leverage harness features to Antigravity strictly through Google's official extension APIs:

- **MCP Server + MCP Apps** (`mcp_config.json`, `io.modelcontextprotocol/ui`, `com.google.antigravity/ui`)
- **Lifecycle Hooks** (`hooks.json`: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop`)
- **Custom Subagents** (`agents/omp-advisor.md`, `agents/omp-reviewer.md`)
- **Skills & Rules** (`skills/*/SKILL.md`, `rules/AGENTS.md`)
- **Official ACP Client** (`scripts/omp-tui.mjs` speaking standard JSON-RPC to `agy acp --stdio`)

---

## The Top 10 `omp` Features Added to Antigravity

| # | Oh My Pi Feature Missing in `agy` | How `omp-suite` Implements It |
| :- | :--- | :--- |
| **1** | **Hashline Edits** (content-hash anchored patching) | `hashline_read` (`42:a3f\| code`) + atomic `hashline_edit` (`replace_line`, `replace_range`, `insert_after`, `insert_before`, `delete_range`) with stale-anchor rejection & line-move recovery hints. |
| **2** | **Staged Structural AST Search & Codemods** (`(proposed)` → `Accept`/`Reject`) | `ast_grep` + `ast_edit` (stages multi-file `$VAR`/`$$$ARGS` structural rewrites without touching disk) → `ast_resolve` (SHA-256 verified atomic apply) / `ast_reject`. Uses `ast-grep` if installed, else built-in balanced structural engine. |
| **3** | **LSP Code Intelligence + Auto Post-Edit Diagnostics** | Persistent LSP stdio client (`typescript-language-server`, `pyright`, `ruff`, `rust-analyzer`, `gopls`, `clangd`) + fast CLI fallbacks (`node --check`, `py_compile`, `tsc`, `bash -n`) wired into `PostToolUse` → `PreInvocation` → `Stop` hooks. |
| **4** | **Real Step-Through Debugger (DAP)** | `dap_launch`, `dap_command`, `dap_inspect`, `dap_terminate` supporting `lldb-dap`, `dlv dap`, and a zero-install built-in Python `bdb` engine (breakpoints, stepping, stack frames, locals, live expression evaluation). |
| **5** | **Persistent Eval Kernels + Native Jupyter Notebooks** | Stateful Python 3 and Node.js REPL kernels (`eval_run`, `eval_reset`) that retain variables/imports across calls, plus `.ipynb` `notebook_read`, `notebook_edit_cell`, and `notebook_exec`. |
| **6** | **Time-Traveling Stream Rules (TTSR)** | Zero-context-tax dormant regex guardrails (`ttsr_manage`, `.omp-rules.json`) enforced by a `PreToolUse` hook that blocks violating edits/commands and injects `⚠ TTSR Injecting rule: <name>` mid-flight. |
| **7** | **Curated Project-Scoped Memory Bank** | Workspace-scoped SQLite (`node:sqlite`, with JSON fallback) memory store (`memory_retain`, `memory_recall`, `memory_reflect`, `memory_learn` with `SKILL.md` promotion, `memory_edit`) auto-injected on `SessionStart`. |
| **8** | **Unified Virtual URI Filesystem & Merge Conflict Resolver** | `vread` / `vwrite` / `conflict_resolve` across `pr://<n>`, `issue://<n>`, `conflict://N` (`@ours`, `@theirs`, `@base`, `@both`, `conflict://*`), `sqlite://<db>[/table]`, `archive://<zip\|tar>[/path]`, and `https://` → Markdown. |
| **9** | **Advisor Watchdog, P0–P3 Verdict Review & Atomic Split Commits** | Bundled `omp-advisor` (`aside`/`concern`/`blocker` cards via `advisor_note`) & `omp-reviewer` (P0–P3 confidence-scored Ship/Needs Changes/Block verdict) subagents, plus `git_atomic_plan` (excludes lockfiles, dependency-orders source > tests > docs). |
| **10** | **Newest OMP v19 / Tern-Style Dual-Surface UI** | **(A) Antigravity App MCP App (`omp_hud` & `omp_hud_card`)** for Side Panel (`aux_pane`), Full Page (`global`), and Inline Chat; **(B) Sanctioned ACP Terminal UI (`scripts/omp-tui.mjs`)** driving `agy acp --stdio` with CSI 2026 sync output, OKLCH per-session accent frames, Tern live trays, and bordered collapsible tool cards (`Ctrl+O`). |

---

## The Newest OMP v19 / Tern UI

### Surface A — Antigravity App Interactive HUD (MCP App)
Open from **Plugins > OMP HUD** in the sidebar, the side panel `+` menu, or by running `/omp-hud`:
- Faithful `omp` `dark.json` obsidian theme (`#18181e` / `#121212` / `#1e1e24`) with **OKLCH hash-derived per-session accent borders**
- **Tern Live Activity Tray** cards for Staged AST Codemods, Active DAP Debugger, Diagnostics/TTSR, and Project Memory Bank
- Interactive one-click **✓ Accept / ✕ Reject** codemod buttons, DAP step/continue controls, `@ours`/`@theirs` merge conflict buttons, and live memory retention

### Surface B — Sanctioned Terminal UI over `agy acp`
Launch the full terminal UI powered by Antigravity's official ACP stdio server:

```bash
# Live interactive session powered by `agy acp --stdio`
node ~/.gemini/config/plugins/omp-suite/scripts/omp-tui.mjs

# Set a custom session title (recomputes the OKLCH accent frame color!)
node ~/.gemini/config/plugins/omp-suite/scripts/omp-tui.mjs --title "Refactor Auth"

# Preview the UI instantly in interactive demo mode
node ~/.gemini/config/plugins/omp-suite/scripts/omp-tui.mjs --demo
```

```text
 ┌─ ✓ AST Edit: console.log($X) (proposed) ───────────────────────────────────────────┐
 ├─ Preview · 3 replacements · 1 file ────────────────────────────────────────────────┤
 │ -  console.log('token refreshed', uid);                                            │
 │ +  logger.debug('token refreshed', uid);                                           │
 └────────────────────────────────────────────────────────────────────────────────────┘

 i Advisor 1 note
 │ (concern) Scoped catch to ENOENT; double-check EACCES handling.

  ◆ AST: 1 proposed (3 hits)  │  ◉ DAP: debug-1 :6  │  ✓ diag: 0  │  ✦ mem: 4
╭─ π  ❯  ⚙ Gemini 4 Neon · ● high   📁 omp-suite   ⎇ main *1 +2   ◫ 4.2%/1M ✦ ── Refactor Auth ─╮
│ ❯ _                                                                                            │
╰────────────────────────────────────────────────────────────────────────────────────────────────╯
```

---

## Installation

### From GitHub (Recommended)
```bash
agy plugin install https://github.com/satellitedown/omp-suite
```

### From a Local Clone
```bash
git clone https://github.com/satellitedown/omp-suite.git
agy plugin validate --strict ./omp-suite
agy plugin install ./omp-suite
```

### Included Slash Commands & Agents
- `/omp-hud` — Open the OMP v19 / Tern HUD dashboard or launch `omp-tui`
- `/omp-review` — Run a P0–P3 confidence-scored verdict code review
- `/omp-commit` — Split working tree changes into dependency-ordered atomic commits
- `/omp-debug` — Launch a step-through DAP debugging session
- `/omp-rules` — Manage zero-context-tax dormant TTSR guardrails
- Custom Agents: `omp-advisor` (subagent watchdog), `omp-reviewer` (P0–P3 verdict reviewer)

---

## Verification & Testing

Zero external packages to install — requires Node.js 20+ (Node 22.5+ enables native `node:sqlite`; older Node automatically falls back to JSON):

```bash
# Run full 10-feature integration + MCP protocol + hooks + TUI test suite
node ./scripts/test-suite.mjs

# Validate strictly against Antigravity's official plugin loader
agy plugin validate --strict .
```
