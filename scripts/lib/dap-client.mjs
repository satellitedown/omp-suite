import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { updateState } from "./state.mjs";

const sessions = new Map();

function hasCmd(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore", timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Embedded zero-install Python bdb interactive debugger driver.
 * Speaks newline-delimited JSON over stdin/stdout so Python step-through debugging
 * works everywhere Python 3 exists, even without debugpy installed.
 */
const PYTHON_BDB_HARNESS = `
import bdb, json, os, sys, traceback

class JsonBdb(bdb.Bdb):
    def __init__(self, target_file, bps, stop_on_entry):
        super().__init__()
        self.target_file = os.path.abspath(target_file)
        self.stop_on_entry = stop_on_entry
        self.started = False
        for bp in bps:
            f = os.path.abspath(bp.get("file") or target_file)
            self.set_break(f, int(bp["line"]))

    def _frame_payload(self, frame, reason, exc=None):
        stack = []
        cur = frame
        while cur and len(stack) < 25:
            fn = os.path.abspath(cur.f_code.co_filename)
            if not fn.startswith("<string>"):
                stack.append({
                    "name": cur.f_code.co_name,
                    "file": fn,
                    "line": cur.f_lineno
                })
            cur = cur.f_back
        locs = {}
        for k, v in list(frame.f_locals.items())[:40]:
            if k.startswith("__") and k.endswith("__"):
                continue
            try:
                locs[k] = {"value": repr(v)[:200], "type": type(v).__name__}
            except Exception as e:
                locs[k] = {"value": f"<err: {e}>", "type": "error"}
        return {
            "event": "stopped",
            "reason": reason,
            "file": os.path.abspath(frame.f_code.co_filename),
            "line": frame.f_lineno,
            "frame": frame.f_code.co_name,
            "stack": stack,
            "locals": locs,
            "exception": exc
        }

    def user_line(self, frame):
        fn = os.path.abspath(frame.f_code.co_filename)
        if not self.started:
            self.started = True
            if not self.stop_on_entry and not self.break_here(frame):
                self.set_continue()
                return
        if fn.startswith("<"):
            return
        self._interact(frame, "breakpoint" if self.break_here(frame) else "step")

    def user_exception(self, frame, exc_info):
        exc_type, exc_val, _ = exc_info
        self._interact(frame, "exception", f"{exc_type.__name__}: {exc_val}")

    def _interact(self, frame, reason, exc=None):
        sys.stdout.write(json.dumps(self._frame_payload(frame, reason, exc)) + "\\n")
        sys.stdout.flush()
        while True:
            raw = sys.stdin.readline()
            if not raw:
                self.set_quit()
                return
            cmd = json.loads(raw)
            act = cmd.get("action")
            if act == "next":
                self.set_next(frame)
                return
            elif act == "step_in":
                self.set_step()
                return
            elif act == "step_out":
                self.set_return(frame)
                return
            elif act == "continue":
                self.set_continue()
                return
            elif act == "set_breakpoints":
                self.clear_all_breaks()
                for bp in cmd.get("breakpoints", []):
                    self.set_break(os.path.abspath(bp.get("file") or self.target_file), int(bp["line"]))
                sys.stdout.write(json.dumps({"event": "reply", "ok": True, "breakpoints": len(cmd.get("breakpoints", []))}) + "\\n")
                sys.stdout.flush()
            elif act == "evaluate":
                expr = cmd.get("expression", "")
                try:
                    val = eval(expr, frame.f_globals, frame.f_locals)
                    sys.stdout.write(json.dumps({"event": "reply", "ok": True, "result": repr(val), "type": type(val).__name__}) + "\\n")
                except Exception as e:
                    sys.stdout.write(json.dumps({"event": "reply", "ok": False, "error": str(e)}) + "\\n")
                sys.stdout.flush()
            elif act == "terminate":
                self.set_quit()
                return

cfg = json.loads(sys.argv[1])
target = os.path.abspath(cfg["program"])
sys.argv = [target] + cfg.get("args", [])
sys.path.insert(0, os.path.dirname(target))
dbg = JsonBdb(target, cfg.get("breakpoints", []), bool(cfg.get("stopOnEntry", True)))
try:
    with open(target, "r", encoding="utf-8") as fh:
        code = compile(fh.read(), target, "exec")
    dbg.run(code, {"__name__": "__main__", "__file__": target})
    sys.stdout.write(json.dumps({"event": "terminated", "reason": "exited"}) + "\\n")
    sys.stdout.flush()
except bdb.BdbQuit:
    sys.stdout.write(json.dumps({"event": "terminated", "reason": "quit"}) + "\\n")
    sys.stdout.flush()
except Exception as e:
    sys.stdout.write(json.dumps({"event": "terminated", "reason": "error", "error": traceback.format_exc()}) + "\\n")
    sys.stdout.flush()
`;

class PythonBdbSession {
  constructor(id, cfg) {
    this.id = id;
    this.adapter = "python-bdb (dap-compat)";
    this.program = path.resolve(cfg.cwd || process.cwd(), cfg.program);
    this.cwd = cfg.cwd || path.dirname(this.program);
    this.status = "starting";
    this.state = {
      sessionId: id,
      adapter: this.adapter,
      program: this.program,
      cwd: this.cwd,
      status: "starting",
      frame: null,
      file: this.program,
      line: 1,
      stopReason: null,
      stack: [],
      locals: {},
      stdout: [],
      stderr: [],
    };
    this.waiters = [];
    this.buf = "";

    this.proc = spawn("python3", ["-u", "-c", PYTHON_BDB_HARNESS, JSON.stringify({ ...cfg, program: this.program })], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === "stopped") {
            this.status = "stopped";
            this.state.status = "stopped";
            this.state.stopReason = msg.reason;
            this.state.file = msg.file;
            this.state.line = msg.line;
            this.state.frame = msg.frame;
            this.state.stack = msg.stack || [];
            this.state.locals = msg.locals || {};
            this.state.exception = msg.exception || null;
          } else if (msg.event === "terminated") {
            this.status = "terminated";
            this.state.status = "terminated";
            this.state.stopReason = msg.reason;
            if (msg.error) this.state.error = msg.error;
          }
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(msg);
        } catch {
          this.state.stdout.push(line);
          if (this.state.stdout.length > 50) this.state.stdout.shift();
        }
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      this.state.stderr.push(chunk.toString("utf8"));
      if (this.state.stderr.length > 50) this.state.stderr.shift();
    });

    this.proc.on("exit", () => {
      if (this.status !== "terminated") {
        this.status = "terminated";
        this.state.status = "terminated";
      }
      while (this.waiters.length > 0) {
        this.waiters.shift().resolve({ event: "terminated", reason: "process_exit" });
      }
    });
  }

  waitNext(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (this.status === "terminated") {
        resolve({ event: "terminated", reason: "already_terminated" });
        return;
      }
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Debugger timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrappedResolve = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.waiters.push({ resolve: wrappedResolve });
    });
  }

  async sendCommand(payload) {
    if (this.status === "terminated") {
      throw new Error(`Debug session ${this.id} has already terminated.`);
    }
    const p = this.waitNext();
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
    return await p;
  }

  terminate() {
    try {
      if (this.status !== "terminated") {
        this.proc.stdin.write(JSON.stringify({ action: "terminate" }) + "\n");
      }
      this.proc.kill();
    } catch {
      // ignore
    }
    this.status = "terminated";
    this.state.status = "terminated";
  }
}

