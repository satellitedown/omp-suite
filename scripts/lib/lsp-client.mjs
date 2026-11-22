import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { updateState } from "./state.mjs";

const LSP_CONFIGS = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: (ext) => (ext.includes("ts") ? "typescript" : "javascript"),
  },
  {
    id: "pyright",
    extensions: [".py"],
    command: "pyright-langserver",
    args: ["--stdio"],
    languageId: () => "python",
  },
  {
    id: "ruff",
    extensions: [".py"],
    command: "ruff",
    args: ["server"],
    languageId: () => "python",
  },
  {
    id: "rust-analyzer",
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    languageId: () => "rust",
  },
  {
    id: "gopls",
    extensions: [".go"],
    command: "gopls",
    args: ["serve"],
    languageId: () => "go",
  },
  {
    id: "clangd",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"],
    command: "clangd",
    args: ["--log=error"],
    languageId: (ext) => (ext === ".c" ? "c" : "cpp"),
  },
];

function commandExists(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore", timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

class LspProcess {
  constructor(spec, rootDir) {
    this.spec = spec;
    this.rootDir = rootDir;
    this.nextId = 1;
    this.pending = new Map();
    this.diagnostics = new Map();
    this.openedDocs = new Map();
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.proc = spawn(spec.command, spec.args, {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.on("exit", () => {
      this.ready = false;
      for (const [, p] of this.pending) p.reject(new Error(`LSP ${spec.id} exited`));
      this.pending.clear();
    });
  }

  _send(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerStr = this.buffer.slice(0, headerEnd).toString("ascii");
      const m = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const total = headerEnd + 4 + len;
      if (this.buffer.length < total) return;
      const bodyStr = this.buffer.slice(headerEnd + 4, total).toString("utf8");
      this.buffer = this.buffer.slice(total);
      try {
        const msg = JSON.parse(bodyStr);
        this._handleMessage(msg);
      } catch {
        // ignore malformed frame
      }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === "textDocument/publishDiagnostics" && msg.params?.uri) {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics || []);
    } else if (msg.id !== undefined && msg.method) {
      // Reply null to server-initiated requests (e.g. workspace/configuration)
      this._send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }

  request(method, params, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    if (this.ready) return;
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootDir).href,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
        workspace: { symbol: {} },
      },
    });
    this.notify("initialized", {});
    this.ready = true;
  }

  syncDocument(absPath) {
    const uri = pathToFileURL(absPath).href;
    const text = fs.readFileSync(absPath, "utf8");
    const ext = path.extname(absPath).toLowerCase();
    const prev = this.openedDocs.get(uri);
    if (!prev) {
      this.openedDocs.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.spec.languageId(ext),
          version: 1,
          text,
        },
      });
    } else if (prev.text !== text) {
      const version = prev.version + 1;
      this.openedDocs.set(uri, { version, text });
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  stop() {
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }
}

const activeServers = new Map();

export function detectAvailableLsps() {
  return LSP_CONFIGS.map((c) => ({
    id: c.id,
    command: c.command,
    extensions: c.extensions,
    installed: commandExists(c.command),
  }));
}

async function getOrStartServer(filePath, rootDir, dataDir) {
  const ext = path.extname(filePath).toLowerCase();
  const candidates = LSP_CONFIGS.filter((c) => c.extensions.includes(ext));
  const spec = candidates.find((c) => commandExists(c.command));
  if (!spec) return null;

  const key = `${spec.id}::${path.resolve(rootDir)}`;
  let client = activeServers.get(key);
  if (!client || !client.ready) {
    client = new LspProcess(spec, path.resolve(rootDir));
    await client.initialize();
    activeServers.set(key, client);
    if (dataDir) {
      updateState(dataDir, (s) => {
        s.lspServers[spec.id] = {
          id: spec.id,
          command: spec.command,
          rootDir: path.resolve(rootDir),
          status: "running",
          startedAt: new Date().toISOString(),
        };
      });
    }
  }
  return client;
}

