import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

let DatabaseSync = null;
try {
  const sqlite = await import("node:sqlite");
  DatabaseSync = sqlite.DatabaseSync;
} catch {
  DatabaseSync = null;
}

const CONFLICT_RE = /^<{7}\s*([^\n]*)\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\n]*\n([\s\S]*?))?^={7}\n([\s\S]*?)^>{7}\s*([^\n]*)$/gm;

export function scanConflicts(cwd) {
  const root = path.resolve(cwd || process.cwd());
  let files = [];
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    }).trim();
    if (out) {
      files = out.split("\n").map((f) => path.resolve(root, f));
    }
  } catch {
    // Fallback: scan workspace files for conflict markers if not in git merge state
  }

  if (files.length === 0) {
    try {
      const rgOut = execFileSync("rg", ["-l", "^<<<<<<< "], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
      }).trim();
      if (rgOut) files = rgOut.split("\n").map((f) => path.resolve(root, f));
    } catch {
      // No conflicts found
    }
  }

  const conflicts = [];
  let seq = 1;
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    CONFLICT_RE.lastIndex = 0;
    let m;
    while ((m = CONFLICT_RE.exec(raw)) !== null) {
      const line = raw.slice(0, m.index).split("\n").length;
      conflicts.push({
        id: seq,
        uri: `conflict://${seq}`,
        file,
        relFile: path.relative(root, file) || path.basename(file),
        line,
        oursLabel: m[1].trim(),
        ours: m[2],
        base: m[3] ?? null,
        theirs: m[4],
        theirsLabel: m[5].trim(),
        startOffset: m.index,
        endOffset: m.index + m[0].length,
      });
      seq++;
    }
  }
  return conflicts;
}

export function resolveConflict({ target, resolution, cwd }) {
  const conflicts = scanConflicts(cwd);
  if (conflicts.length === 0) {
    return { resolved: 0, message: "No merge conflicts found in workspace." };
  }

  const cleanTarget = String(target || "").replace(/^conflict:\/\//, "").trim();
  const selected =
    cleanTarget === "*" || cleanTarget === "all"
      ? conflicts
      : conflicts.filter((c) => String(c.id) === cleanTarget);

  if (selected.length === 0) {
    throw new Error(`Conflict "${target}" not found. Available: ${conflicts.map((c) => c.uri).join(", ")}`);
  }

  // Group by file and apply replacements bottom-to-top so offsets remain valid
  const byFile = new Map();
  for (const c of selected) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }

  const applied = [];
  for (const [file, items] of byFile) {
    let raw = fs.readFileSync(file, "utf8");
    items.sort((a, b) => b.startOffset - a.startOffset);
    for (const c of items) {
      let replacement;
      if (resolution === "@ours") replacement = c.ours.replace(/\n$/, "");
      else if (resolution === "@theirs") replacement = c.theirs.replace(/\n$/, "");
      else if (resolution === "@base") {
        if (c.base === null) throw new Error(`Conflict ${c.uri} has no diff3 @base section.`);
        replacement = c.base.replace(/\n$/, "");
      } else if (resolution === "@both") {
        replacement = `${c.ours}${c.theirs}`.replace(/\n$/, "");
      } else {
        replacement = String(resolution);
      }
      raw = raw.slice(0, c.startOffset) + replacement + raw.slice(c.endOffset);
      applied.push({ uri: c.uri, file: c.relFile, line: c.line, resolution: resolution.slice(0, 40) });
    }
    fs.writeFileSync(file, raw, "utf8");
  }

  return {
    resolved: applied.length,
    remainingConflicts: scanConflicts(cwd).length,
    applied,
  };
}

function htmlToMarkdown(html, sourceUrl) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "");

  const titleM = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? titleM[1].replace(/\s+/g, " ").trim() : sourceUrl;

  text = text
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return `# ${title}\nSource: ${sourceUrl}\n\n${text.slice(0, 16000)}`;
}