/**
 * Standard Content-Length framed DAP adapter client (for lldb-dap, dlv dap, debugpy.adapter).
 */
class StdioDapSession {
  constructor(id, adapterName, cmd, args, cfg) {
    this.id = id;
    this.adapter = adapterName;
    this.program = path.resolve(cfg.cwd || process.cwd(), cfg.program);
    this.cwd = cfg.cwd || path.dirname(this.program);
    this.seq = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.buf = Buffer.alloc(0);
    this.threadId = 1;
    this.state = {
      sessionId: id,
      adapter: adapterName,
      program: this.program,
      cwd: this.cwd,
      status: "starting",
      frame: null,
      file: this.program,
      line: 1,
      stopReason: null,
      stack: [],
      locals: {},
      stdout: [],
      stderr: [],
    };
    this.proc = spawn(cmd, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => this.state.stderr.push(d.toString("utf8")));
    this.proc.on("exit", () => {
      this.state.status = "terminated";
      for (const [, p] of this.pending) p.reject(new Error(`DAP adapter ${adapterName} exited`));
      this.pending.clear();
    });
  }

  _send(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const hdr = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.proc.stdin.write(Buffer.concat([hdr, body]));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const idx = this.buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const hdr = this.buf.slice(0, idx).toString("ascii");
      const m = hdr.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buf = this.buf.slice(idx + 4);
        continue;
      }
      const len = Number(m[1]);
      const total = idx + 4 + len;
      if (this.buf.length < total) return;
      const body = this.buf.slice(idx + 4, total).toString("utf8");
      this.buf = this.buf.slice(total);
      try {
        const msg = JSON.parse(body);
        if (msg.type === "response" && this.pending.has(msg.request_seq)) {
          const { resolve, reject, timer } = this.pending.get(msg.request_seq);
          clearTimeout(timer);
          this.pending.delete(msg.request_seq);
          if (!msg.success) reject(new Error(msg.message || "DAP request failed"));
          else resolve(msg.body || {});
        } else if (msg.type === "event") {
          if (msg.event === "stopped") {
            this.state.status = "stopped";
            this.state.stopReason = msg.body?.reason || "stopped";
            if (msg.body?.threadId) this.threadId = msg.body.threadId;
          } else if (msg.event === "terminated" || msg.event === "exited") {
            this.state.status = "terminated";
          } else if (msg.event === "output" && msg.body?.output) {
            this.state.stdout.push(msg.body.output);
          }
          const idxW = this.eventWaiters.findIndex((w) => w.events.includes(msg.event));
          if (idxW !== -1) {
            const w = this.eventWaiters.splice(idxW, 1)[0];
            clearTimeout(w.timer);
            w.resolve(msg);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  request(command, args = {}, timeoutMs = 8000) {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP ${command} timed out`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this._send({ seq, type: "request", command, arguments: args });
    });
  }

  waitEvent(events, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for DAP ${events.join("/")}`)), timeoutMs);
      this.eventWaiters.push({ events, resolve, timer });
    });
  }

  async start(cfg) {
    await this.request("initialize", {
      clientID: "omp-suite",
      adapterID: this.adapter,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
    });
    const waitStopped = this.waitEvent(["stopped", "terminated", "exited"], 10000);
    await this.request("launch", {
      program: this.program,
      args: cfg.args || [],
      cwd: this.cwd,
      stopOnEntry: cfg.stopOnEntry ?? true,
    });
    if (Array.isArray(cfg.breakpoints) && cfg.breakpoints.length > 0) {
      const byFile = new Map();
      for (const bp of cfg.breakpoints) {
        const f = path.resolve(this.cwd, bp.file || this.program);
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push({ line: Number(bp.line) });
      }
      for (const [f, bps] of byFile) {
        await this.request("setBreakpoints", { source: { path: f }, breakpoints: bps });
      }
    }
    await this.request("configurationDone", {}).catch(() => {});
    await waitStopped.catch(() => {});
    if (this.state.status === "stopped") await this.refreshInspection();
  }

  async refreshInspection() {
    const st = await this.request("stackTrace", { threadId: this.threadId, levels: 20 });
    const frames = st.stackFrames || [];
    this.state.stack = frames.map((f) => ({
      id: f.id,
      name: f.name,
      file: f.source?.path || "",
      line: f.line,
      col: f.column,
    }));
    if (frames[0]) {
      this.state.frame = frames[0].name;
      this.state.file = frames[0].source?.path || this.program;
      this.state.line = frames[0].line;
      const scopes = await this.request("scopes", { frameId: frames[0].id });
      const firstScope = scopes.scopes?.[0];
      if (firstScope) {
        const vars = await this.request("variables", { variablesReference: firstScope.variablesReference });
        const locs = {};
        for (const v of (vars.variables || []).slice(0, 40)) {
          locs[v.name] = { value: v.value, type: v.type || "" };
        }
        this.state.locals = locs;
      }
    }
  }

  async sendCommand(payload) {
    const act = payload.action;
    if (act === "evaluate") {
      const frameId = this.state.stack[0]?.id;
      const res = await this.request("evaluate", {
        expression: payload.expression,
        frameId,
        context: "repl",
      });
      return { event: "reply", ok: true, result: res.result, type: res.type };
    }
    if (act === "set_breakpoints") {
      const byFile = new Map();
      for (const bp of payload.breakpoints || []) {
        const f = path.resolve(this.cwd, bp.file || this.program);
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push({ line: Number(bp.line) });
      }
      for (const [f, bps] of byFile) {
        await this.request("setBreakpoints", { source: { path: f }, breakpoints: bps });
      }
      return { event: "reply", ok: true };
    }
    const map = { next: "next", step_in: "stepIn", step_out: "stepOut", continue: "continue" };
    const dapCmd = map[act];
    if (!dapCmd) throw new Error(`Unsupported DAP action: ${act}`);
    const w = this.waitEvent(["stopped", "terminated", "exited"], 10000);
    await this.request(dapCmd, { threadId: this.threadId });
    const ev = await w;
    if (this.state.status === "stopped") await this.refreshInspection();
    return ev;
  }

  terminate() {
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    this.state.status = "terminated";
  }
}

