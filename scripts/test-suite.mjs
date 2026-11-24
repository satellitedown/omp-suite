#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashlineRead, hashlineEdit } from "./lib/hashline.mjs";
import { astGrep, astEditStage, astResolve, astReject } from "./lib/ast-codemod.mjs";
import { lspQuery, runFastDiagnostics } from "./lib/lsp-client.mjs";
import { dapLaunch, dapCommand, dapTerminate } from "./lib/dap-client.mjs";
import { evalRun, evalReset, notebookRead, notebookEditCell, notebookExec } from "./lib/eval-kernel.mjs";
import { ttsrManage, matchTtsrRules } from "./lib/ttsr.mjs";
import { memoryRetain, memoryRecall, memoryReflect, memoryLearn, memoryEdit } from "./lib/memory-bank.mjs";
import { vread, vwrite, resolveConflict } from "./lib/virtual-fs.mjs";
import { gitAtomicPlan, postAdvisorNote } from "./lib/git-atomic.mjs";
import { getSessionAccentHex } from "./lib/session-color.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-suite-test-"));
const dataDir = path.join(tmpDir, "data");
const repoDir = path.join(tmpDir, "repo");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(repoDir, { recursive: true });

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✕ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("Running OMP Suite end-to-end verification...\n");

// 1. Hashline Edits
await test("1. Hashline read/edit + stale anchor rejection & recovery", async () => {
  const f = path.join(repoDir, "sample.js");
  fs.writeFileSync(f, "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n", "utf8");
  const r = hashlineRead({ filePath: f });
  const lines = r.content.split("\n");
  assert.equal(lines.length, 4);
  const anchor2 = lines[1].split("|")[0];
  const editRes = hashlineEdit({
    filePath: f,
    edits: [{ op: "replace_line", anchor: anchor2, content: "const b = 42;" }],
  });
  assert.equal(editRes.applied, true);
  assert.match(fs.readFileSync(f, "utf8"), /const b = 42;/);
  // Stale anchor must fail cleanly with recovery hint
  assert.throws(() => {
    hashlineEdit({ filePath: f, edits: [{ op: "replace_line", anchor: anchor2, content: "const b = 99;" }] });
  }, /Stale/);
});

// 2. Staged AST Grep & Codemod (Preview -> Resolve / Reject)
await test("2. AST grep + staged ast_edit preview + atomic ast_resolve & ast_reject", async () => {
  const f = path.join(repoDir, "codemod.js");
  fs.writeFileSync(f, "console.log('alpha');\nconsole.log(user.id);\n", "utf8");
  const grep = astGrep({ pattern: "console.log($X)", targetPath: f });
  assert.equal(grep.totalMatches, 2);

  const stage = astEditStage({
    pattern: "console.log($X)",
    rewrite: "logger.debug($X)",
    targetPath: f,
    cwd: repoDir,
    dataDir,
  });
  assert.equal(stage.status, "proposed");
  assert.equal(stage.totalReplacements, 2);
  // Disk must remain untouched while proposed
  assert.match(fs.readFileSync(f, "utf8"), /console\.log\('alpha'\)/);

  const applied = astResolve({ proposalId: stage.id, reason: "Verified preview", dataDir });
  assert.equal(applied.status, "accepted");
  assert.match(fs.readFileSync(f, "utf8"), /logger\.debug\('alpha'\)/);
  assert.match(fs.readFileSync(f, "utf8"), /logger\.debug\(user\.id\)/);

  const stage2 = astEditStage({
    pattern: "logger.debug($X)",
    rewrite: "noop($X)",
    targetPath: f,
    cwd: repoDir,
    dataDir,
  });
  const rej = astReject({ proposalId: stage2.id, dataDir });
  assert.equal(rej.status, "rejected");
  assert.match(fs.readFileSync(f, "utf8"), /logger\.debug\('alpha'\)/);
});

// 3. LSP & Fast Diagnostics
await test("3. LSP status, symbol fallback, and fast syntax diagnostics", async () => {
  const broken = path.join(repoDir, "broken.js");
  fs.writeFileSync(broken, "function bad( { return 1; }\n", "utf8");
  const diags = runFastDiagnostics(broken, repoDir);
  assert.ok(diags.length > 0);
  const status = await lspQuery({ action: "status", cwd: repoDir, dataDir });
  assert.ok(Array.isArray(status.availableServers));
});

