---
name: omp-hud
description: >-
  Configure or inspect the built-in OMP v19 / Tern status line in Antigravity CLI
  or open the interactive OMP HUD side panel in Antigravity App.
---

# OMP v19 / Tern UI (`omp-hud`)

1. **In Antigravity CLI (`agy`)**:
   - The OMP v19 / Tern statusline and live activity tray are **built directly into `agy`'s native bottom status bar** via `~/.gemini/antigravity-cli/settings.json` (`statusLine` + `title`), auto-wired on first session start.
   - You do **not** need to run any node commands or print HUD boxes in chat!
   - If the user wants to re-apply or reset the native status line, run:
     - Install / refresh: `node ~/.gemini/config/plugins/omp-suite/scripts/install-ui.mjs --force`
     - Revert to stock `agy`: `/statusline delete` (or `node ~/.gemini/config/plugins/omp-suite/scripts/install-ui.mjs --uninstall`)

2. **In Antigravity App (GUI)**:
   - Call the `omp_hud` MCP App tool to open the interactive **OMP HUD** side panel (`aux_pane`) or full-page (`global`) dashboard with one-click AST Accept/Reject, DAP stepping, merge conflict buttons, and Memory Bank controls.