function syncSessionToState(dataDir, session) {
  if (!dataDir) return;
  updateState(dataDir, (s) => {
    s.dapSessions[session.id] = { ...session.state, updatedAt: new Date().toISOString() };
  });
}

export async function dapLaunch({ program, args = [], breakpoints = [], stopOnEntry = true, adapter = "auto", cwd, dataDir }) {
  const absProg = path.resolve(cwd || process.cwd(), program);
  if (!fs.existsSync(absProg)) {
    throw new Error(`Program not found: ${absProg}`);
  }
  const id = `debug-${sessions.size + 1}-${crypto.randomBytes(2).toString("hex")}`;
  const ext = path.extname(absProg).toLowerCase();

  let session;
  if (adapter === "lldb-dap" || (adapter === "auto" && ext === "" && hasCmd("lldb-dap"))) {
    session = new StdioDapSession(id, "lldb-dap", "lldb-dap", [], { program: absProg, args, breakpoints, stopOnEntry, cwd });
    await session.start({ program: absProg, args, breakpoints, stopOnEntry, cwd });
  } else if (adapter === "dlv" || (adapter === "auto" && ext === ".go" && hasCmd("dlv"))) {
    session = new StdioDapSession(id, "dlv", "dlv", ["dap"], { program: absProg, args, breakpoints, stopOnEntry, cwd });
    await session.start({ program: absProg, args, breakpoints, stopOnEntry, cwd });
  } else if (ext === ".py" || adapter === "python" || adapter === "bdb") {
    session = new PythonBdbSession(id, { program: absProg, args, breakpoints, stopOnEntry, cwd });
    await session.waitNext(8000);
  } else {
    throw new Error(
      `No compatible DAP adapter installed for "${path.basename(absProg)}". Supported out-of-the-box: Python (.py via built-in bdb), or install lldb-dap (C/C++/Rust) or dlv (Go).`
    );
  }

  sessions.set(id, session);
  syncSessionToState(dataDir, session);
  return session.state;
}

export async function dapCommand({ sessionId, action, expression, breakpoints, dataDir }) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown debug session "${sessionId}". Active: ${[...sessions.keys()].join(", ") || "none"}`);
  }
  const reply = await session.sendCommand({ action, expression, breakpoints });
  syncSessionToState(dataDir, session);
  return { session: session.state, reply };
}

export function dapInspect({ sessionId }) {
  if (!sessionId) {
    return {
      activeSessions: [...sessions.values()].map((s) => s.state),
    };
  }
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown debug session "${sessionId}".`);
  return session.state;
}

export function dapTerminate({ sessionId, dataDir }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown debug session "${sessionId}".`);
  session.terminate();
  syncSessionToState(dataDir, session);
  sessions.delete(sessionId);
  return { sessionId, status: "terminated" };
}

export function shutdownAllDap() {
  for (const s of sessions.values()) s.terminate();
  sessions.clear();
}
