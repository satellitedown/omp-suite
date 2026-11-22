---
name: omp-commit
description: >-
  Analyze the working tree and split unrelated changes into dependency-ordered
  atomic commits with validated conventional commit messages, excluding lockfile
  noise. Use when the user invokes /omp-commit or asks for atomic commits.
---

# Atomic Split Commits (`/omp-commit`)

Replicates `omp commit` using dependency-aware hunk analysis:

1. Call `git_atomic_plan` (from `omp-suite_core`) on the repository root.
   - It analyzes staged and unstaged changes, ignores lockfiles during semantic scoring, scores source code above tests/docs/config, groups related files/hunks into atomic commit units, detects dependency ordering, and proposes conventional commit messages.
2. Present the proposed commit sequence (order, files, rationale, and commit message for each commit) to the user before committing unless the user explicitly asked to apply them directly.
3. Verify each planned commit has no syntax/diagnostic regressions (`lsp_diagnostics`) and does not accidentally include secrets or unintended untracked artifacts.
4. Once confirmed, stage and commit each group cleanly in the planned dependency order using `git add -- <files>` and `git commit -m "<message>"`.
