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
import { spawn } from "node:child_process";

const QUOTA_BUCKET_LABELS = {
  "gemini-5h": { group: "Gemini", window: "5-hour", short: "5h", order: 1 },
  "gemini-weekly": { group: "Gemini", window: "Weekly", short: "wk", order: 2 },
  "3p-5h": { group: "Claude / GPT", window: "5-hour", short: "3p 5h", order: 3 },
  "3p-weekly": { group: "Claude / GPT", window: "Weekly", short: "3p wk", order: 4 },
};

export function describeQuotaBucket(bucketId) {
  if (QUOTA_BUCKET_LABELS[bucketId]) return QUOTA_BUCKET_LABELS[bucketId];
  const parts = String(bucketId || "").split("-");
  const rawGroup = parts[0] || bucketId;
  const rawWin = parts.slice(1).join("-") || "quota";
  const group = rawGroup === "3p" ? "Claude / GPT" : rawGroup.charAt(0).toUpperCase() + rawGroup.slice(1);
  const window = rawWin === "5h" ? "5-hour" : rawWin.charAt(0).toUpperCase() + rawWin.slice(1);
  return { group, window, short: rawWin, order: 50 };
}

export function formatResetCountdown(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return "<1m";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export function normalizeQuotaBuckets(quotaObj, nowMs = Date.now()) {
  if (!quotaObj || typeof quotaObj !== "object") return [];
  const rows = [];
  for (const [id, info] of Object.entries(quotaObj)) {
    if (!info || typeof info !== "object") continue;
    const meta = describeQuotaBucket(id);
    const hasFrac = typeof info.remaining_fraction === "number" && Number.isFinite(info.remaining_fraction);
    const remainingFraction = hasFrac ? Math.max(0, Math.min(1, info.remaining_fraction)) : null;
    const remainingPct = remainingFraction !== null ? remainingFraction * 100 : null;
    let resetSeconds = typeof info.reset_in_seconds === "number" ? info.reset_in_seconds : null;
    if (info.reset_time) {
      const ts = Date.parse(info.reset_time);
      if (Number.isFinite(ts)) {
        resetSeconds = Math.max(0, Math.round((ts - nowMs) / 1000));
      }
    }
    rows.push({
      id,
      group: meta.group,
      window: meta.window,
      short: meta.short,
      order: meta.order,
      remainingFraction,
      remainingPct,
      remainingAmount: typeof info.remaining_amount === "number" ? info.remaining_amount : null,
      resetTime: info.reset_time || null,
      resetSeconds,
      disabled: Boolean(info.disabled),
    });
  }
  rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return rows;
}

export function getQuotaCachePath(dataDir) {
  return path.join(dataDir, "quota-cache.json");
}

export function readCachedQuota(dataDir) {
  if (!dataDir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(getQuotaCachePath(dataDir), "utf8"));
    if (parsed && parsed.quota && typeof parsed.quota === "object") return parsed;
  } catch {
    // ignore missing or corrupt cache
  }
  return null;
}

export function writeCachedQuota(dataDir, payload) {
  if (!dataDir || !payload?.quota) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const target = getQuotaCachePath(dataDir);
    const tmp = `${target}.${process.pid}.tmp`;
    const record = {
      quota: payload.quota,
      planTier: payload.plan_tier || payload.planTier || null,
      email: payload.email || null,
      version: payload.version || null,
      capturedAt: payload.capturedAt || Date.now(),
    };
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, target);
  } catch {
    // non-fatal
  }
}

/**
 * Fetches live remaining model quota using ONLY Antigravity's official CLI
 * (`agy --settings '{"statusLine":...}'`) inside a short-lived PTY.
 * Zero OAuth inspection, zero undocumented APIs — invokes the exact same
 * official `statusLine` contract documented at antigravity.google/docs/cli/statusline.
 */
export async function fetchLiveQuota({ dataDir, maxAgeMs = 0, timeoutMs = 8000 } = {}) {
  const cached = readCachedQuota(dataDir);
  if (cached && maxAgeMs > 0 && Date.now() - (cached.capturedAt || 0) <= maxAgeMs) {
    return { ...cached, fromCache: true };
  }

  const pyScript = `
import json, os, pty, select, shutil, subprocess, sys, tempfile, time
timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
tmp = tempfile.mkdtemp(prefix="omp-agy-quota-")
out_file = os.path.join(tmp, "status.json")
cap_script = os.path.join(tmp, "cap.sh")
try:
    with open(cap_script, "w") as f:
        f.write('#!/usr/bin/env sh\\ncat > "' + out_file + '.tmp" && mv "' + out_file + '.tmp" "' + out_file + '"\\n')
    os.chmod(cap_script, 0o755)
    settings = json.dumps({"statusLine": {"type": "command", "command": cap_script, "enabled": True}})
    master, slave = pty.openpty()
    env = dict(os.environ, OMP_RAW_AGY="1", OMP_PLAIN_AGY="1", OMP_NO_AUTO_STATUSLINE="1")
    proc = subprocess.Popen(["agy", "--settings", settings], stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)
    found = None
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.12)
            if r:
                try:
                    os.read(master, 8192)
                except OSError:
                    break
            if os.path.exists(out_file):
                try:
                    data = json.load(open(out_file))
                    if isinstance(data, dict) and data.get("quota"):
                        found = data
                        break
                except Exception:
                    pass
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=1.5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            os.close(master)
        except Exception:
            pass
    if found:
        sys.stdout.write(json.dumps({
            "quota": found.get("quota"),
            "planTier": found.get("plan_tier"),
            "email": found.get("email"),
            "version": found.get("version"),
        }))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
`;

  const live = await new Promise((resolve) => {
    const child = spawn("python3", ["-c", pyScript, String(Math.max(2, timeoutMs / 1000))], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(null);
    }, timeoutMs + 2500);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(killTimer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(killTimer);
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : null;
        if (parsed?.quota) {
          resolve({ ...parsed, capturedAt: Date.now(), fromCache: false });
          return;
        }
      } catch {
        // ignore
      }
      resolve(null);
    });
  });

  if (live) {
    writeCachedQuota(dataDir, live);
    return live;
  }
  return cached ? { ...cached, fromCache: true, stale: true } : null;
}

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
