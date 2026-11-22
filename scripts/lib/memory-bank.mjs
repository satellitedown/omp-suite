import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveDataDir, workspaceKey } from "./state.mjs";

let DatabaseSync = null;
try {
  const sqlite = await import("node:sqlite");
  DatabaseSync = sqlite.DatabaseSync;
} catch {
  DatabaseSync = null;
}

function getJsonStorePath(dataDir) {
  return path.join(resolveDataDir(dataDir), "memory-bank.json");
}

function getSqliteDb(dataDir) {
  if (!DatabaseSync) return null;
  const dbPath = path.join(resolveDataDir(dataDir), "memory.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.9,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_ws ON memories(workspace, active);
  `);
  return db;
}

function readJsonMemories(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(getJsonStorePath(dataDir), "utf8"));
  } catch {
    return [];
  }
}

function writeJsonMemories(dataDir, rows) {
  fs.writeFileSync(getJsonStorePath(dataDir), JSON.stringify(rows, null, 2), "utf8");
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function scoreMatch(row, queryTokens) {
  if (queryTokens.length === 0) return row.confidence || 0.5;
  const haystack = `${row.category} ${row.content} ${(row.tags || []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (haystack.includes(tok)) score += 1;
  }
  return score === 0 ? 0 : score / queryTokens.length + (row.confidence || 0.5) * 0.25;
}

export function memoryRetain({ content, category = "fact", tags = [], confidence = 0.9, cwd, dataDir }) {
  if (!content || !String(content).trim()) {
    throw new Error("memory_retain requires non-empty `content`.");
  }
  const ws = workspaceKey(cwd);
  const now = new Date().toISOString();
  const id = `mem-${crypto.randomBytes(4).toString("hex")}`;
  const cleanTags = Array.isArray(tags) ? tags.map(String) : String(tags).split(",").map((s) => s.trim()).filter(Boolean);

  const db = getSqliteDb(dataDir);
  if (db) {
    try {
      db.prepare(
        `INSERT INTO memories (id, workspace, category, content, tags, confidence, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(id, ws, category, String(content).trim(), JSON.stringify(cleanTags), Number(confidence), now, now);
    } finally {
      db.close();
    }
  } else {
    const rows = readJsonMemories(dataDir);
    rows.push({
      id,
      workspace: ws,
      category,
      content: String(content).trim(),
      tags: cleanTags,
      confidence: Number(confidence),
      active: 1,
      created_at: now,
      updated_at: now,
    });
    writeJsonMemories(dataDir, rows);
  }

  return { id, workspace: ws, category, content: String(content).trim(), tags: cleanTags, confidence, engine: db ? "sqlite" : "json" };
}

export function memoryRecall({ query = "", category = "", limit = 10, includeGlobal = false, cwd, dataDir }) {
  const ws = workspaceKey(cwd);
  const db = getSqliteDb(dataDir);
  let rows = [];

  if (db) {
    try {
      const sql = includeGlobal
        ? `SELECT * FROM memories WHERE active = 1 ORDER BY updated_at DESC`
        : `SELECT * FROM memories WHERE workspace = ? AND active = 1 ORDER BY updated_at DESC`;
      const rawRows = includeGlobal ? db.prepare(sql).all() : db.prepare(sql).all(ws);
      rows = rawRows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]") }));
    } finally {
      db.close();
    }
  } else {
    rows = readJsonMemories(dataDir).filter((r) => r.active !== 0 && (includeGlobal || r.workspace === ws));
  }

  if (category) {
    rows = rows.filter((r) => r.category.toLowerCase() === category.toLowerCase());
  }

  const qTokens = tokenize(query);
  const scored = rows
    .map((r) => ({ ...r, score: scoreMatch(r, qTokens) }))
    .filter((r) => (qTokens.length > 0 ? r.score > 0 : true))
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit);

  return {
    workspace: ws,
    query,
    totalFound: scored.length,
    memories: scored,
  };
}

export function memoryReflect({ cwd, dataDir }) {
  const { memories, workspace } = memoryRecall({ query: "", limit: 50, cwd, dataDir });
  const grouped = {};
  for (const m of memories) {
    const cat = m.category || "fact";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }

  const sections = Object.entries(grouped).map(([cat, list]) => {
    const items = list.map((m) => `- [${m.id}] ${m.content}${m.tags.length ? ` (${m.tags.join(", ")})` : ""}`).join("\n");
    return `### ${cat.toUpperCase()} (${list.length})\n${items}`;
  });

  return {
    workspace,
    totalMemories: memories.length,
    categories: Object.keys(grouped),
    mentalModel:
      sections.length > 0
        ? sections.join("\n\n")
        : "No project memories retained yet. Use `memory_retain` or `memory_learn` to record durable codebase facts.",
  };
}

export function memoryLearn({ lesson, skillName = "", promoteToSkill = false, tags = ["lesson"], cwd, dataDir }) {
  const saved = memoryRetain({
    content: lesson,
    category: "lesson",
    tags,
    confidence: 0.95,
    cwd,
    dataDir,
  });

  let promotedSkillPath = null;
  if (promoteToSkill && skillName && cwd) {
    const slug = skillName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const dir = path.join(path.resolve(cwd), ".agents", "skills", slug);
    fs.mkdirSync(dir, { recursive: true });
    const skillMd = `---\nname: ${slug}\ndescription: >-\n  Learned workflow rule promoted from OMP Suite memory bank (${saved.id}).\n---\n\n# ${slug}\n\n${lesson}\n`;
    promotedSkillPath = path.join(dir, "SKILL.md");
    fs.writeFileSync(promotedSkillPath, skillMd, "utf8");
  }

  return { ...saved, promotedSkillPath };
}

export function memoryEdit({ id, action = "update", content, category, tags, dataDir }) {
  if (!id) throw new Error("memory_edit requires `id`.");
  const now = new Date().toISOString();
  const db = getSqliteDb(dataDir);

  if (db) {
    try {
      const existing = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
      if (!existing) throw new Error(`Memory "${id}" not found.`);
      if (action === "forget" || action === "delete" || action === "invalidate") {
        db.prepare(`UPDATE memories SET active = 0, updated_at = ? WHERE id = ?`).run(now, id);
        return { id, action: "forgotten" };
      }
      const nextContent = content !== undefined ? String(content).trim() : existing.content;
      const nextCat = category || existing.category;
      const nextTags = tags !== undefined ? JSON.stringify(Array.isArray(tags) ? tags : [tags]) : existing.tags;
      db.prepare(`UPDATE memories SET content = ?, category = ?, tags = ?, updated_at = ? WHERE id = ?`).run(
        nextContent,
        nextCat,
        nextTags,
        now,
        id
      );
      return { id, action: "updated", content: nextContent, category: nextCat };
    } finally {
      db.close();
    }
  }

  const rows = readJsonMemories(dataDir);
  const target = rows.find((r) => r.id === id);
  if (!target) throw new Error(`Memory "${id}" not found.`);
  if (action === "forget" || action === "delete" || action === "invalidate") {
    target.active = 0;
    target.updated_at = now;
    writeJsonMemories(dataDir, rows);
    return { id, action: "forgotten" };
  }
  if (content !== undefined) target.content = String(content).trim();
  if (category) target.category = category;
  if (tags !== undefined) target.tags = Array.isArray(tags) ? tags : [tags];
  target.updated_at = now;
  writeJsonMemories(dataDir, rows);
  return { id, action: "updated", content: target.content, category: target.category };
}