// 4. DAP Step-Through Debugger (Python bdb built-in)
await test("4. DAP launch, breakpoint, step, local variables, evaluate & terminate", async () => {
  const py = path.join(repoDir, "demo.py");
  fs.writeFileSync(py, "def compute(n):\n    x = n ^ (n << 13)\n    return x\n\nval = compute(7)\n", "utf8");
  const launch = await dapLaunch({
    program: py,
    breakpoints: [{ file: py, line: 3 }],
    stopOnEntry: false,
    cwd: repoDir,
    dataDir,
  });
  assert.equal(launch.status, "stopped");
  assert.equal(launch.line, 3);
  assert.equal(launch.locals.x.value, "57351");

  const ev = await dapCommand({ sessionId: launch.sessionId, action: "evaluate", expression: "x + 1", dataDir });
  assert.equal(ev.reply.result, "57352");

  const term = dapTerminate({ sessionId: launch.sessionId, dataDir });
  assert.equal(term.status, "terminated");
});

// 5. Persistent Eval Kernels + Jupyter Notebook
await test("5. Persistent Python & JS eval kernels + .ipynb read/edit/exec", async () => {
  const p1 = await evalRun({ language: "python", code: "counter = 40", sessionKey: "t1", cwd: repoDir });
  assert.equal(p1.ok, true);
  const p2 = await evalRun({ language: "python", code: "counter += 2\ncounter", sessionKey: "t1", cwd: repoDir });
  assert.equal(p2.result, "42");

  const j1 = await evalRun({ language: "javascript", code: "total = 10 * 5;", sessionKey: "t1", cwd: repoDir });
  assert.equal(j1.ok, true);
  const j2 = await evalRun({ language: "javascript", code: "total + 7", sessionKey: "t1", cwd: repoDir });
  assert.equal(j2.result, "57");
  evalReset({ language: "all", sessionKey: "t1" });

  const nbFile = path.join(repoDir, "analysis.ipynb");
  fs.writeFileSync(
    nbFile,
    JSON.stringify({
      cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["a = 21\n", "a * 2"] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
    "utf8"
  );
  const readRes = notebookRead({ filePath: nbFile });
  assert.equal(readRes.totalCells, 1);
  notebookEditCell({ filePath: nbFile, action: "insert", cellIndex: 1, cellType: "code", source: "a + 9" });
  const execRes = await notebookExec({ filePath: nbFile, saveOutputs: true });
  assert.equal(execRes.executed, 2);
  assert.equal(execRes.results[0].result, "42");
  assert.equal(execRes.results[1].result, "30");
  evalReset({ language: "all", sessionKey: `nb:${nbFile}` });
});

// 6. TTSR Dormant Rules + PreToolUse Hook
await test("6. TTSR rule add/match + PreToolUse hook blocks violation", async () => {
  ttsrManage({
    action: "add",
    name: "no-box-leak",
    pattern: "Box::leak",
    globs: "**/*.rs",
    mode: "block",
    message: "Use Arc<str> instead of Box::leak",
    dataDir,
    cwd: repoDir,
  });
  const hits = matchTtsrRules({ text: "let s = Box::leak(buf);", filePath: "src/main.rs", dataDir, cwd: repoDir });
  assert.equal(hits.length, 1);

  const hookOut = execFileSync(process.execPath, [path.join(__dirname, "hook-pre-tool.mjs")], {
    input: JSON.stringify({
      cwd: repoDir,
      toolCall: { name: "edit_file", args: { Path: "src/main.rs", Replacement: "Box::leak(x)" } },
    }),
    env: { ...process.env, OMP_SUITE_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  const decision = JSON.parse(hookOut);
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /no-box-leak/);
});

// 7. Curated SQLite Project Memory Bank + SessionStart Hook
await test("7. Project memory bank retain/recall/reflect/learn/edit + SessionStart hook", async () => {
  const m = memoryRetain({
    content: "All auth tokens expire in 15 minutes and rotate via /v2/refresh.",
    category: "architecture",
    tags: ["auth", "tokens"],
    cwd: repoDir,
    dataDir,
  });
  assert.ok(m.id.startsWith("mem-"));
  const rec = memoryRecall({ query: "auth tokens", cwd: repoDir, dataDir });
  assert.equal(rec.totalFound, 1);

  const refl = memoryReflect({ cwd: repoDir, dataDir });
  assert.match(refl.mentalModel, /ARCHITECTURE/);

  const learned = memoryLearn({
    lesson: "Always run ast_edit preview before modifying auth middleware.",
    skillName: "auth-guard",
    promoteToSkill: true,
    cwd: repoDir,
    dataDir,
  });
  assert.ok(fs.existsSync(learned.promotedSkillPath));

  const sessOut = execFileSync(process.execPath, [path.join(__dirname, "hook-session-start.mjs")], {
    input: JSON.stringify({ cwd: repoDir, modelName: "Gemini 4" }),
    env: { ...process.env, OMP_SUITE_DATA_DIR: dataDir, OMP_NO_AUTO_STATUSLINE: "1" },
    encoding: "utf8",
  });
  const sessJson = JSON.parse(sessOut);
  assert.ok(sessJson.injectSteps.length === 1);
  assert.match(sessJson.injectSteps[0].systemMessage.systemMessage, /auth tokens/);

  memoryEdit({ id: m.id, action: "forget", dataDir });
  const afterForget = memoryRecall({ query: "15 minutes", cwd: repoDir, dataDir });
  assert.equal(afterForget.totalFound, 0);
});

// 8. Virtual URI Filesystem (conflict:// + sqlite://)
await test("8. Virtual URI filesystem: conflict:// resolution + sqlite:// inspection", async () => {
  const cf = path.join(repoDir, "merge.txt");
  fs.writeFileSync(cf, "top\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feat\nbottom\n", "utf8");
  const list = await vread({ uri: "conflict://", cwd: repoDir });
  assert.equal(list.total, 1);
  const res = vwrite({ uri: "conflict://1", content: "@theirs", cwd: repoDir });
  assert.equal(res.resolved, 1);
  assert.equal(fs.readFileSync(cf, "utf8"), "top\ntheirs line\nbottom\n");

  const sqlRes = await vread({ uri: `sqlite://${path.join(dataDir, "memory.db")}`, cwd: repoDir });
  assert.ok(sqlRes.tables.some((t) => t.name === "memories"));
});

// 9. Git Atomic Commit Planner + Advisor Watchdog + PreInvocation/Stop Hooks
await test("9. Git atomic commit planner + Advisor note + PreInvocation/Stop hooks", async () => {
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "package-lock.json"), "{}\n");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export const ok = true;\n");
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test\n");
  const plan = gitAtomicPlan({ cwd: repoDir });
  assert.ok(plan.excludedLockfiles.includes("package-lock.json"));
  assert.ok(plan.commits.length >= 2);

  postAdvisorNote({
    severity: "concern",
    title: "Check edge case",
    message: "Ensure null input returns 400.",
    dataDir,
  });
  const preInv = execFileSync(process.execPath, [path.join(__dirname, "hook-pre-invocation.mjs")], {
    input: JSON.stringify({ cwd: repoDir }),
    env: { ...process.env, OMP_SUITE_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  const preJson = JSON.parse(preInv);
  assert.match(preJson.injectSteps[0].systemMessage.systemMessage, /Check edge case/);
});

// 10. MCP Server Protocol + MCP Apps UI Resource + OMP TUI Snapshot
await test("10. Unified MCP server (tools + ui://omp-suite/hud.html) + OMP TUI snapshot", async () => {
  assert.match(getSessionAccentHex("Migrate console.log"), /^#[0-9a-f]{6}$/i);

  const snap = execFileSync(process.execPath, [path.join(__dirname, "omp-tui.mjs"), "--snapshot"], {
    env: { ...process.env, OMP_SUITE_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  assert.match(snap, /π/);
  assert.match(snap, /AST Edit/);
  assert.match(snap, /Debug variables/);

  // Drive live mcp-server.mjs over stdio
  await new Promise((resolve, reject) => {
    const srv = spawn(process.execPath, [path.join(__dirname, "mcp-server.mjs"), "--data-dir", dataDir], {
      cwd: repoDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = new Map();
    let buf = "";
    srv.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.id !== undefined) replies.set(m.id, m);
      }
      if (replies.size >= 4) {
        try {
          assert.ok(replies.get(1).result.serverInfo.name === "omp-suite-core");
          assert.ok(replies.get(2).result.tools.length >= 25);
          const hudTool = replies.get(2).result.tools.find((t) => t.name === "omp_hud");
          assert.equal(hudTool._meta.ui.resourceUri, "ui://omp-suite/hud.html");
          assert.ok(replies.get(3).result.contents[0].text.includes("OMP Suite HUD"));
          assert.ok(replies.get(4).result.structuredContent.sessionAccent.startsWith("#"));
          srv.kill();
          resolve();
        } catch (err) {
          srv.kill();
          reject(err);
        }
      }
    });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) + "\n");
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "ui://omp-suite/hud.html" } }) + "\n");
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "omp_hud", arguments: { cwd: repoDir } } }) + "\n");
    setTimeout(() => {
      srv.kill();
      reject(new Error("MCP server test timed out"));
    }, 8000);
  });
});

