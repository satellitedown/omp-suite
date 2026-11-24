/**
 * Local, 100% sanctioned Antigravity usage & session helpers.
 *
 * Reads Antigravity's own local JSONL conversation transcripts under
 * `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`
 * to compute exact input, output, and cache-read token totals without making any
 * undocumented network requests.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveBrainDir(explicitDir) {
  return (
    explicitDir ||
    process.env.AGY_BRAIN_DIR ||
    path.join(os.homedir(), ".gemini", "antigravity-cli", "brain")
  );
}

export function formatTokenCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2).replace(/\.?0+$/, "")}K`;
  return String(Math.round(v));
}

export function formatRelativeTime(isoOrMs, nowMs = Date.now()) {
  const ts = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs || "");
  if (!Number.isFinite(ts)) return "";
  const diffSec = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function cycleEffortLevel(current, options = ["low", "medium", "high", "xhigh"]) {
  const list = Array.isArray(options) && options.length > 0 ? options : ["low", "medium", "high", "xhigh"];
  const cur = String(current || "").toLowerCase();
  const idx = list.findIndex((x) => String(x).toLowerCase() === cur);
  return list[(idx + 1) % list.length];
}

export function cycleModeId(current, modes = ["default", "accept-edits", "auto", "plan"]) {
  const list = Array.isArray(modes) && modes.length > 0 ? modes : ["default", "accept-edits", "auto", "plan"];
  const cur = String(current || "default").toLowerCase();
  const idx = list.findIndex((x) => String(x).toLowerCase() === cur);
  return list[(idx + 1) % list.length];
}

function emptyUsage(sessionId = "") {
  return {
    found: false,
    sessionId,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cacheHitPct: 0,
    byModel: {},
    lastModel: "",
  };
}

function parseTranscriptFile(filePath, { dayKey = null } = {}) {
  const agg = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    byModel: {},
    lastModel: "",
  };
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line || !line.includes("input_tokens")) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (dayKey && rec.created_at) {
      const d = new Date(rec.created_at);
      if (!Number.isNaN(d.getTime())) {
        const recDay = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (recDay !== dayKey) continue;
      }
    }
    const inp = Number(rec.input_tokens) || 0;
    const out = Number(rec.output_tokens) || 0;
    const cache = Number(rec.cache_read_tokens) || 0;
    if (inp === 0 && out === 0 && cache === 0) continue;

    agg.turns += 1;
    agg.inputTokens += inp;
    agg.outputTokens += out;
    agg.cacheReadTokens += cache;
    const m = String(rec.model || "unknown");
    agg.lastModel = m;
    if (!agg.byModel[m]) {
      agg.byModel[m] = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    }
    agg.byModel[m].turns += 1;
    agg.byModel[m].inputTokens += inp;
    agg.byModel[m].outputTokens += out;
    agg.byModel[m].cacheReadTokens += cache;
  }
  return agg;
}

export function readSessionTranscriptUsage(sessionId, { brainDir } = {}) {
  if (!sessionId) return emptyUsage("");
  const root = resolveBrainDir(brainDir);
  const filePath = path.join(root, sessionId, ".system_generated", "logs", "transcript.jsonl");
  const agg = parseTranscriptFile(filePath);
  if (!agg) return emptyUsage(sessionId);
  const promptTotal = agg.inputTokens + agg.cacheReadTokens;
  return {
    found: true,
    sessionId,
    turns: agg.turns,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    totalTokens: agg.inputTokens + agg.outputTokens + agg.cacheReadTokens,
    cacheHitPct: promptTotal > 0 ? (agg.cacheReadTokens / promptTotal) * 100 : 0,
    byModel: agg.byModel,
    lastModel: agg.lastModel,
  };
}

export function readTodayUsageSummary({ brainDir, now = new Date(), maxFiles = 40 } = {}) {
  const root = resolveBrainDir(brainDir);
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const cutoffMs = now.getTime() - 36 * 3600 * 1000;
  const out = {
    sessionsCount: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cacheHitPct: 0,
    byModel: {},
  };

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  const candidates = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const fp = path.join(root, ent.name, ".system_generated", "logs", "transcript.jsonl");
    try {
      const st = fs.statSync(fp);
      if (st.mtimeMs >= cutoffMs) candidates.push({ fp, mtimeMs: st.mtimeMs });
    } catch {
      // ignore missing transcript
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of candidates.slice(0, maxFiles)) {
    const agg = parseTranscriptFile(item.fp, { dayKey });
    if (!agg || agg.turns === 0) continue;
    out.sessionsCount += 1;
    out.turns += agg.turns;
    out.inputTokens += agg.inputTokens;
    out.outputTokens += agg.outputTokens;
    out.cacheReadTokens += agg.cacheReadTokens;
    for (const [m, stats] of Object.entries(agg.byModel)) {
      if (!out.byModel[m]) {
        out.byModel[m] = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      }
      out.byModel[m].turns += stats.turns;
      out.byModel[m].inputTokens += stats.inputTokens;
      out.byModel[m].outputTokens += stats.outputTokens;
      out.byModel[m].cacheReadTokens += stats.cacheReadTokens;
    }
  }

  const promptTotal = out.inputTokens + out.cacheReadTokens;
  out.totalTokens = out.inputTokens + out.outputTokens + out.cacheReadTokens;
  out.cacheHitPct = promptTotal > 0 ? (out.cacheReadTokens / promptTotal) * 100 : 0;
  return out;
}