/**
 * Fast, zero-LSP syntax/type diagnostic runner used both as a fallback and by PostToolUse hooks.
 */
export function runFastDiagnostics(filePath, cwd) {
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  if (!fs.existsSync(absPath)) return [];
  const ext = path.extname(absPath).toLowerCase();
  const diags = [];

  try {
    if ([".js", ".mjs", ".cjs"].includes(ext)) {
      try {
        execFileSync(process.execPath, ["--check", absPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
        });
      } catch (err) {
        const stderr = String(err.stderr || err.message || "").trim();
        const lineM = stderr.match(/:(\d+)\b/);
        diags.push({
          file: absPath,
          line: lineM ? Number(lineM[1]) : 1,
          severity: "error",
          source: "node --check",
          message: stderr.split("\n").slice(0, 4).join(" | "),
        });
      }
    } else if (ext === ".json") {
      try {
        JSON.parse(fs.readFileSync(absPath, "utf8"));
      } catch (err) {
        diags.push({
          file: absPath,
          line: 1,
          severity: "error",
          source: "json-parse",
          message: err.message,
        });
      }
    } else if (ext === ".py") {
      try {
        execFileSync("python3", ["-m", "py_compile", absPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
        });
      } catch (err) {
        const stderr = String(err.stderr || err.message || "").trim();
        const lineM = stderr.match(/line (\d+)/i);
        diags.push({
          file: absPath,
          line: lineM ? Number(lineM[1]) : 1,
          severity: "error",
          source: "py_compile",
          message: stderr.split("\n").slice(-3).join(" | "),
        });
      }
    } else if ([".sh", ".bash"].includes(ext)) {
      try {
        execFileSync("bash", ["-n", absPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 4000,
        });
      } catch (err) {
        const stderr = String(err.stderr || err.message || "").trim();
        const lineM = stderr.match(/line (\d+)/i);
        diags.push({
          file: absPath,
          line: lineM ? Number(lineM[1]) : 1,
          severity: "error",
          source: "bash -n",
          message: stderr,
        });
      }
    } else if ([".ts", ".tsx"].includes(ext) && commandExists("tsc")) {
      try {
        execFileSync("tsc", ["--noEmit", "--pretty", "false", absPath], {
          cwd: cwd || path.dirname(absPath),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 8000,
        });
      } catch (err) {
        const out = String(err.stdout || err.stderr || "").trim();
        for (const line of out.split("\n").slice(0, 10)) {
          const m = line.match(/\((\d+),(\d+)\):\s*(error|warning)\s*(TS\d+):\s*(.+)/);
          if (m) {
            diags.push({
              file: absPath,
              line: Number(m[1]),
              col: Number(m[2]),
              severity: m[3],
              source: `tsc ${m[4]}`,
              message: m[5],
            });
          }
        }
      }
    }
  } catch {
    // Graceful degradation
  }
  return diags;
}

function formatLocation(loc) {
  if (!loc) return null;
  const uri = loc.uri || loc.targetUri;
  const range = loc.range || loc.targetSelectionRange || loc.targetRange;
  return {
    file: uri?.startsWith("file://") ? fileURLToPath(uri) : uri,
    line: (range?.start?.line ?? 0) + 1,
    col: (range?.start?.character ?? 0) + 1,
  };
}

