import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, updateState } from "./state.mjs";

const DEFAULT_RULES = [
  {
    name: "no-hardcoded-secrets",
    enabled: true,
    mode: "block",
    pattern: "(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)",
    globs: "*",
    message: "Never write hardcoded API keys, GitHub tokens, or private keys into source files. Load secrets from environment variables or a secret manager.",
    builtin: true,
  },
  {
    name: "no-destructive-rm-rf-root",
    enabled: true,
    mode: "block",
    pattern: "rm\\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\\s+(?:/|~|\\$HOME)(?:\\s|$)",
    globs: "*",
    message: "Refuse destructive recursive deletion targeting /, ~, or $HOME.",
    builtin: true,
  },
];

function rulesFilePath(dataDir) {
  return path.join(resolveDataDir(dataDir), "ttsr-rules.json");
}

function loadGlobalRules(dataDir) {
  const file = rulesFilePath(dataDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(raw)) return raw;
  } catch {
    // initialize with defaults
  }
  fs.writeFileSync(file, JSON.stringify(DEFAULT_RULES, null, 2), "utf8");
  return [...DEFAULT_RULES];
}

function saveGlobalRules(dataDir, rules) {
  const file = rulesFilePath(dataDir);
  fs.writeFileSync(file, JSON.stringify(rules, null, 2), "utf8");
}

function loadProjectRules(cwd) {
  if (!cwd) return [];
  const candidates = [
    path.join(cwd, ".omp-rules.json"),
    path.join(cwd, ".agents", "omp-rules.json"),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(parsed)) {
        return parsed.map((r) => ({ ...r, source: p }));
      }
    } catch {
      // ignore missing
    }
  }
  return [];
}

export function listAllTtsrRules(dataDir, cwd) {
  const globalRules = loadGlobalRules(dataDir).map((r) => ({ ...r, scope: "global" }));
  const projectRules = loadProjectRules(cwd).map((r) => ({ ...r, scope: "project" }));
  const byName = new Map();
  for (const r of globalRules) byName.set(r.name, r);
  for (const r of projectRules) byName.set(r.name, r);
  return [...byName.values()];
}

function globMatches(globsStr, filePath) {
  if (!globsStr || globsStr.trim() === "*" || !filePath) return true;
  const patterns = globsStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const normPath = filePath.replace(/\\/g, "/");
  for (const pat of patterns) {
    const escaped = pat
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(?:.*/)?")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    if (new RegExp(`(?:^|/)${escaped}$`).test(normPath)) return true;
  }
  return false;
}

export function matchTtsrRules({ text, filePath = "", dataDir, cwd }) {
  const rules = listAllTtsrRules(dataDir, cwd).filter((r) => r.enabled !== false);
  const hits = [];
  for (const rule of rules) {
    if (!globMatches(rule.globs, filePath)) continue;
    try {
      const re = new RegExp(rule.pattern, "m");
      const m = re.exec(text);
      if (m) {
        hits.push({
          name: rule.name,
          mode: rule.mode || "block",
          message: rule.message,
          matched: m[0].slice(0, 120),
          filePath,
          scope: rule.scope,
        });
      }
    } catch {
      // ignore malformed user regex
    }
  }
  return hits;
}

export function recordTtsrAlert(dataDir, hit, toolName) {
  return updateState(dataDir, (s) => {
    s.ttsrAlerts = s.ttsrAlerts || [];
    s.ttsrAlerts.unshift({
      rule: hit.name,
      mode: hit.mode,
      message: hit.message,
      matched: hit.matched,
      filePath: hit.filePath,
      tool: toolName,
      timestamp: new Date().toISOString(),
    });
    if (s.ttsrAlerts.length > 25) s.ttsrAlerts.length = 25;
  });
}

export function ttsrManage({ action, name, pattern, globs = "*", mode = "block", message = "", sampleText = "", filePath = "", dataDir, cwd }) {
  const rules = loadGlobalRules(dataDir);

  if (action === "list") {
    return { rules: listAllTtsrRules(dataDir, cwd) };
  }
  if (action === "add") {
    if (!name || !pattern || !message) {
      throw new Error("ttsr_manage add requires `name`, `pattern`, and `message`.");
    }
    // Validate regex upfront
    new RegExp(pattern, "m");
    const idx = rules.findIndex((r) => r.name === name);
    const entry = { name, enabled: true, mode, pattern, globs, message };
    if (idx >= 0) rules[idx] = entry;
    else rules.push(entry);
    saveGlobalRules(dataDir, rules);
    return { action: "added", rule: entry, totalRules: rules.length };
  }
  if (action === "remove") {
    const filtered = rules.filter((r) => r.name !== name);
    saveGlobalRules(dataDir, filtered);
    return { action: "removed", name, totalRules: filtered.length };
  }
  if (action === "enable" || action === "disable") {
    const target = rules.find((r) => r.name === name);
    if (!target) throw new Error(`TTSR rule "${name}" not found.`);
    target.enabled = action === "enable";
    saveGlobalRules(dataDir, rules);
    return { action, rule: target };
  }
  if (action === "test") {
    const hits = matchTtsrRules({ text: sampleText, filePath, dataDir, cwd });
    return { matched: hits.length > 0, hits };
  }
  throw new Error(`Unknown ttsr_manage action "${action}".`);
}
