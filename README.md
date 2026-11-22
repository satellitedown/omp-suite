# OMP Suite (`omp-suite`)

> **The Top 10 capabilities of [Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi) integrated directly into `agy` — zero extra commands to launch, zero external dependencies, 100% sanctioned.**

[![Antigravity Plugin](https://img.shields.io/badge/Antigravity-Plugin%20v1-0088fa?style=flat&labelColor=18181e)](https://antigravity.google/docs/plugins)
[![MCP Apps](https://img.shields.io/badge/MCP%20Apps-io.modelcontextprotocol%2Fui-89d281?style=flat&labelColor=18181e)](https://antigravity.google/docs/mcp-apps)
[![Native StatusLine](https://img.shields.io/badge/agy%20CLI-Native%20OMP%20v19%20StatusLine-febc38?style=flat&labelColor=18181e)](https://antigravity.google/docs/cli/statusline)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20(Node%20built--ins)-b281d6?style=flat&labelColor=18181e)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-89d281?style=flat&labelColor=18181e)](LICENSE)

---

## Install Once — Just Run `agy` Normally

```bash
agy plugin install https://github.com/satellitedown/omp-suite
```

That's it. Next time you run **`agy`**, `omp-suite` automatically:

1. **Wires the newest OMP v19 / Tern Status Line & Window Title natively into `agy`** (via Antigravity's official `statusLine` and `title` settings in `~/.gemini/antigravity-cli/settings.json`) — pinned permanently at the bottom of `agy`'s own TUI chrome, updating live as you work.
2. **Enables all 10 `omp` capabilities automatically behind the scenes** via bundled MCP tools, lifecycle hooks, subagents, and always-on rules — no manual commands or wrappers required.

```text
 ◉ reviewer  │  ◆ AST: 1 proposed (3 hits)  │  ◉ DAP: xorshift32:6  │  ✕ diag: 0  │  ✦ 4 mem
╰─ π ❯  ⚙ Gemini 4 Neon ⚡ · ● xhigh  📁 my-app  ⎇ main *1 +2  ◫ 4.3%/1M ✦  $0.45 (sub) ──── Refactor Auth ─╯
```

---

## Why This Is 100% Sanctioned & ToS-Safe

Google Antigravity's Terms of Service prohibit third-party wrappers or proxies that intercept or reroute Antigravity OAuth tokens. **`omp-suite` never touches OAuth credentials or private APIs.** Every feature runs strictly through official Antigravity APIs:

- **Native CLI `statusLine` & `title`** (`~/.gemini/antigravity-cli/settings.json`)
- **MCP Server + MCP Apps** (`mcp_config.json`, `io.modelcontextprotocol/ui`, `com.google.antigravity/ui`)
- **Lifecycle Hooks** (`hooks.json`: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `Stop`)
- **Custom Subagents** (`agents/omp-advisor.md`, `agents/omp-reviewer.md`)
- **Rules & Skills** (`rules/AGENTS.md`, `skills/*/SKILL.md`)

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
| **10** | **Newest OMP v19 / Tern-Style UI (Native CLI + App MCP App)** | **(A) Native `agy` CLI StatusLine & Tern Live Tray** auto-configured in `settings.json` with OKLCH per-session accent colors, live model/effort/git/context/cost, and active subagent/AST/DAP/diag tray pills; **(B) Antigravity App MCP App (`omp_hud`)** for interactive Side Panel (`aux_pane`) & Full Page (`global`) views; **(C) Optional standalone `agy acp` TUI (`scripts/omp-tui.mjs`)**. |

---

## Managing the Native `agy` Status Line

When `omp-suite` starts its first session, it automatically adds `statusLine` and `title` to `~/.gemini/antigravity-cli/settings.json` (never overwriting an unrelated custom status line you already configured).

- **Toggle off/on inside `agy`**: `/statusline off` / `/statusline on`
- **Revert to default `agy` status line**: `/statusline delete` (or `node ~/.gemini/config/plugins/omp-suite/scripts/install-ui.mjs --uninstall`)
- **Opt out of auto-wiring**: set `OMP_NO_AUTO_STATUSLINE=1`
- **Force re-wire over an existing custom status line**: `node ~/.gemini/config/plugins/omp-suite/scripts/install-ui.mjs --force`

---

## Optional Slash Commands & Bundled Agents

Everything activates automatically during normal prompts, and you can also invoke workflows explicitly anytime:
- `/omp-review` — P0–P3 confidence-scored verdict code review
- `/omp-commit` — Dependency-ordered atomic commit plan
- `/omp-debug` — Step-through DAP debugging workflow
- `/omp-rules` — Add/manage dormant TTSR guardrails
- `/omp-hud` — Open the interactive MCP App HUD (Antigravity App) or inspect statusline config

---

## Verification

```bash
node ./scripts/test-suite.mjs
agy plugin validate --strict .
```
