import { OMP_DARK_THEME, getSessionAccentHex } from "./session-color.mjs";

/**
 * Generates the interactive single-file MCP App HTML (`text/html;profile=mcp-app`)
 * implementing `io.modelcontextprotocol/ui` + `com.google.antigravity/ui`
 * in the exact visual aesthetic of the newest Oh My Pi v19 / Tern UI.
 */
export function buildOmpHudHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OMP Suite HUD</title>
<style>
  :root {
    --page-bg: ${OMP_DARK_THEME.pageBg};
    --chrome-bg: ${OMP_DARK_THEME.chromeBg};
    --card-bg: ${OMP_DARK_THEME.cardBg};
    --info-bg: ${OMP_DARK_THEME.infoBg};
    --selected-bg: ${OMP_DARK_THEME.selectedBg};
    --tool-ok-bg: ${OMP_DARK_THEME.toolSuccessBg};
    --tool-err-bg: ${OMP_DARK_THEME.toolErrorBg};
    --fg: ${OMP_DARK_THEME.foreground};
    --fg-bright: ${OMP_DARK_THEME.textBright};
    --muted: ${OMP_DARK_THEME.muted};
    --dim: ${OMP_DARK_THEME.dim};
    --border-muted: ${OMP_DARK_THEME.borderMuted};
    --cyan: ${OMP_DARK_THEME.cyan};
    --blue: ${OMP_DARK_THEME.blue};
    --green: ${OMP_DARK_THEME.green};
    --red: ${OMP_DARK_THEME.red};
    --yellow: ${OMP_DARK_THEME.yellow};
    --accent: ${OMP_DARK_THEME.accent};
    --lavender: ${OMP_DARK_THEME.lavender};
    --purple: ${OMP_DARK_THEME.purple};
    --rose: ${OMP_DARK_THEME.rose};
    --teal: ${OMP_DARK_THEME.teal};
    --git-clean: ${OMP_DARK_THEME.gitClean};
    --git-dirty: ${OMP_DARK_THEME.gitDirty};
    --session-accent: #89d281;
    --mono: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--page-bg);
    color: var(--fg);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    padding: 12px 14px 14px;
    gap: 10px;
  }

  /* Signature OMP v19 Top / Composer Statusline Frame */
  .omp-frame {
    border: 1px solid var(--session-accent);
    border-radius: 6px;
    background: var(--chrome-bg);
    padding: 8px 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    position: relative;
  }
  .omp-status-left {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .pi-glyph {
    font-weight: 800;
    font-size: 15px;
    background: linear-gradient(135deg, #f472d0, #9d7bff 55%, #38bdf8);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
  }
  .sep { color: var(--dim); }
  .seg-model { color: var(--cyan); font-weight: 600; }
  .seg-effort { color: var(--purple); }
  .seg-path { color: var(--fg-bright); }
  .seg-git-clean { color: var(--git-clean); }
  .seg-git-dirty { color: var(--git-dirty); }
  .seg-ctx { color: #8787af; }
  .seg-session {
    color: var(--session-accent);
    font-weight: 600;
    margin-left: auto;
  }

  /* Tern Live Tray Strip */
  .tray-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }
  .tray-card {
    background: var(--card-bg);
    border: 1px solid var(--border-muted);
    border-left: 3px solid var(--cyan);
    border-radius: 4px;
    padding: 7px 9px;
    cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .tray-card:hover, .tray-card.active {
    background: var(--info-bg);
    border-color: var(--session-accent);
  }
  .tray-card.tone-success { border-left-color: var(--green); }
  .tray-card.tone-warn { border-left-color: var(--accent); }
  .tray-card.tone-error { border-left-color: var(--red); }
  .tray-card.tone-purple { border-left-color: var(--purple); }
  .tray-label {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--muted);
  }
  .tray-val {
    font-size: 15px;
    font-weight: 700;
    color: var(--fg-bright);
    margin-top: 2px;
  }
  .tray-sub {
    font-size: 10.5px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Tabs */
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    border-bottom: 1px solid var(--border-muted);
    padding-bottom: 6px;
  }
  .tab {
    background: transparent;
    color: var(--muted);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 4px 9px;
    font-family: var(--mono);
    font-size: 11.5px;
    cursor: pointer;
  }
  .tab:hover { color: var(--fg-bright); background: var(--card-bg); }
  .tab.active {
    color: var(--session-accent);
    background: var(--card-bg);
    border-color: var(--border-muted);
  }

  /* OMP Crisp Tool Card */
  .omp-card {
    background: var(--tool-ok-bg);
    border: 1px solid var(--border-muted);
    border-radius: 4px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .omp-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border-muted);
    background: var(--card-bg);
    gap: 8px;
  }
  .omp-card-title { font-weight: 600; color: var(--fg-bright); }
  .ok { color: var(--green); }
  .warn { color: var(--accent); }
  .err { color: var(--red); }
  .info { color: var(--cyan); }
  .tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10.5px;
    border: 1px solid var(--border-muted);
    color: var(--lavender);
    background: var(--info-bg);
  }
  .omp-card-body {
    padding: 8px 10px;
    font-size: 11.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .sub-divider {
    color: var(--muted);
    font-size: 10.5px;
    border-top: 1px solid var(--border-muted);
    margin: 6px -10px;
    padding: 4px 10px 0;
  }

  /* Left-accent callouts (Advisor & TTSR style) */
  .callout {
    border-left: 2px solid var(--cyan);
    padding: 6px 10px;
    margin-bottom: 8px;
    background: rgba(30, 30, 36, 0.7);
  }
  .callout.concern, .callout.ttsr { border-left-color: var(--accent); }
  .callout.blocker { border-left-color: var(--red); background: var(--tool-err-bg); }
  .callout-hdr { font-weight: 600; margin-bottom: 2px; }

  /* Diff coloring */
  .diff-add { color: var(--green); }
  .diff-del { color: var(--red); }
  .diff-hunk { color: var(--cyan); }

  /* Buttons & Inputs */
  .btn-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  button.btn {
    font-family: var(--mono);
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--border-muted);
    background: var(--info-bg);
    color: var(--fg-bright);
    cursor: pointer;
  }
  button.btn:hover { border-color: var(--session-accent); }
  button.btn-accept { border-color: var(--green); color: var(--green); }
  button.btn-reject { border-color: var(--red); color: var(--red); }
  button.btn-accent { border-color: var(--accent); color: var(--accent); }
  input.inp, select.inp {
    font-family: var(--mono);
    font-size: 11.5px;
    background: var(--chrome-bg);
    color: var(--fg-bright);
    border: 1px solid var(--border-muted);
    border-radius: 4px;
    padding: 5px 8px;
  }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  .row input.inp { flex: 1; }
  .empty { color: var(--dim); padding: 14px 4px; font-style: italic; }
  .footer-bar {
    margin-top: auto;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10.5px;
    color: var(--dim);
    border-top: 1px solid var(--border-muted);
    padding-top: 6px;
  }
