import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { updateState } from "./state.mjs";

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
  "composer.lock",
]);

function classifyFile(relPath) {
  const base = path.basename(relPath);
  const lower = relPath.toLowerCase();
  if (LOCKFILES.has(base)) return { kind: "lockfile", priority: 0, type: "chore" };
  if (/(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[a-z]+$/i.test(lower)) {
    return { kind: "test", priority: 3, type: "test" };
  }
  if (lower.endsWith(".md") || lower.startsWith("docs/") || base === "LICENSE") {
    return { kind: "docs", priority: 2, type: "docs" };
  }
  if (
    base.endsWith(".json") ||
    base.endsWith(".yml") ||
    base.endsWith(".yaml") ||
    base.endsWith(".toml") ||
    base.startsWith(".")
  ) {
    return { kind: "config", priority: 4, type: "chore" };
  }
  return { kind: "source", priority: 5, type: "feat" };
}

function groupScope(relPath) {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  if (["src", "lib", "packages", "crates", "scripts", "agents", "skills", "rules"].includes(parts[0])) {
    return parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return parts[0];
}

export function gitAtomicPlan({ cwd }) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    timeout: 4000,
  }).trim();

  const statusRaw = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
    timeout: 4000,
  });

  const numstatUnstaged = execFileSync("git", ["diff", "--numstat"], { cwd: root, encoding: "utf8", timeout: 4000 });
  const numstatStaged = execFileSync("git", ["diff", "--cached", "--numstat"], { cwd: root, encoding: "utf8", timeout: 4000 });

  const statsMap = new Map();
  for (const chunk of [numstatUnstaged, numstatStaged]) {
    for (const line of chunk.split("\n").filter(Boolean)) {
      const [add, del, file] = line.split("\t");
      if (!file) continue;
      const cur = statsMap.get(file) || { additions: 0, deletions: 0 };
      cur.additions += Number(add) || 0;
      cur.deletions += Number(del) || 0;
      statsMap.set(file, cur);
    }
  }

  const changed = [];
  const excludedLockfiles = [];

  for (const line of statusRaw.split("\n").filter(Boolean)) {
    const xy = line.slice(0, 2);
    const relPath = line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop();
    const cls = classifyFile(relPath);
    const st = statsMap.get(relPath) || { additions: 0, deletions: 0 };
    const entry = {
      path: relPath,
      status: xy.trim() || "M",
      ...cls,
      scope: groupScope(relPath),
      ...st,
    };
    if (cls.kind === "lockfile") excludedLockfiles.push(entry);
    else changed.push(entry);
  }

  if (changed.length === 0) {
    return {
      root,
      totalFiles: 0,
      excludedLockfiles: excludedLockfiles.map((f) => f.path),
      commits: [],
      summary: "Working tree has no non-lockfile changes to plan.",
    };
  }

  // Group into dependency-ordered atomic buckets: config/manifests → source by scope → tests → docs
  const buckets = new Map();
  for (const f of changed) {
    const key = f.kind === "source" ? `source:${f.scope}` : f.kind;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        kind: f.kind,
        type: f.type,
        scope: f.kind === "source" ? f.scope : f.kind,
        priority: f.priority,
        files: [],
        additions: 0,
        deletions: 0,
      });
    }
    const b = buckets.get(key);
    b.files.push(f);
    b.additions += f.additions;
    b.deletions += f.deletions;
  }

  // Order dependencies: config -> source (highest priority first) -> test -> docs
  const orderRank = { config: 1, source: 2, test: 3, docs: 4 };
  const ordered = [...buckets.values()].sort(
    (a, b) => (orderRank[a.kind] ?? 9) - (orderRank[b.kind] ?? 9) || b.additions - a.additions
  );

  const commits = ordered.map((b, i) => {
    const scopeSlug = b.scope.replace(/[^a-zA-Z0-9/_-]/g, "");
    const actionVerb = b.files.every((f) => f.status === "??" || f.status === "A") ? "add" : "update";
    const sampleNames = b.files
      .slice(0, 3)
      .map((f) => path.basename(f.path))
      .join(", ");
    const suffix = b.files.length > 3 ? ` (+${b.files.length - 3} more)` : "";
    const message =
      b.kind === "source"
        ? `${b.type}(${scopeSlug}): ${actionVerb} ${sampleNames}${suffix}`
        : `${b.type}: ${actionVerb} ${sampleNames}${suffix}`;
    return {
      order: i + 1,
      kind: b.kind,
      suggestedMessage: message,
      files: b.files.map((f) => f.path),
      stats: { files: b.files.length, additions: b.additions, deletions: b.deletions },
      dependsOn: i > 0 && b.kind === "test" ? [i] : [],
    };
  });

  return {
    root,
    totalFiles: changed.length,
    excludedLockfiles: excludedLockfiles.map((f) => f.path),
    cyclesDetected: false,
    commits,
  };
}

export function postAdvisorNote({ severity = "concern", title = "Advisor note", message, file = "", line = null, injectNextTurn = true, dataDir }) {
  const valid = new Set(["aside", "concern", "blocker"]);
  const sev = valid.has(severity) ? severity : "concern";
  const note = {
    id: `adv-${crypto.randomBytes(3).toString("hex")}`,
    severity: sev,
    title,
    message,
    file,
    line,
    acknowledged: false,
    timestamp: new Date().toISOString(),
  };

  updateState(dataDir, (s) => {
    s.advisorNotes = s.advisorNotes || [];
    s.advisorNotes.unshift(note);
    if (s.advisorNotes.length > 30) s.advisorNotes.length = 30;
    if (injectNextTurn && (sev === "concern" || sev === "blocker")) {
      s.pendingAdvisorInjection = s.pendingAdvisorInjection || [];
      s.pendingAdvisorInjection.push(note);
    }
  });

  return note;
}
