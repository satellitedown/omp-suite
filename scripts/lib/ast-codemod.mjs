import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildUnifiedDiff } from "./hashline.mjs";
import { updateState, readState } from "./state.mjs";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
  "coverage",
]);

const LANG_EXTENSIONS = {
  ts: [".ts", ".tsx", ".mts", ".cts"],
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  py: [".py"],
  python: [".py"],
  rs: [".rs"],
  rust: [".rs"],
  go: [".go"],
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".h"],
  java: [".java"],
  rb: [".rb"],
  sh: [".sh", ".bash", ".zsh"],
};

function findAstGrepBin() {
  for (const bin of ["ast-grep", "sg"]) {
    try {
      const out = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      if (/ast-grep/i.test(out)) return bin;
    } catch {
      // not present
    }
  }
  return null;
}

function walkFiles(targetPath, lang, maxFiles = 2000) {
  const abs = path.resolve(targetPath);
  const allowedExts = lang && LANG_EXTENSIONS[lang.toLowerCase()] ? new Set(LANG_EXTENSIONS[lang.toLowerCase()]) : null;
  const results = [];

  function visit(p) {
    if (results.length >= maxFiles) return;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (stat.size > 1024 * 1024) return;
      if (allowedExts && !allowedExts.has(path.extname(p).toLowerCase())) return;
      results.push(p);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".agents") {
        if (IGNORE_DIRS.has(ent.name)) continue;
      }
      if (IGNORE_DIRS.has(ent.name)) continue;
      visit(path.join(p, ent.name));
    }
  }

  visit(abs);
  return results;
}

/**
 * Compile an ast-grep-style structural pattern with $VAR and $$$MULTI metavariables
 * into a regex + capture plan that respects identifier boundaries and balanced expressions.
 */
function compileStructuralPattern(pattern) {
  const varOrder = [];
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    // Multi-argument metavariable: $$$NAME
    if (pattern.startsWith("$$$", i)) {
      const m = pattern.slice(i + 3).match(/^([A-Z_][A-Z0-9_]*)/);
      if (m) {
        const name = `$$$${m[1]}`;
        const existingIdx = varOrder.indexOf(name);
        if (existingIdx !== -1) {
          regexStr += `\\${existingIdx + 1}`;
        } else {
          varOrder.push(name);
          regexStr += `([\\s\\S]*?)`;
        }
        i += 3 + m[1].length;
        continue;
      }
    }
    // Single metavariable: $NAME
    if (pattern[i] === "$") {
      const m = pattern.slice(i + 1).match(/^([A-Z_][A-Z0-9_]*)/);
      if (m) {
        const name = `$${m[1]}`;
        const existingIdx = varOrder.indexOf(name);
        if (existingIdx !== -1) {
          regexStr += `\\${existingIdx + 1}`;
        } else {
          varOrder.push(name);
          // Match a single expression/argument safely without crossing newlines greedily
          regexStr += `([^\\n,;)]+?)`;
        }
        i += 1 + m[1].length;
        continue;
      }
    }
    // Flexible whitespace matching
    if (/\s/.test(pattern[i])) {
      while (i < pattern.length && /\s/.test(pattern[i])) i++;
      regexStr += `\\s+`;
      continue;
    }
    // Escape regex metacharacters
    const ch = pattern[i];
    regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }

  return {
    regex: new RegExp(regexStr, "g"),
    varOrder,
  };
}

function hasBalancedDelimiters(text) {
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return quote === null && stack.length === 0;
}

function lineColAt(content, index) {
  const slice = content.slice(0, index);
  const lines = slice.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function applyRewriteTemplate(template, captures) {
  let out = template;
  // Replace $$$VARS before $VARS so prefixes don't collide
  const keys = Object.keys(captures).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    out = out.split(k).join(captures[k]);
  }
  return out;
}