</style>
</head>
<body>
<div class="shell">
  <!-- Signature OMP v19 Rounded Statusline Header -->
  <div class="omp-frame" id="statusFrame">
    <div class="omp-status-left">
      <span class="pi-glyph">π</span>
      <span class="sep">❯</span>
      <span class="seg-model" id="segModel">⚙ OMP Suite</span>
      <span class="seg-effort" id="segEffort">· ● high</span>
      <span class="sep">│</span>
      <span class="seg-path" id="segPath">📁 workspace</span>
      <span class="seg-git-clean" id="segGit">⎇ main</span>
      <span class="sep">│</span>
      <span class="seg-ctx" id="segCtx">◫ ready</span>
    </div>
    <span class="seg-session" id="segSession">OMP Suite HUD</span>
  </div>

  <!-- Tern Live Activity Tray -->
  <div class="tray-strip" id="trayStrip"></div>

  <!-- View Tabs -->
  <div class="tabs" id="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="codemods">AST Codemods</button>
    <button class="tab" data-tab="debug">Debugger (DAP)</button>
    <button class="tab" data-tab="conflicts">Conflicts</button>
    <button class="tab" data-tab="memory">Memory Bank</button>
    <button class="tab" data-tab="guardrails">TTSR &amp; Advisor</button>
  </div>

  <div id="viewRoot"></div>

  <div class="footer-bar">
    <span id="footHint">OMP v19 / Tern HUD · MCP App</span>
    <div style="display:flex;gap:6px;">
      <button class="btn" id="btnRefresh">↻ Refresh</button>
    </div>
  </div>