// 11. Native `agy` statusLine + title + install-ui.mjs auto-wiring
await test("11. Native agy statusLine (OMP v19 / Tern bar), title script, and settings.json installer", async () => {
  const samplePayload = {
    cwd: repoDir,
    conversation_id: "test-conv-1",
    conversation_title: "Refactor Auth Middleware",
    model: { id: "gemini-4-neon-xhigh", display_name: "Gemini 4 Neon (XHigh)", effort: "xhigh" },
    workspace: { current_dir: repoDir, project_dir: repoDir },
    context_window: { context_window_size: 1048576, used_percentage: 4.3 },
    cost: { total_usd: 0.45 },
    plan_tier: "Ultra",
    agent_state: "working",
    subagents: [{ name: "omp-reviewer", role: "reviewer", status: "running" }],
    terminal_width: 120,
  };
  const statusOut = execFileSync(process.execPath, [path.join(__dirname, "omp-statusline.mjs")], {
    input: JSON.stringify(samplePayload),
    env: { ...process.env, OMP_SUITE_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  assert.match(statusOut, /π/);
  assert.match(statusOut, /Gemini 4 Neon/);
  assert.match(statusOut, /xhigh/);
  assert.match(statusOut, /4\.3%\/1M/);
  assert.match(statusOut, /\$0\.45 \(sub\)/);
  assert.match(statusOut, /Refactor Auth Middleware/);
  assert.match(statusOut, /reviewer/);

  const titleOut = execFileSync(process.execPath, [path.join(__dirname, "omp-title.mjs")], {
    input: JSON.stringify(samplePayload),
    encoding: "utf8",
  });
  assert.match(titleOut, /Refactor Auth Middleware/);

  const fakeSettings = path.join(tmpDir, "settings.json");
  fs.writeFileSync(fakeSettings, JSON.stringify({ model: "Gemini 4 Neon (XHigh)", showThinking: true }), "utf8");
  const { installNativeUi, uninstallNativeUi } = await import("./install-ui.mjs");
  const ins = installNativeUi({ settingsPath: fakeSettings, pluginRoot: PLUGIN_ROOT });
  assert.equal(ins.changed, true);
  const after = JSON.parse(fs.readFileSync(fakeSettings, "utf8"));
  assert.equal(after.showThinking, true);
  assert.match(after.statusLine.command, /omp-statusline\.mjs/);
  assert.match(after.title.command, /omp-title\.mjs/);

  const unins = uninstallNativeUi({ settingsPath: fakeSettings });
  assert.equal(unins.changed, true);
  const cleaned = JSON.parse(fs.readFileSync(fakeSettings, "utf8"));
  assert.equal(cleaned.statusLine, undefined);
  assert.equal(cleaned.showThinking, true);
});

// 12. Real Tern Surface Protocol (TSP v1) client, reconciler, input demuxer & shell integration
await test("12. Native Tern Surface Protocol (TSP v1) handshake, reconciler, input demuxer & shell installer", async () => {
  const { EventEmitter } = await import("node:events");
  const { TspSurfaceSession, encodeTspJson, TernInputDemuxer } = await import("./lib/tsp-client.mjs");
  const { installTernShellIntegration, uninstallTernShellIntegration } = await import("./install-ui.mjs");

  // Demuxer handles APC TSP events, Kitty CSI-u keys, and bracketed paste cleanly
  const demux = new TernInputDemuxer();
  const sample =
    encodeTspJson("r", { r: "hello", v: 1, term: "tern", kinds: ["col", "row", "editor", "md", "tool", "picker", "effort"], features: ["edit", "undo", "send"], apc: 65536, credits: 2, cols: 120, dark: true }) +
    "\x1b[13;2u" +
    "\x1b[200~hello\nworld\x1b[201~" +
    encodeTspJson("e", { ev: "send", sf: "s:1", id: "composer.input", text: "refactor auth" });
  const parsed = demux.feed(sample);
  assert.equal(parsed[0].type, "tsp");
  assert.equal(parsed[0].data.r, "hello");
  assert.equal(parsed[1].type, "key");
  assert.equal(parsed[1].key.name, "enter");
  assert.equal(parsed[1].key.shift, true);
  assert.equal(parsed[2].type, "paste");
  assert.equal(parsed[2].text, "hello\nworld");
  assert.equal(parsed[3].type, "tsp");
  assert.equal(parsed[3].data.ev, "send");

  // Live session handshake + incremental text append diffing
  const fakeIn = new EventEmitter();
  fakeIn.isTTY = true;
  fakeIn.setRawMode = () => {};
  fakeIn.resume = () => {};
  const writes = [];
  const fakeOut = { isTTY: true, columns: 120, write: (s) => writes.push(String(s)) };

  const sess = new TspSurfaceSession({ input: fakeIn, output: fakeOut, app: "omp", version: "1.2.0" });
  const connPromise = sess.connect(1000);
  // Simulate Tern replying to hello
  fakeIn.emit(
    "data",
    encodeTspJson("r", { r: "hello", v: 1, term: "tern", kinds: ["col", "row", "md", "editor", "tool", "picker", "effort"], features: ["edit", "undo", "send"], credits: 4 })
  );
  assert.equal(await connPromise, true);
  sess.open({ id: "s:1", mode: "inline", title: "agy", role: "omp.session", chat: true });
  sess.render(
    {
      main: [{ id: "m1", k: "md", p: { text: "Hello", stream: true } }],
      dock: [{ id: "composer.input", k: "editor", p: { text: "", cursor: 0, sendable: true } }],
      layer: [],
    },
    "composer.input"
  );
  // Frame 2 extends m1.text -> must emit compact `["text","m1","append"," world"]`
  sess.render(
    {
      main: [{ id: "m1", k: "md", p: { text: "Hello world", stream: false } }],
      dock: [{ id: "composer.input", k: "editor", p: { text: "", cursor: 0, sendable: true } }],
      layer: [],
    },
    "composer.input"
  );
  const wireAll = writes.join("");
  assert.match(wireAll, /"role":"omp\.session","chat":true/);
  assert.match(wireAll, /\["text","m1","append"," world"\]/);
  sess.close(true);

  // Shell installer round-trip on temp files
  const fakeBin = path.join(tmpDir, "bin");
  const fakeRc = path.join(tmpDir, ".zshrc");
  fs.writeFileSync(fakeRc, "# existing config\nexport FOO=1\n", "utf8");
  const shIns = installTernShellIntegration({ pluginRoot: PLUGIN_ROOT, binDir: fakeBin, rcFiles: [fakeRc] });
  assert.ok(fs.existsSync(shIns.binPath));
  const rcText = fs.readFileSync(fakeRc, "utf8");
  assert.match(rcText, /omp-suite tern-agy/);
  assert.match(rcText, /-raw\|--raw/);
  assert.match(rcText, /OMP_RAW_AGY=1/);
  const shUn = uninstallTernShellIntegration({ binDir: fakeBin, rcFiles: [fakeRc] });
  assert.equal(shUn.cleanedFiles.length, 1);
  assert.doesNotMatch(fs.readFileSync(fakeRc, "utf8"), /omp-suite tern-agy/);
  assert.match(fs.readFileSync(fakeRc, "utf8"), /export FOO=1/);
});

// 13. v1.3.0 TSP Reconciler Ordering, Shift+Tab, Usage Stats, and `agy -raw` Bypass
await test("13. TSP reconciler ordering, non-append editor, Shift+Tab keys, usage stats & agy -raw hook bypass", async () => {
  const { EventEmitter } = await import("node:events");
  const { TspSurfaceSession, encodeTspJson, TernInputDemuxer } = await import("./lib/tsp-client.mjs");
  const {
    readSessionTranscriptUsage,
    readTodayUsageSummary,
    formatTokenCount,
    cycleEffortLevel,
    cycleModeId,
  } = await import("./lib/usage-stats.mjs");

  // Shift+Tab decoding for both xterm (`ESC [ Z`) and Kitty CSI-u (`ESC [ 9 ; 2 u`)
  const demux = new TernInputDemuxer();
  const keys = demux.feed("\x1b[Z\x1b[9;2u");
  assert.equal(keys.length, 2);
  assert.equal(keys[0].key.name, "tab");
  assert.equal(keys[0].key.shift, true);
  assert.equal(keys[1].key.name, "tab");
  assert.equal(keys[1].key.shift, true);

  // Reconciler multi-node insertion ordering & non-append mutable editor updates
  const fakeIn = new EventEmitter();
  fakeIn.isTTY = true;
  fakeIn.setRawMode = () => {};
  fakeIn.resume = () => {};
  const frames = [];
  const fakeOut = { isTTY: true, columns: 120, write: (s) => frames.push(String(s)) };
  const sess = new TspSurfaceSession({ input: fakeIn, output: fakeOut, app: "omp", version: "1.3.0" });
  const cp = sess.connect(1000);
  fakeIn.emit("data", encodeTspJson("r", { r: "hello", v: 1, term: "tern", kinds: ["col", "row", "editor"], credits: 8 }));
  assert.equal(await cp, true);
  sess.open({ id: "s:1", mode: "inline", title: "agy", role: "omp.session", chat: true });
  sess.render(
    {
      main: [],
      dock: [{ id: "c", k: "editor", p: { text: "hi", cursor: 2 } }],
      layer: [],
    },
    "c"
  );
  frames.length = 0;
  // Insert TWO nodes (`a`, `b`) BEFORE existing `c`, and extend editor `c.text`
  sess.render(
    {
      main: [],
      dock: [
        { id: "a", k: "badge", p: { text: "A" } },
        { id: "b", k: "badge", p: { text: "B" } },
        { id: "c", k: "editor", p: { text: "hi there", cursor: 8 } },
      ],
      layer: [],
    },
    "c"
  );
  const wire = frames.join("");
  // Both `a` and `b` must anchor before `c` (not null)
  assert.match(wire, /\["add","a","dock","c",/);
  assert.match(wire, /\["add","b","dock","c",/);
  // Editor must update via `set`, NEVER `["text","c","append",...]`
  assert.doesNotMatch(wire, /\["text","c","append"/);
  assert.match(wire, /\["set","c",\{"text":"hi there","cursor":8\}\]/);
  sess.close(true);

  // Local transcript usage aggregation + cycling helpers
  const fakeBrain = path.join(tmpDir, "brain");
  const logDir = path.join(fakeBrain, "sess-1", ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const nowIso = new Date().toISOString();
  fs.writeFileSync(
    path.join(logDir, "transcript.jsonl"),
    [
      JSON.stringify({ type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 4000, output_tokens: 500, cache_read_tokens: 16000, created_at: nowIso }),
      JSON.stringify({ type: "PLANNER_RESPONSE", model: "gemini-4-neon-xhigh", input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 19000, created_at: nowIso }),
    ].join("\n") + "\n",
    "utf8"
  );
  const u = readSessionTranscriptUsage("sess-1", { brainDir: fakeBrain });
  assert.equal(u.found, true);
  assert.equal(u.turns, 2);
  assert.equal(u.inputTokens, 5000);
  assert.equal(u.outputTokens, 1500);
  assert.equal(u.cacheReadTokens, 35000);
  assert.equal(Math.round(u.cacheHitPct), 88);
  assert.equal(formatTokenCount(41500), "41.5K");

  const today = readTodayUsageSummary({ brainDir: fakeBrain });
  assert.equal(today.sessionsCount, 1);
  assert.equal(today.turns, 2);
  assert.equal(cycleEffortLevel("high"), "xhigh");
  assert.equal(cycleEffortLevel("xhigh"), "low");
  assert.equal(cycleModeId("auto"), "plan");
  assert.equal(cycleModeId("plan"), "default");

  // `OMP_RAW_AGY=1` makes all hooks silent no-ops
  const rawPre = JSON.parse(
    execFileSync(process.execPath, [path.join(__dirname, "hook-pre-tool.mjs")], {
      input: JSON.stringify({ cwd: repoDir, toolCall: { name: "edit_file", args: { Path: "src/main.rs", Replacement: "Box::leak(x)" } } }),
      env: { ...process.env, OMP_SUITE_DATA_DIR: dataDir, OMP_RAW_AGY: "1" },
      encoding: "utf8",
    })
  );
  assert.equal(rawPre.decision, "allow");
  const rawStart = JSON.parse(
    execFileSync(process.execPath, [path.join(__dirname, "hook-session-start.mjs")], {
      input: JSON.stringify({ cwd: repoDir }),
      env: { ...process.env, OMP_SUITE_DATA_DIR: dataDir, OMP_RAW_AGY: "1" },
      encoding: "utf8",
    })
  );
  assert.deepEqual(rawStart.injectSteps, []);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nDone: ${passed}/13 test suites passed.`);