export async function vread({ uri, cwd, limit = 50 }) {
  const root = path.resolve(cwd || process.cwd());
  const rawUri = String(uri || "").trim();

  // 1. pr://<num> or pr://<num>/diff
  if (rawUri.startsWith("pr://")) {
    const rest = rawUri.slice(5);
    const [num, sub] = rest.split("/");
    if (sub === "diff") {
      const diff = execFileSync("gh", ["pr", "diff", num], { cwd: root, encoding: "utf8", timeout: 15000 });
      return { scheme: "pr://", uri: rawUri, content: diff.slice(0, 24000) };
    }
    const json = execFileSync(
      "gh",
      ["pr", "view", num, "--json", "number,title,state,author,headRefName,baseRefName,body,files,comments,url"],
      { cwd: root, encoding: "utf8", timeout: 15000 }
    );
    return { scheme: "pr://", uri: rawUri, data: JSON.parse(json) };
  }

  // 2. issue://<num>
  if (rawUri.startsWith("issue://")) {
    const num = rawUri.slice(8).split("/")[0];
    const json = execFileSync(
      "gh",
      ["issue", "view", num, "--json", "number,title,state,author,labels,body,comments,url"],
      { cwd: root, encoding: "utf8", timeout: 15000 }
    );
    return { scheme: "issue://", uri: rawUri, data: JSON.parse(json) };
  }

  // 3. conflict:// or conflict://<N>
  if (rawUri.startsWith("conflict://")) {
    const target = rawUri.slice(11).trim();
    const list = scanConflicts(root);
    if (!target || target === "*") {
      return {
        scheme: "conflict://",
        total: list.length,
        conflicts: list.map(({ startOffset, endOffset, ...rest }) => rest),
      };
    }
    const hit = list.find((c) => String(c.id) === target);
    if (!hit) throw new Error(`Conflict ${rawUri} not found.`);
    const { startOffset, endOffset, ...clean } = hit;
    return { scheme: "conflict://", conflict: clean };
  }

  // 4. sqlite://<db_path>[/<table>]
  if (rawUri.startsWith("sqlite://")) {
    if (!DatabaseSync) throw new Error("node:sqlite is unavailable in this Node.js version.");
    const rest = rawUri.slice(9);
    const dbMatch = rest.match(/^(.+?\.(?:db|sqlite|sqlite3))(?:\/(.+))?$/i);
    if (!dbMatch) throw new Error(`Invalid sqlite URI "${rawUri}". Use sqlite://path/to/file.db[/table_name]`);
    const dbFile = path.resolve(root, dbMatch[1]);
    const table = dbMatch[2];
    const db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    try {
      if (!table) {
        const tables = db.prepare(`SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`).all();
        return { scheme: "sqlite://", database: dbFile, tables };
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Error(`Invalid SQLite table identifier: ${table}`);
      }
      const rows = db.prepare(`SELECT * FROM "${table}" LIMIT ?`).all(Number(limit));
      return { scheme: "sqlite://", database: dbFile, table, count: rows.length, rows };
    } finally {
      db.close();
    }
  }

  // 5. archive://<archive_path>[/<inner_path>]
  if (rawUri.startsWith("archive://")) {
    const rest = rawUri.slice(10);
    const arcMatch = rest.match(/^(.+?\.(?:zip|tar\.gz|tgz|tar\.xz|tar))(?:\/(.+))?$/i);
    if (!arcMatch) throw new Error(`Invalid archive URI "${rawUri}". Expected .zip or .tar[.gz] path.`);
    const arcPath = path.resolve(root, arcMatch[1]);
    const inner = arcMatch[2];
    if (arcPath.endsWith(".zip")) {
      if (!inner) {
        const list = execFileSync("unzip", ["-Z1", arcPath], { encoding: "utf8", timeout: 10000 }).trim().split("\n");
        return { scheme: "archive://", archive: arcPath, entries: list.slice(0, 200) };
      }
      const content = execFileSync("unzip", ["-p", arcPath, inner], { encoding: "utf8", timeout: 10000 });
      return { scheme: "archive://", archive: arcPath, innerPath: inner, content: content.slice(0, 24000) };
    } else {
      if (!inner) {
        const list = execFileSync("tar", ["-tf", arcPath], { encoding: "utf8", timeout: 10000 }).trim().split("\n");
        return { scheme: "archive://", archive: arcPath, entries: list.slice(0, 200) };
      }
      const content = execFileSync("tar", ["-xOf", arcPath, inner], { encoding: "utf8", timeout: 10000 });
      return { scheme: "archive://", archive: arcPath, innerPath: inner, content: content.slice(0, 24000) };
    }
  }

  // 6. http:// or https:// → clean Markdown
  if (/^https?:\/\//i.test(rawUri)) {
    const res = await fetch(rawUri, {
      headers: { "User-Agent": "omp-suite-vread/1.0" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rawUri}`);
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    const content = ct.includes("html") ? htmlToMarkdown(text, rawUri) : text.slice(0, 20000);
    return { scheme: "https://", uri: rawUri, contentType: ct, content };
  }

  // 7. Plain local file fallback
  const abs = path.resolve(root, rawUri.replace(/^local:\/\//, ""));
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return { scheme: "file://", path: abs, entries: fs.readdirSync(abs).slice(0, 200) };
  }
  return { scheme: "file://", path: abs, content: fs.readFileSync(abs, "utf8").slice(0, 24000) };
}

export function vwrite({ uri, content, cwd }) {
  const rawUri = String(uri || "").trim();
  if (rawUri.startsWith("conflict://")) {
    return resolveConflict({ target: rawUri, resolution: content, cwd });
  }
  const abs = path.resolve(cwd || process.cwd(), rawUri.replace(/^local:\/\//, ""));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content), "utf8");
  return { scheme: "file://", path: abs, bytes: Buffer.byteLength(String(content), "utf8") };
}