function structuralSearchFile(filePath, pattern, rewrite) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { matches: [], rewritten: null };
  }
  if (content.includes("\u0000")) return { matches: [], rewritten: null };

  const { regex, varOrder } = compileStructuralPattern(pattern);
  const matches = [];
  let rewritten = "";
  let lastIndex = 0;

  for (const m of content.matchAll(regex)) {
    const fullMatch = m[0];
    const start = m.index;
    const end = start + fullMatch.length;

    // Validate balanced captures so $X doesn't slice through nested calls
    const captures = {};
    let balanced = true;
    for (let k = 0; k < varOrder.length; k++) {
      const val = m[k + 1] ?? "";
      if (!hasBalancedDelimiters(val)) {
        balanced = false;
        break;
      }
      captures[varOrder[k]] = val;
    }
    if (!balanced) continue;

    const { line, col } = lineColAt(content, start);
    const replacement = rewrite !== undefined ? applyRewriteTemplate(rewrite, captures) : undefined;
    matches.push({
      file: filePath,
      line,
      col,
      start,
      end,
      text: fullMatch,
      replacement,
      captures,
    });

    if (rewrite !== undefined) {
      rewritten += content.slice(lastIndex, start) + replacement;
      lastIndex = end;
    }
  }

  if (rewrite !== undefined && matches.length > 0) {
    rewritten += content.slice(lastIndex);
    return { matches, original: content, rewritten };
  }
  return { matches, original: content, rewritten: null };
}

export function astGrep({ pattern, targetPath, lang, limit = 80, cwd }) {
  const base = path.resolve(cwd || process.cwd(), targetPath || ".");
  const sgBin = findAstGrepBin();

  if (sgBin) {
    try {
      const args = ["run", "--pattern", pattern, "--json=compact"];
      if (lang) args.push("--lang", lang);
      args.push(base);
      const raw = execFileSync(sgBin, args, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15000,
      });
      const parsed = JSON.parse(raw || "[]");
      const matches = parsed.slice(0, limit).map((item) => ({
        file: path.resolve(base, item.file || ""),
        line: (item.range?.start?.line ?? 0) + 1,
        col: (item.range?.start?.column ?? 0) + 1,
        text: item.text || "",
      }));
      return {
        engine: sgBin,
        pattern,
        targetPath: base,
        totalMatches: parsed.length,
        matches,
      };
    } catch {
      // Fall back to built-in structural engine
    }
  }

  const files = walkFiles(base, lang);
  const allMatches = [];
  for (const file of files) {
    const { matches } = structuralSearchFile(file, pattern);
    for (const m of matches) {
      allMatches.push({
        file: m.file,
        line: m.line,
        col: m.col,
        text: m.text,
      });
      if (allMatches.length >= limit) break;
    }
    if (allMatches.length >= limit) break;
  }

  return {
    engine: "omp-structural-builtin",
    pattern,
    targetPath: base,
    filesSearched: files.length,
    totalMatches: allMatches.length,
    matches: allMatches,
  };
}

/**
 * OMP-style staged AST codemod: previews replacements without touching disk.
 * Apply atomically via astResolve(id, reason) or discard via astReject(id).
 */
