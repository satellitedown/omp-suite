import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export function resolveDataDir(explicitDir) {
  const dir =
    explicitDir ||
    process.env.OMP_SUITE_DATA_DIR ||
    process.env.PLUGIN_DATA ||
    path.join(os.homedir(), ".gemini", "antigravity-cli", "plugin-data", "omp-suite");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function workspaceKey(cwd) {
  const normalized = path.resolve(cwd || process.cwd());
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    session: {
      title: "OMP Suite Session",
      model: "Gemini 4",
      effort: "high",
      cwd: process.cwd(),
      turns: 0,
      tokensUsed: 0,
      contextWindow: 1048576,
    },
    diagnostics: {},
    pendingDiagnosticsInjection: [],
    stagedCodemods: {},
    dapSessions: {},
    lspServers: {},
    ttsrAlerts: [],
    advisorNotes: [],
    pendingAdvisorInjection: [],
    recentTools: [],
    evalSessions: {},
  };
}

export function readState(dataDir) {
  const file = path.join(resolveDataDir(dataDir), "state.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

export function writeState(dataDir, state) {
  const dir = resolveDataDir(dataDir);
  const file = path.join(dir, "state.json");
  const tmp = path.join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return state;
}

export function updateState(dataDir, mutator) {
  const state = readState(dataDir);
  mutator(state);
  return writeState(dataDir, state);
}

export function recordToolActivity(dataDir, entry) {
  return updateState(dataDir, (s) => {
    s.recentTools = s.recentTools || [];
    s.recentTools.unshift({
      id: entry.id || crypto.randomBytes(4).toString("hex"),
      tool: entry.tool,
      summary: entry.summary || "",
      status: entry.status || "ok",
      durationMs: entry.durationMs ?? null,
      detail: entry.detail || "",
      timestamp: new Date().toISOString(),
    });
    if (s.recentTools.length > 40) s.recentTools.length = 40;
  });
}

export function getGitTelemetry(cwd) {
  const target = cwd || process.cwd();
  const info = {
    isGitRepo: false,
    root: target,
    projectName: path.basename(path.resolve(target)),
    branch: "",
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    ahead: 0,
    behind: 0,
  };
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    info.isGitRepo = true;
    info.root = root;
    info.projectName = path.basename(root);

    const status = execFileSync("git", ["status", "--porcelain=v1", "--branch"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const lines = status.split("\n").filter(Boolean);
    if (lines[0]?.startsWith("## ")) {
      const header = lines[0].slice(3);
      const branchPart = header.split("...")[0].replace(/^No commits yet on /, "");
      info.branch = branchPart.split(" ")[0] || "HEAD";
      const aheadM = header.match(/ahead (\d+)/);
      const behindM = header.match(/behind (\d+)/);
      if (aheadM) info.ahead = Number(aheadM[1]);
      if (behindM) info.behind = Number(behindM[1]);
    }
    for (const line of lines.slice(1)) {
      const xy = line.slice(0, 2);
      if (xy === "??") {
        info.untracked++;
      } else if (["UU", "AA", "DD", "AU", "UA", "DU", "UD"].includes(xy)) {
        info.conflicts++;
      } else {
        if (xy[0] !== " " && xy[0] !== "?") info.staged++;
        if (xy[1] !== " " && xy[1] !== "?") info.modified++;
      }
    }
  } catch {
    // Not a git repo or git unavailable
  }
  return info;
}
