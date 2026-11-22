---
name: omp-hud
description: >-
  Open the OMP v19 / Tern-style live HUD dashboard in Antigravity App or launch
  the sanctioned ACP Terminal UI (omp-tui) in the terminal. Use when the user
  asks for the OMP UI, status HUD, live tray, or terminal UI.
---

# OMP v19 / Tern-Style UI (`omp-hud`)

Use this skill to surface the live OMP-inspired HUD across whichever Antigravity surface the user is on:

1. **In Antigravity App (Side Panel / Full Page / Inline Card)**:
   - Call the `omp_hud` MCP tool (from `omp-suite_core`) with `{ "cwd": "<workspace_path>", "view": "dashboard" }`.
   - This opens the interactive OMP v19 / Tern HUD (`ui://omp-suite/hud.html`) featuring the OKLCH session-accent statusline, live staged AST codemod Accept/Reject cards, DAP debugger inspector, merge conflict resolver, TTSR rule alerts, Advisor notes, diagnostics, and curated project memory bank.

2. **In Antigravity CLI (`agy`) or Terminal**:
   - Call `omp_hud` to print a crisp terminal-friendly snapshot of the current session statusline, diagnostics, staged codemods, active debugger, TTSR alerts, advisor notes, and project memories.
   - If the user wants the **full interactive newest-OMP Terminal UI** powered by official `agy acp --stdio`, tell them they can launch it directly from their shell:
     ```bash
     node ~/.gemini/config/plugins/omp-suite/scripts/omp-tui.mjs
     # Or preview the UI immediately in demo mode:
     node ~/.gemini/config/plugins/omp-suite/scripts/omp-tui.mjs --demo
     ```