export function astEditStage({ pattern, rewrite, targetPath, lang, cwd, dataDir }) {
  const base = path.resolve(cwd || process.cwd(), targetPath || ".");
  const files = walkFiles(base, lang);
  const stagedFiles = [];
  let totalReplacements = 0;

  for (const file of files) {
    const res = structuralSearchFile(file, pattern, rewrite);
    if (res.rewritten !== null && res.rewritten !== res.original) {
      const sha256 = crypto.createHash("sha256").update(res.original).digest("hex");
      const diff = buildUnifiedDiff(file, res.original.split(/\r?\n/), res.rewritten.split(/\r?\n/));
      stagedFiles.push({
        path: file,
        relPath: path.relative(cwd || process.cwd(), file) || path.basename(file),
        replacements: res.matches.length,
        originalSha256: sha256,
        newContent: res.rewritten,
        diff,
      });
      totalReplacements += res.matches.length;
    }
  }

  const proposalId = `ast-${crypto.randomBytes(4).toString("hex")}`;
  const proposal = {
    id: proposalId,
    status: "proposed",
    pattern,
    rewrite,
    targetPath: base,
    lang: lang || "auto",
    filesSearched: files.length,
    filesMatched: stagedFiles.length,
    totalReplacements,
    createdAt: new Date().toISOString(),
    files: stagedFiles,
  };

  if (stagedFiles.length > 0) {
    updateState(dataDir, (s) => {
      s.stagedCodemods[proposalId] = proposal;
    });
  }

  return {
    id: proposalId,
    status: stagedFiles.length > 0 ? "proposed" : "no_matches",
    pattern,
    rewrite,
    filesSearched: files.length,
    filesMatched: stagedFiles.length,
    totalReplacements,
    previews: stagedFiles.map((f) => ({
      file: f.relPath,
      replacements: f.replacements,
      diff: f.diff,
    })),
  };
}

export function astResolve({ proposalId, reason = "Accepted staged AST codemod", dataDir }) {
  const state = readState(dataDir);
  const proposal = state.stagedCodemods?.[proposalId];
  if (!proposal) {
    throw new Error(`No staged AST proposal found with id "${proposalId}".`);
  }
  if (proposal.status !== "proposed") {
    throw new Error(`Proposal "${proposalId}" is already "${proposal.status}".`);
  }

  // Verify every file's SHA-256 before writing a single byte (all-or-nothing atomic guard)
  for (const f of proposal.files) {
    const current = fs.readFileSync(f.path, "utf8");
    const currentSha = crypto.createHash("sha256").update(current).digest("hex");
    if (currentSha !== f.originalSha256) {
      throw new Error(
        `Stale staged codemod: "${f.relPath}" changed on disk since staging. Re-run ast_edit.`
      );
    }
  }

  for (const f of proposal.files) {
    const tmp = `${f.path}.omp-ast.${process.pid}.tmp`;
    fs.writeFileSync(tmp, f.newContent, "utf8");
    fs.renameSync(tmp, f.path);
  }

  updateState(dataDir, (s) => {
    if (s.stagedCodemods[proposalId]) {
      s.stagedCodemods[proposalId].status = "accepted";
      s.stagedCodemods[proposalId].reason = reason;
      s.stagedCodemods[proposalId].resolvedAt = new Date().toISOString();
      // Drop bulky full contents once applied
      s.stagedCodemods[proposalId].files = s.stagedCodemods[proposalId].files.map((f) => ({
        path: f.path,
        relPath: f.relPath,
        replacements: f.replacements,
        diff: f.diff,
      }));
    }
  });

  return {
    id: proposalId,
    status: "accepted",
    reason,
    filesApplied: proposal.files.map((f) => f.relPath),
    totalReplacements: proposal.totalReplacements,
  };
}

export function astReject({ proposalId, reason = "Rejected by user/agent", dataDir }) {
  const state = readState(dataDir);
  const proposal = state.stagedCodemods?.[proposalId];
  if (!proposal) {
    throw new Error(`No staged AST proposal found with id "${proposalId}".`);
  }

  updateState(dataDir, (s) => {
    if (s.stagedCodemods[proposalId]) {
      s.stagedCodemods[proposalId].status = "rejected";
      s.stagedCodemods[proposalId].reason = reason;
      s.stagedCodemods[proposalId].resolvedAt = new Date().toISOString();
      s.stagedCodemods[proposalId].files = s.stagedCodemods[proposalId].files.map((f) => ({
        path: f.path,
        relPath: f.relPath,
        replacements: f.replacements,
      }));
    }
  });

  return {
    id: proposalId,
    status: "rejected",
    reason,
  };
}
