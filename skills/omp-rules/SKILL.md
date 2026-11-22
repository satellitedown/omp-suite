---
name: omp-rules
description: >-
  Manage Time-Traveling Stream Rules (TTSR) — dormant regex guardrails with
  zero per-turn context tax that intercept edits or commands on violation and
  inject corrective reminders. Use when the user invokes /omp-rules.
---

# Dormant TTSR Guardrails (`/omp-rules`)

Manage zero-context-tax pattern guardrails enforced automatically by `omp-suite`'s `PreToolUse` hook:

1. Call `ttsr_manage` with `action: "list"` to inspect active global and project rules (loaded from `${PLUGIN_DATA}/ttsr-rules.json` and `<workspace>/.omp-rules.json`).
2. To add a new dormant rule, call `ttsr_manage` with:
   - `action: "add"`
   - `name`: kebab-case identifier (e.g., `no-box-leak`, `no-hardcoded-secrets`, `no-console-log`)
   - `pattern`: JavaScript regular expression matched against tool edits/commands
   - `globs`: optional file glob filter (e.g., `**/*.rs, **/*.ts`)
   - `mode`: `"block"` (denies the tool call and forces immediate course-correction) or `"warn"` (logs an amber alert card in the HUD)
   - `message`: the concise rule body injected on violation
3. To temporarily bypass or remove a rule, use `action: "disable"`, `action: "enable"`, or `action: "remove"`.
4. To test a rule against sample text without editing files, use `action: "test"`.
