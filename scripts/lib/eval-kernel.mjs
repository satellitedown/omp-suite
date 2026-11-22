import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";

const PYTHON_KERNEL_SCRIPT = `
import ast, io, json, sys, traceback, contextlib

ns = {"__name__": "__omp_eval__"}

while True:
    raw = sys.stdin.readline()
    if not raw:
        break
    req = json.loads(raw)
    code = req.get("code", "")
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    result_repr = None
    ok = True
    try:
        tree = ast.parse(code, mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(tree.body.pop().value)
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            if tree.body:
                exec(compile(tree, "<omp-eval>", "exec"), ns, ns)
            if last_expr is not None:
                val = eval(compile(last_expr, "<omp-eval>", "eval"), ns, ns)
                if val is not None:
                    result_repr = repr(val)
    except Exception:
        ok = False
        err_buf.write(traceback.format_exc())

    sys.stdout.write(json.dumps({
        "ok": ok,
        "stdout": out_buf.getvalue(),
        "stderr": err_buf.getvalue(),
        "result": result_repr,
        "vars": sorted([k for k in ns.keys() if not k.startswith("_")])[:40]
    }) + "\\n")
    sys.stdout.flush()
`;

class PersistentPythonKernel {
  constructor(cwd) {
    this.cwd = cwd || process.cwd();
    this.execCount = 0;
    this.buf = "";
    this.queue = [];
    this.alive = true;
    this.proc = spawn("python3", ["-u", "-c", PYTHON_KERNEL_SCRIPT], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const job = this.queue.shift();
        if (!job) continue;
        clearTimeout(job.timer);
        try {
          job.resolve(JSON.parse(line));
        } catch (err) {
          job.reject(err);
        }
      }
    });
    this.proc.on("exit", () => {
      this.alive = false;
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        clearTimeout(job.timer);
        job.reject(new Error("Python eval kernel exited"));
      }
    });
  }

  run(code, timeoutMs = 15000) {
    if (!this.alive) return Promise.reject(new Error("Python kernel is not alive"));
    this.execCount++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Python cell timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.queue.push({ resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ code }) + "\n");
    });
  }

  stop() {
    this.alive = false;
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }
}

class PersistentJsKernel {
  constructor(cwd) {
    this.cwd = cwd || process.cwd();
    this.execCount = 0;
    this.stdoutLines = [];
    this.stderrLines = [];
    this.sandbox = {
      console: {
        log: (...args) => this.stdoutLines.push(args.map(formatJsVal).join(" ")),
        info: (...args) => this.stdoutLines.push(args.map(formatJsVal).join(" ")),
        warn: (...args) => this.stderrLines.push(args.map(formatJsVal).join(" ")),
        error: (...args) => this.stderrLines.push(args.map(formatJsVal).join(" ")),
      },
      fs,
      path,
      cwd: this.cwd,
      Buffer,
      URL,
      JSON,
      Math,
      Date,
      setTimeout,
      clearTimeout,
    };
    this.context = vm.createContext(this.sandbox);
  }

  async run(code, timeoutMs = 15000) {
    this.execCount++;
    this.stdoutLines = [];
    this.stderrLines = [];
    try {
      const script = new vm.Script(code, { filename: `<omp-eval-js-${this.execCount}>` });
      let val = script.runInContext(this.context, { timeout: timeoutMs });
      if (val && typeof val.then === "function") {
        val = await val;
      }
      return {
        ok: true,
        stdout: this.stdoutLines.join("\n"),
        stderr: this.stderrLines.join("\n"),
        result: val === undefined ? null : formatJsVal(val),
        vars: Object.keys(this.sandbox)
          .filter((k) => !["console", "fs", "path", "cwd", "Buffer", "URL", "JSON", "Math", "Date", "setTimeout", "clearTimeout"].includes(k))
          .slice(0, 40),
      };
    } catch (err) {
      return {
        ok: false,
        stdout: this.stdoutLines.join("\n"),
        stderr: (this.stderrLines.join("\n") + "\n" + (err.stack || err.message)).trim(),
        result: null,
        vars: [],
      };
    }
  }

  stop() {
    // VM context is GC'd
  }
}

