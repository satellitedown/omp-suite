---
name: omp-review
description: >-
  Run an Oh My Pi style priority-ranked (P0-P3) confidence-scored code review
  with a Ship/Needs Changes/Block verdict on uncommitted changes, a commit, or
  a branch diff. Use when the user invokes /omp-review or asks for a verdict review.
---

# Priority-Ranked Verdict Code Review (`/omp-review`)

Execute an Oh My Pi style structured review with clear release priorities:

1. Determine the review target:
   - Default to uncommitted working-tree changes (`git status --short` and `git diff` + `git diff --cached`).
   - If the user specified a branch, PR (`pr://<num>` via `vread`), or commit SHA, inspect that diff instead.
2. Gather context:
   - Use `git_atomic_plan` (from `omp-suite_core`) to get a clean overview of changed files, hunks, and lockfile exclusions.
   - Run `lsp_diagnostics` on modified source files to catch compiler/type/syntax errors automatically.
3. Delegate to the bundled **`omp-reviewer`** subagent (or run the review directly if small) to classify findings by **P0–P3** and **confidence (0.00–1.00)**.
4. Record any P0/P1 findings as `advisor_note` entries (`blocker` or `concern`) so they surface in the live OMP HUD.
5. Present the final report starting with a bold **Verdict** (`SHIP`, `NEEDS CHANGES`, or `BLOCK`), followed by the ranked table and concrete fix steps.
