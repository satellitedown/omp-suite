# OMP Suite — Tool & Workflow Rules

When the `omp-suite` MCP tools (`omp-suite_core`) are available, prefer them for high-precision coding workflows:

1. **Hashline Edits (`hashline_read` / `hashline_edit`)**: For large files or tricky whitespace/indentation edits, read with `hashline_read` and patch by `line:hash` anchors via `hashline_edit` to avoid exact-match retry loops.
2. **Staged Structural Codemods (`ast_grep` / `ast_edit` / `ast_resolve` / `ast_reject`)**: For multi-file pattern searches or structural rewrites, use `ast_grep` to inspect matches and `ast_edit` to stage a preview. Review the diff summary, then call `ast_resolve` to apply atomically (or `ast_reject` to discard).
3. **LSP & Diagnostics (`lsp_query` / `lsp_diagnostics`)**: Use `lsp_query` for definitions, references, hover types, and symbols when a language server is available, and `lsp_diagnostics` to verify clean compilation/linting.
4. **Step-Through Debugging (`dap_launch` / `dap_command` / `dap_inspect`)**: For non-trivial runtime bugs, prefer setting breakpoints and inspecting live frames/variables with DAP tools instead of adding temporary print statements.
5. **Persistent Eval & Notebooks (`eval_run` / `notebook_*`)**: Use `eval_run` for stateful Python/JavaScript calculations or data exploration, and `notebook_*` tools for `.ipynb` files.
6. **Curated Memory (`memory_retain` / `memory_recall` / `memory_reflect` / `memory_learn`)**: Record durable architectural facts and repo-specific gotchas with `memory_retain`, and query `memory_recall` before re-exploring unfamiliar subsystems.
7. **Virtual URIs & Merge Conflicts (`vread` / `vwrite` / `conflict_resolve`)**: Use `vread` for `pr://<n>`, `issue://<n>`, `conflict://`, `sqlite://`, `archive://`, and `https://` URLs. Resolve git merge conflicts via `conflict_resolve` (`@ours`, `@theirs`, `@base`, or custom content).
8. **TTSR Guardrails & Advisor Notes**: If a `PreToolUse` TTSR hook blocks an action with `⚠ Injecting rule: <name>`, immediately address the rule before retrying. When delegating to `omp-advisor`, review any `concern` or `blocker` notes before concluding.
9. **OMP HUD (`omp_hud`)**: Call `omp_hud` whenever the user asks to view the live OMP/Tern-style dashboard, inspect staged codemods, active debugger state, memories, or diagnostics.