</div>

<script>
(() => {
  let activeTab = "overview";
  let hudData = null;
  let rpcId = 1;
  const pending = new Map();

  function postRpc(method, params) {
    const id = rpcId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("Host RPC timeout"));
        }
      }, 10000);
    });
  }

  function sendNotification(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  }

  function notifySize() {
    const h = Math.min(780, Math.max(260, document.documentElement.scrollHeight));
    sendNotification("ui/notifications/size-changed", { height: h });
  }

  async function callTool(name, args) {
    const res = await postRpc("tools/call", { name, arguments: args || {} });
    if (res && res.structuredContent) return res.structuredContent;
    if (res && res.content && res.content[0] && res.content[0].text) {
      try { return JSON.parse(res.content[0].text); } catch { return { text: res.content[0].text }; }
    }
    return res;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderDiff(diffText) {
    return esc(diffText || "")
      .split("\\n")
      .map((line) => {
        if (line.startsWith("+") && !line.startsWith("+++")) return '<span class="diff-add">' + line + '</span>';
        if (line.startsWith("-") && !line.startsWith("---")) return '<span class="diff-del">' + line + '</span>';
        if (line.startsWith("@@")) return '<span class="diff-hunk">' + line + '</span>';
        return line;
      })
      .join("\\n");
  }

  function render() {
    const root = document.getElementById("viewRoot");
    const tray = document.getElementById("trayStrip");
    if (!hudData) {
      root.innerHTML = '<div class="empty">Connecting to omp-suite MCP server…</div>';
      notifySize();
      return;
    }

    const accent = hudData.sessionAccent || "#89d281";
    document.documentElement.style.setProperty("--session-accent", accent);

    const git = hudData.git || {};
    const sess = hudData.session || {};
    document.getElementById("segModel").textContent = "⚙ " + (sess.model || "Antigravity");
    document.getElementById("segEffort").textContent = "· ● " + (sess.effort || "high");
    document.getElementById("segPath").textContent = "📁 " + (git.projectName || "workspace");

    const gitEl = document.getElementById("segGit");
    if (git.isGitRepo) {
      const dirty = (git.staged || 0) + (git.modified || 0) + (git.untracked || 0);
      gitEl.className = dirty > 0 ? "seg-git-dirty" : "seg-git-clean";
      const parts = ["⎇ " + (git.branch || "HEAD")];
      if (git.staged) parts.push("*" + git.staged);
      if (git.modified) parts.push("~" + git.modified);
      if (git.untracked) parts.push("+" + git.untracked);
      if (git.conflicts) parts.push("⚠" + git.conflicts);
      gitEl.textContent = parts.join(" ");
    } else {
      gitEl.textContent = "no-git";
      gitEl.className = "sep";
    }

    const diags = Object.values(hudData.diagnostics || {}).flat();
    const staged = Object.values(hudData.stagedCodemods || {}).filter((c) => c.status === "proposed");
    const dapList = Object.values(hudData.dapSessions || {});
    const activeDap = dapList.filter((d) => d.status !== "terminated");
    const conflicts = hudData.conflicts || [];
    const memories = hudData.memories || [];
    const alerts = hudData.ttsrAlerts || [];
    const notes = hudData.advisorNotes || [];

    document.getElementById("segCtx").textContent =
      "◫ " + diags.length + " diag · " + staged.length + " staged · " + memories.length + " mem";
    document.getElementById("segSession").textContent = sess.title || git.projectName || "OMP Suite";

    tray.innerHTML = [
      {
        tab: "codemods",
        tone: staged.length ? "tone-warn" : "tone-success",
        label: "AST CODEMODS",
        badge: staged.length ? "proposed" : "idle",
        val: staged.length + " staged",
        sub: staged[0] ? staged[0].pattern : "Preview before apply",
      },
      {
        tab: "debug",
        tone: activeDap.length ? "tone-purple" : "",
        label: "DAP DEBUGGER",
        badge: activeDap[0]?.status || "idle",
        val: activeDap.length ? (activeDap[0].frame || "stopped") : "0 active",
        sub: activeDap[0] ? (activeDap[0].adapter + " :" + activeDap[0].line) : "Breakpoint & step inspector",
      },
      {
        tab: "guardrails",
        tone: (diags.length || alerts.length) ? "tone-error" : "tone-success",
        label: "DIAG & TTSR",
        badge: alerts.length + " rules",
        val: diags.length + " issues",
        sub: notes[0] ? ("Advisor: " + notes[0].severity) : "Clean diagnostics",
      },
      {
        tab: "memory",
        tone: "tone-success",
        label: "MEMORY BANK",
        badge: conflicts.length ? (conflicts.length + " conflicts") : "sqlite",
        val: memories.length + " facts",
        sub: memories[0] ? memories[0].content : "Project-scoped recall",
      },
    ].map((c) =>
      '<div class="tray-card ' + c.tone + (activeTab === c.tab ? ' active' : '') + '" data-jump="' + c.tab + '">' +
        '<div class="tray-label"><span>' + esc(c.label) + '</span><span>' + esc(c.badge) + '</span></div>' +
        '<div class="tray-val">' + esc(c.val) + '</div>' +
        '<div class="tray-sub">' + esc(c.sub) + '</div>' +
      '</div>'
    ).join("");

    tray.querySelectorAll("[data-jump]").forEach((el) => {
      el.addEventListener("click", () => switchTab(el.getAttribute("data-jump")));
    });

    if (activeTab === "overview") renderOverview(root, { diags, staged, activeDap, notes, alerts, recent: hudData.recentTools || [] });
    else if (activeTab === "codemods") renderCodemods(root, Object.values(hudData.stagedCodemods || {}));
    else if (activeTab === "debug") renderDebug(root, dapList);
    else if (activeTab === "conflicts") renderConflicts(root, conflicts);
    else if (activeTab === "memory") renderMemory(root, memories);
    else if (activeTab === "guardrails") renderGuardrails(root, { alerts, notes, rules: hudData.ttsrRules || [], diags });

    notifySize();
  }

  function renderOverview(root, { diags, staged, activeDap, notes, alerts, recent }) {
    let html = "";
    if (notes.length > 0) {
      const n = notes[0];
      html += '<div class="callout ' + esc(n.severity) + '"><div class="callout-hdr info">i Advisor · (' + esc(n.severity) + ') ' + esc(n.title) + '</div><div>' + esc(n.message) + '</div></div>';
    }
    if (alerts.length > 0) {
      const a = alerts[0];
      html += '<div class="callout ttsr"><div class="callout-hdr warn">⚠ TTSR Injecting rule: ' + esc(a.rule) + '</div><div>' + esc(a.message) + '</div></div>';
    }
    if (staged.length > 0) {
      const p = staged[0];
      html += '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title"><span class="ok">✓</span> AST Edit: ' + esc(p.pattern) + ' <span class="warn">(proposed)</span></span><span class="tag">' + p.totalReplacements + ' replacements · ' + p.filesMatched + ' file(s)</span></div>' +
        '<div class="omp-card-body">' + renderDiff(p.files?.[0]?.diff || "") +
        '<div class="btn-row"><button class="btn btn-accept" data-accept="' + esc(p.id) + '">✓ Accept & Apply</button><button class="btn btn-reject" data-reject="' + esc(p.id) + '">✕ Reject</button></div></div></div>';
    }
    if (diags.length > 0) {
      html += '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title"><span class="err">✕</span> Active Diagnostics (' + diags.length + ')</span></div><div class="omp-card-body">' +
        diags.slice(0, 10).map((d) => '<span class="err">[' + esc(d.severity) + ']</span> ' + esc(d.file) + ':' + d.line + ' — ' + esc(d.message)).join("\\n") + '</div></div>';
    }
    html += '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title"><span class="ok">✓</span> Recent OMP Tool Cards</span><span class="tag">' + recent.length + ' events</span></div><div class="omp-card-body">' +
      (recent.length ? recent.slice(0, 12).map((r) => (r.status === "error" ? '<span class="err">✕</span> ' : '<span class="ok">✓</span> ') + '<strong>' + esc(r.tool) + '</strong> ' + esc(r.summary)).join("\\n") : '<span class="empty">No tool events recorded yet in this session.</span>') +
      '</div></div>';
    root.innerHTML = html;
    bindCodemodButtons(root);
  }

  function renderCodemods(root, list) {
    if (!list.length) {
      root.innerHTML = '<div class="empty">No staged AST codemods. Ask the agent to run ast_edit to preview structural rewrites before applying.</div>';
      return;
    }
    root.innerHTML = list.map((p) =>
      '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title">' +
      (p.status === "accepted" ? '<span class="ok">✓ Accept:</span> ' : p.status === "rejected" ? '<span class="err">✕ Rejected:</span> ' : '<span class="warn">◆ Proposed:</span> ') +
      esc(p.pattern) + ' → ' + esc(p.rewrite) + '</span><span class="tag">' + esc(p.id) + ' · ' + p.totalReplacements + ' hits</span></div>' +
      '<div class="omp-card-body">' + (p.files || []).map((f) => '<div><strong>' + esc(f.relPath) + '</strong> (' + f.replacements + ')</div>' + renderDiff(f.diff || "")).join('<div class="sub-divider">Next file</div>') +
      (p.status === "proposed" ? '<div class="btn-row"><button class="btn btn-accept" data-accept="' + esc(p.id) + '">✓ Accept</button><button class="btn btn-reject" data-reject="' + esc(p.id) + '">✕ Reject</button></div>' : '') +
      '</div></div>'
    ).join("");
    bindCodemodButtons(root);
  }

  function renderDebug(root, list) {
    if (!list.length) {
      root.innerHTML = '<div class="empty">No DAP debug sessions yet. Use /omp-debug or dap_launch to attach Python bdb, lldb-dap, or dlv.</div>';
      return;
    }
    root.innerHTML = list.map((d) => {
      const vars = Object.entries(d.locals || {}).map(([k, v]) => '- ' + k + ' = ' + v.value + ' (' + v.type + ')').join("\\n") || "(no locals)";
      return '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title"><span class="ok">✓</span> Debug ' + esc(d.sessionId) + '</span><span class="tag">' + esc(d.adapter) + ' · ' + esc(d.status) + '</span></div>' +
        '<div class="omp-card-body">Program: ' + esc(d.program) + '\\nFrame: ' + esc(d.frame || "-") + '\\nLocation: ' + esc(d.file || "") + ':' + esc(d.line || 0) +
        '<div class="sub-divider">Variables</div>' + esc(vars) +
        (d.status === "stopped" ? '<div class="btn-row">' +
          '<button class="btn" data-dap="' + esc(d.sessionId) + '" data-act="next">↷ Step Over</button>' +
          '<button class="btn" data-dap="' + esc(d.sessionId) + '" data-act="step_in">↓ Step In</button>' +
          '<button class="btn btn-accept" data-dap="' + esc(d.sessionId) + '" data-act="continue">▶ Continue</button>' +
          '<button class="btn btn-reject" data-dap="' + esc(d.sessionId) + '" data-act="terminate">■ Stop</button>' +
        '</div>' : '') +
        '</div></div>';
    }).join("");
    root.querySelectorAll("[data-dap]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sid = btn.getAttribute("data-dap");
        const act = btn.getAttribute("data-act");
        if (act === "terminate") await callTool("dap_terminate", { sessionId: sid });
        else await callTool("dap_command", { sessionId: sid, action: act });
        await refresh();
      });
    });
  }

  function renderConflicts(root, conflicts) {
    if (!conflicts.length) {
      root.innerHTML = '<div class="empty">Zero merge conflicts in workspace. When git conflicts occur, conflict://N cards appear here with one-click @ours / @theirs resolution.</div>';
      return;
    }
    root.innerHTML = conflicts.map((c) =>
      '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title"><span class="warn">⚠</span> ' + esc(c.uri) + ' · ' + esc(c.relFile) + ':' + c.line + '</span></div>' +
      '<div class="omp-card-body"><div class="diff-add"><<<<<<< ' + esc(c.oursLabel || "OURS") + '\\n' + esc(c.ours) + '</div>' +
      '<div class="sub-divider">=======</div><div class="diff-hunk">' + esc(c.theirs) + '>>>>>>> ' + esc(c.theirsLabel || "THEIRS") + '</div>' +
      '<div class="btn-row">' +
        '<button class="btn btn-accept" data-conf="' + esc(c.uri) + '" data-res="@ours">Accept @ours</button>' +
        '<button class="btn btn-accent" data-conf="' + esc(c.uri) + '" data-res="@theirs">Accept @theirs</button>' +
        '<button class="btn" data-conf="' + esc(c.uri) + '" data-res="@both">Keep @both</button>' +
      '</div></div></div>'
    ).join("");
    root.querySelectorAll("[data-conf]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await callTool("conflict_resolve", { target: btn.getAttribute("data-conf"), resolution: btn.getAttribute("data-res"), cwd: hudData.git?.root });
        await refresh();
      });
    });
  }

  function renderMemory(root, memories) {
    let html = '<div class="row"><input class="inp" id="memInput" placeholder="Retain a durable project fact or decision..." /><select class="inp" id="memCat"><option value="fact">fact</option><option value="architecture">architecture</option><option value="lesson">lesson</option><option value="pitfall">pitfall</option></select><button class="btn btn-accept" id="btnRetain">+ Retain</button></div>';
    if (!memories.length) {
      html += '<div class="empty">No memories stored for this workspace yet.</div>';
    } else {
      html += memories.map((m) =>
        '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title"><span class="tag">' + esc(m.category) + '</span> ' + esc(m.id) + '</span><button class="btn btn-reject" data-forget="' + esc(m.id) + '">Forget</button></div>' +
        '<div class="omp-card-body">' + esc(m.content) + '</div></div>'
      ).join("");
    }
    root.innerHTML = html;
    const btnRetain = document.getElementById("btnRetain");
    if (btnRetain) {
      btnRetain.addEventListener("click", async () => {
        const val = document.getElementById("memInput").value.trim();
        const cat = document.getElementById("memCat").value;
        if (!val) return;
        await callTool("memory_retain", { content: val, category: cat, cwd: hudData.git?.root });
        await refresh();
      });
    }
    root.querySelectorAll("[data-forget]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await callTool("memory_edit", { id: btn.getAttribute("data-forget"), action: "forget" });
        await refresh();
      });
    });
  }

  function renderGuardrails(root, { alerts, notes, rules }) {
    let html = '<div class="omp-card"><div class="omp-card-header"><span class="omp-card-title">Dormant TTSR Guardrails (' + rules.length + ')</span></div><div class="omp-card-body">' +
      rules.map((r) => (r.enabled !== false ? '<span class="ok">●</span> ' : '<span class="sep">○</span> ') + '<strong>' + esc(r.name) + '</strong> [' + esc(r.mode) + '] — ' + esc(r.message)).join("\\n") +
      '</div></div>';
    if (notes.length) {
      html += notes.map((n) => '<div class="callout ' + esc(n.severity) + '"><div class="callout-hdr">i Advisor (' + esc(n.severity) + ') · ' + esc(n.title) + '</div><div>' + esc(n.message) + '</div></div>').join("");
    }
    if (alerts.length) {
      html += alerts.map((a) => '<div class="callout ttsr"><div class="callout-hdr warn">⚠ TTSR: ' + esc(a.rule) + ' (' + esc(a.tool) + ')</div><div>' + esc(a.message) + '</div></div>').join("");
    }
    root.innerHTML = html;
  }

  function bindCodemodButtons(root) {
    root.querySelectorAll("[data-accept]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await callTool("ast_resolve", { proposalId: btn.getAttribute("data-accept"), reason: "Accepted from OMP HUD" });
        await refresh();
      });
    });
    root.querySelectorAll("[data-reject]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await callTool("ast_reject", { proposalId: btn.getAttribute("data-reject"), reason: "Rejected from OMP HUD" });
        await refresh();
      });
    });
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tab));
    render();
  }

  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.getAttribute("data-tab")));
  });

  async function refresh() {
    try {
      const data = await callTool("omp_hud", { cwd: hudData?.git?.root || "" });
      if (data && data.git) hudData = data;
      render();
    } catch {
      render();
    }
  }

  document.getElementById("btnRefresh").addEventListener("click", refresh);

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "RPC Error"));
      else resolve(msg.result);
    } else if (msg.method === "ui/notifications/tool-result" && msg.params?.structuredContent) {
      hudData = msg.params.structuredContent;
      render();
    }
  });

  // Standard MCP Apps handshake
  postRpc("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "omp-suite-hud", version: "1.0.0" },
    appCapabilities: {},
  }).then(() => {
    sendNotification("ui/notifications/initialized", {});
    notifySize();
    if (!hudData) refresh();
  }).catch(() => {
    render();
  });
})();
</script>
</body>
</html>`;
}

export function formatHudTextSummary(payload) {
  const git = payload.git || {};
  const diags = Object.values(payload.diagnostics || {}).flat();
  const staged = Object.values(payload.stagedCodemods || {}).filter((c) => c.status === "proposed");
  const activeDap = Object.values(payload.dapSessions || {}).filter((d) => d.status !== "terminated");
  const conflicts = payload.conflicts || [];
  const memories = payload.memories || [];
  const notes = payload.advisorNotes || [];
  const alerts = payload.ttsrAlerts || [];

  const gitPart = git.isGitRepo
    ? `⎇ ${git.branch}${git.staged ? ` *${git.staged}` : ""}${git.modified ? ` ~${git.modified}` : ""}${git.untracked ? ` +${git.untracked}` : ""}`
    : "no-git";

  const lines = [
    `╭─ π ❯ ⚙ ${payload.session?.model || "Antigravity"} · ● ${payload.session?.effort || "high"}  📁 ${git.projectName || "workspace"}  ${gitPart}  ─── ${payload.session?.title || "OMP Suite"} ─╮`,
    `│ Diagnostics: ${diags.length}  · Staged AST: ${staged.length}  · DAP: ${activeDap.length}  · Conflicts: ${conflicts.length}  · Memories: ${memories.length}  · Advisor: ${notes.length}  · TTSR: ${alerts.length}`,
    `╰───────────────────────────────────────────────────────────────────────────────╯`,
  ];

  if (staged.length) {
    lines.push("", "Staged AST Codemods (call ast_resolve / ast_reject):");
    for (const p of staged) {
      lines.push(`  ◆ ${p.id}: ${p.pattern} → ${p.rewrite} (${p.totalReplacements} replacements in ${p.filesMatched} files)`);
    }
  }
  if (diags.length) {
    lines.push("", "Active Diagnostics:");
    for (const d of diags.slice(0, 8)) {
      lines.push(`  ✕ [${d.severity}] ${d.file}:${d.line} — ${d.message}`);
    }
  }
  if (notes.length) {
    lines.push("", "Latest Advisor Notes:");
    for (const n of notes.slice(0, 4)) {
      lines.push(`  i (${n.severity}) ${n.title}: ${n.message}`);
    }
  }
  if (conflicts.length) {
    lines.push("", "Merge Conflicts (use conflict_resolve):");
    for (const c of conflicts.slice(0, 6)) {
      lines.push(`  ⚠ ${c.uri} → ${c.relFile}:${c.line}`);
    }
  }
  return lines.join("\n");
}

export function buildHudPayload({ cwd, dataDir, state, conflicts, memories, ttsrRules }) {
  const sessionName = state.session?.title || state.git?.projectName || "OMP Suite";
  return {
    sessionAccent: getSessionAccentHex(sessionName),
    session: state.session,
    git: state.git,
    diagnostics: state.diagnostics || {},
    stagedCodemods: state.stagedCodemods || {},
    dapSessions: state.dapSessions || {},
    lspServers: state.lspServers || {},
    ttsrAlerts: state.ttsrAlerts || [],
    ttsrRules: ttsrRules || [],
    advisorNotes: state.advisorNotes || [],
    recentTools: state.recentTools || [],
    conflicts: conflicts || [],
    memories: memories || [],
    cwd,
    dataDir,
  };
}