export async function lspQuery({ action, filePath, line = 1, col = 1, query = "", newName = "", cwd, dataDir }) {
  const rootDir = path.resolve(cwd || process.cwd());
  if (action === "status") {
    return {
      availableServers: detectAvailableLsps(),
      runningServers: [...activeServers.values()].map((s) => ({
        id: s.spec.id,
        rootDir: s.rootDir,
        openedDocs: s.openedDocs.size,
      })),
    };
  }

  const absPath = filePath ? path.resolve(rootDir, filePath) : null;
  if (!absPath || !fs.existsSync(absPath)) {
    throw new Error(`File not found for LSP query: ${filePath}`);
  }

  if (action === "diagnostics") {
    const fast = runFastDiagnostics(absPath, rootDir);
    const server = await getOrStartServer(absPath, rootDir, dataDir).catch(() => null);
    let lspDiags = [];
    if (server) {
      const uri = server.syncDocument(absPath);
      await new Promise((r) => setTimeout(r, 350));
      const raw = server.diagnostics.get(uri) || [];
      lspDiags = raw.map((d) => ({
        file: absPath,
        line: (d.range?.start?.line ?? 0) + 1,
        col: (d.range?.start?.character ?? 0) + 1,
        severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
        source: d.source || server.spec.id,
        message: d.message,
      }));
    }
    const merged = lspDiags.length > 0 ? lspDiags : fast;
    if (dataDir) {
      updateState(dataDir, (s) => {
        if (merged.length > 0) s.diagnostics[absPath] = merged;
        else delete s.diagnostics[absPath];
      });
    }
    return {
      file: absPath,
      engine: server ? server.spec.id : "fast-cli-checker",
      diagnostics: merged,
    };
  }

  const server = await getOrStartServer(absPath, rootDir, dataDir);
  if (!server) {
    // Graceful structural symbol fallback when no language server binary is installed
    if (action === "document_symbols") {
      const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
      const symbols = [];
      const symRe =
        /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|def|fn|struct|enum|impl|func)\s+([A-Za-z_][A-Za-z0-9_]*)/;
      lines.forEach((l, idx) => {
        const m = l.match(symRe);
        if (m) symbols.push({ name: m[1], line: idx + 1, preview: l.trim().slice(0, 80) });
      });
      return {
        file: absPath,
        engine: "regex-symbol-fallback (install language server for full LSP)",
        symbols,
      };
    }
    return {
      file: absPath,
      engine: "none",
      note: `No installed LSP server found for ${path.extname(absPath)}. Available checks: ${detectAvailableLsps()
        .filter((s) => s.installed)
        .map((s) => s.id)
        .join(", ") || "none"}. Install typescript-language-server, pyright, rust-analyzer, gopls, or clangd for full semantic queries.`,
    };
  }

  const uri = server.syncDocument(absPath);
  const pos = { line: Math.max(0, Number(line) - 1), character: Math.max(0, Number(col) - 1) };

  if (action === "definition") {
    const res = await server.request("textDocument/definition", { textDocument: { uri }, position: pos });
    const list = Array.isArray(res) ? res : res ? [res] : [];
    return { engine: server.spec.id, definitions: list.map(formatLocation) };
  }
  if (action === "references") {
    const res = await server.request("textDocument/references", {
      textDocument: { uri },
      position: pos,
      context: { includeDeclaration: true },
    });
    return { engine: server.spec.id, references: (res || []).map(formatLocation) };
  }
  if (action === "hover") {
    const res = await server.request("textDocument/hover", { textDocument: { uri }, position: pos });
    return { engine: server.spec.id, hover: res?.contents || null };
  }
  if (action === "document_symbols") {
    const res = await server.request("textDocument/documentSymbol", { textDocument: { uri } });
    return { engine: server.spec.id, symbols: res || [] };
  }
  if (action === "workspace_symbols") {
    const res = await server.request("workspace/symbol", { query });
    return { engine: server.spec.id, symbols: (res || []).slice(0, 50) };
  }
  if (action === "rename_preview") {
    const res = await server.request("textDocument/rename", {
      textDocument: { uri },
      position: pos,
      newName,
    });
    return { engine: server.spec.id, workspaceEdit: res || null };
  }
  throw new Error(`Unknown LSP action: ${action}`);
}

export function shutdownAllLsps() {
  for (const s of activeServers.values()) s.stop();
  activeServers.clear();
}