function formatJsVal(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const pyKernels = new Map();
const jsKernels = new Map();

export async function evalRun({ language = "python", code, sessionKey = "default", cwd, reset = false }) {
  const lang = language.toLowerCase();
  const key = `${lang}::${sessionKey}`;

  if (lang === "python" || lang === "py") {
    if (reset && pyKernels.has(key)) {
      pyKernels.get(key).stop();
      pyKernels.delete(key);
    }
    let kernel = pyKernels.get(key);
    if (!kernel || !kernel.alive) {
      kernel = new PersistentPythonKernel(cwd);
      pyKernels.set(key, kernel);
    }
    const res = await kernel.run(code);
    return { language: "python", sessionKey, execCount: kernel.execCount, ...res };
  }

  if (lang === "javascript" || lang === "js" || lang === "node") {
    if (reset) jsKernels.delete(key);
    let kernel = jsKernels.get(key);
    if (!kernel) {
      kernel = new PersistentJsKernel(cwd);
      jsKernels.set(key, kernel);
    }
    const res = await kernel.run(code);
    return { language: "javascript", sessionKey, execCount: kernel.execCount, ...res };
  }

  throw new Error(`Unsupported eval language "${language}". Use "python" or "javascript".`);
}

export function evalReset({ language = "all", sessionKey = "default" }) {
  const closed = [];
  if (language === "all" || language === "python" || language === "py") {
    const k = `python::${sessionKey}`;
    if (pyKernels.has(k)) {
      pyKernels.get(k).stop();
      pyKernels.delete(k);
      closed.push(k);
    }
  }
  if (language === "all" || language === "javascript" || language === "js") {
    const k = `javascript::${sessionKey}`;
    if (jsKernels.has(k)) {
      jsKernels.delete(k);
      closed.push(k);
    }
  }
  return { reset: closed };
}

export function shutdownAllKernels() {
  for (const k of pyKernels.values()) k.stop();
  pyKernels.clear();
  jsKernels.clear();
}

// --- Native Jupyter (.ipynb) support ---

function loadNotebook(nbPath, cwd) {
  const abs = path.resolve(cwd || process.cwd(), nbPath);
  if (!fs.existsSync(abs)) throw new Error(`Notebook not found: ${abs}`);
  const nb = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (!Array.isArray(nb.cells)) throw new Error(`Invalid .ipynb file (missing cells array): ${abs}`);
  return { abs, nb };
}

function cellSourceText(cell) {
  return Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
}

function summarizeOutputs(outputs = []) {
  return outputs.map((o) => {
    if (o.output_type === "stream") {
      return { type: "stream", name: o.name, text: Array.isArray(o.text) ? o.text.join("") : String(o.text || "") };
    }
    if (o.output_type === "error") {
      return { type: "error", ename: o.ename, evalue: o.evalue };
    }
    const textPlain = o.data?.["text/plain"];
    return {
      type: o.output_type,
      text: Array.isArray(textPlain) ? textPlain.join("") : String(textPlain || ""),
    };
  });
}

export function notebookRead({ filePath, cellIndex, cwd }) {
  const { abs, nb } = loadNotebook(filePath, cwd);
  const cells = nb.cells.map((c, idx) => ({
    index: idx,
    type: c.cell_type,
    executionCount: c.execution_count ?? null,
    source: cellSourceText(c),
    outputs: summarizeOutputs(c.outputs),
  }));
  if (cellIndex !== undefined && cellIndex !== null) {
    const c = cells[Number(cellIndex)];
    if (!c) throw new Error(`Cell index ${cellIndex} out of range (0..${cells.length - 1})`);
    return { path: abs, totalCells: cells.length, cell: c };
  }
  return { path: abs, totalCells: cells.length, cells };
}

export function notebookEditCell({ filePath, action = "replace", cellIndex = 0, cellType = "code", source = "", cwd }) {
  const { abs, nb } = loadNotebook(filePath, cwd);
  const idx = Number(cellIndex);
  const srcLines = String(source)
    .split("\n")
    .map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line));

  if (action === "replace") {
    if (!nb.cells[idx]) throw new Error(`Cell index ${idx} out of range`);
    nb.cells[idx].source = srcLines;
    if (cellType) nb.cells[idx].cell_type = cellType;
  } else if (action === "insert") {
    const newCell =
      cellType === "markdown"
        ? { cell_type: "markdown", metadata: {}, source: srcLines }
        : { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: srcLines };
    nb.cells.splice(Math.max(0, Math.min(nb.cells.length, idx)), 0, newCell);
  } else if (action === "delete") {
    if (!nb.cells[idx]) throw new Error(`Cell index ${idx} out of range`);
    nb.cells.splice(idx, 1);
  } else {
    throw new Error(`Unsupported notebook action "${action}". Use replace, insert, or delete.`);
  }

  fs.writeFileSync(abs, JSON.stringify(nb, null, 1) + "\n", "utf8");
  return { path: abs, action, cellIndex: idx, totalCells: nb.cells.length };
}

export async function notebookExec({ filePath, cellIndex, saveOutputs = true, cwd }) {
  const { abs, nb } = loadNotebook(filePath, cwd);
  const indices =
    cellIndex !== undefined && cellIndex !== null
      ? [Number(cellIndex)]
      : nb.cells.map((c, i) => (c.cell_type === "code" ? i : -1)).filter((i) => i >= 0);

  const sessionKey = `nb:${abs}`;
  const results = [];

  for (const idx of indices) {
    const cell = nb.cells[idx];
    if (!cell) throw new Error(`Cell index ${idx} out of range`);
    if (cell.cell_type !== "code") continue;
    const code = cellSourceText(cell);
    const res = await evalRun({ language: "python", code, sessionKey, cwd: path.dirname(abs) });
    const outputs = [];
    if (res.stdout) outputs.push({ output_type: "stream", name: "stdout", text: res.stdout.split(/(?<=\n)/) });
    if (res.stderr && res.ok) outputs.push({ output_type: "stream", name: "stderr", text: res.stderr.split(/(?<=\n)/) });
    if (res.result !== null) {
      outputs.push({
        output_type: "execute_result",
        execution_count: res.execCount,
        data: { "text/plain": [res.result] },
        metadata: {},
      });
    }
    if (!res.ok) {
      outputs.push({
        output_type: "error",
        ename: "ExecutionError",
        evalue: res.stderr.split("\n").filter(Boolean).pop() || "Error",
        traceback: res.stderr.split("\n"),
      });
    }
    cell.execution_count = res.execCount;
    cell.outputs = outputs;
    results.push({ index: idx, ok: res.ok, stdout: res.stdout, stderr: res.stderr, result: res.result });
  }

  if (saveOutputs) {
    fs.writeFileSync(abs, JSON.stringify(nb, null, 1) + "\n", "utf8");
  }
  return { path: abs, executed: results.length, saved: saveOutputs, results };
}
