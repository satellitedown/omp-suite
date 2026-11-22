---
name: omp-debug
description: >-
  Drive a real step-through debugger (DAP) with breakpoints, stack frames,
  scopes, locals, and live expression evaluation instead of print debugging.
  Use when the user invokes /omp-debug or asks to debug a failing script or binary.
---

# Step-Through DAP Debugging (`/omp-debug`)

Replicates Oh My Pi's integrated debugger workflow:

1. Identify the target program, language, arguments, and suspected failure line(s).
2. Call `dap_launch` with `{ "program": "<path>", "args": [...], "breakpoints": [{ "file": "<path>", "line": <n> }], "stopOnEntry": false }`.
   - Automatically selects `debugpy` (or the built-in Python `bdb` engine when `debugpy` is absent), `lldb-dap` for C/C++/Rust binaries, or `dlv` for Go.
3. Once stopped at a breakpoint or exception, call `dap_inspect` to view the current frame, stack trace, scopes, and local variables, or evaluate expressions with `dap_command` (`action: "evaluate"`).
4. Step through execution using `dap_command` (`next`, `step_in`, `step_out`, `continue`, `set_breakpoints`).
5. Always call `dap_terminate` when finished so no orphan debuggee processes remain, and summarize the exact root cause with observed runtime values.
