import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Deterministic 3-hex-char content hash for a single line (ignores CR drift).
 */
export function hashLine(line) {
  const normalized = line.replace(/\r$/, "");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 3);
}

export function formatHashline(lineNumber, line) {
  return `${lineNumber}:${hashLine(line)}| ${line}`;
}

export function hashlineRead({ filePath, startLine = 1, endLine, cwd }) {
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(1, Number(startLine) || 1);
  const end = Math.min(total, Number(endLine) || Math.min(total, start + 399));

  const formatted = [];
  for (let i = start; i <= end; i++) {
    formatted.push(formatHashline(i, lines[i - 1]));
  }

  return {
    path: absPath,
    totalLines: total,
    startLine: start,
    endLine: end,
    eol: eol === "\r\n" ? "CRLF" : "LF",
    sha256: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12),
    content: formatted.join("\n"),
  };
}

function parseAnchor(anchorStr) {
  if (typeof anchorStr !== "string") {
    throw new Error(`Anchor must be a string in "line:hash" format, got: ${typeof anchorStr}`);
  }
  const match = anchorStr.trim().match(/^(\d+):([0-9a-fA-F]{3,8})$/);
  if (!match) {
    throw new Error(`Invalid anchor "${anchorStr}". Expected "<line>:<3-hex-hash>", e.g. "42:a3f".`);
  }
  return { line: Number(match[1]), hash: match[2].toLowerCase() };
}

function validateAnchor(lines, anchorStr, label) {
  const { line, hash } = parseAnchor(anchorStr);
  if (line < 1 || line > lines.length) {
    throw new Error(
      `Stale ${label} anchor "${anchorStr}": line ${line} is out of bounds (file has ${lines.length} lines).`
    );
  }
  const actualHash = hashLine(lines[line - 1]);
  if (!actualHash.startsWith(hash) && !hash.startsWith(actualHash)) {
    // Stale-anchor recovery: search nearby lines for matching hash
    const candidates = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const h = hashLine(lines[idx]);
      if (h === hash) {
        candidates.push({
          line: idx + 1,
          distance: Math.abs(idx + 1 - line),
          preview: lines[idx].trim().slice(0, 80),
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const hint =
      candidates.length > 0
        ? ` Recovery hint — matching hash "${hash}" moved to: ${candidates
            .slice(0, 3)
            .map((c) => `${c.line}:${hash} (${JSON.stringify(c.preview)})`)
            .join(", ")}.`
        : ` Current line ${line} is now ${line}:${actualHash}| ${lines[line - 1].slice(0, 80)}`;
    throw new Error(
      `Stale ${label} anchor "${anchorStr}": expected hash "${hash}" at line ${line}, found "${actualHash}".${hint}`
    );
  }
  return { line, hash: actualHash };
}

export function buildUnifiedDiff(filePath, oldLines, newLines) {
  const maxShow = 120;
  const out = [`--- a/${path.basename(filePath)}`, `+++ b/${path.basename(filePath)}`];
  let i = 0;
  let j = 0;
  let emitted = 0;

  // Compact hunk-style diff around modified regions
  const prefix = (() => {
    let k = 0;
    while (k < oldLines.length && k < newLines.length && oldLines[k] === newLines[k]) k++;
    return k;
  })();
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  if (prefix > oldEnd && prefix > newEnd) {
    return "(no changes)";
  }

  const ctxStart = Math.max(0, prefix - 2);
  const oldCtxEnd = Math.min(oldLines.length - 1, oldEnd + 2);
  const newCtxEnd = Math.min(newLines.length - 1, newEnd + 2);
  out.push(
    `@@ -${ctxStart + 1},${oldCtxEnd - ctxStart + 1} +${ctxStart + 1},${newCtxEnd - ctxStart + 1} @@`
  );

  for (i = ctxStart; i < prefix && emitted < maxShow; i++, emitted++) {
    out.push(` ${oldLines[i]}`);
  }
  for (i = prefix; i <= oldEnd && emitted < maxShow; i++, emitted++) {
    out.push(`-${oldLines[i]}`);
  }
  for (j = prefix; j <= newEnd && emitted < maxShow; j++, emitted++) {
    out.push(`+${newLines[j]}`);
  }
  for (i = oldEnd + 1; i <= oldCtxEnd && emitted < maxShow; i++, emitted++) {
    out.push(` ${oldLines[i]}`);
  }
  if (emitted >= maxShow) out.push("... (diff truncated)");
  return out.join("\n");
}

/**
 * Atomic content-hash anchored patch engine.
 * Supported ops:
 *  - { op: "replace_line", anchor: "12:a3f", content: "new line" }
 *  - { op: "replace_range", startAnchor: "12:a3f", endAnchor: "15:9c1", content: "new\nblock" }
 *  - { op: "insert_after", anchor: "12:a3f", content: "inserted\nlines" }
 *  - { op: "insert_before", anchor: "12:a3f", content: "inserted\nlines" }
 *  - { op: "delete_range", startAnchor: "12:a3f", endAnchor: "14:b01" }
 */
export function hashlineEdit({ filePath, edits, dryRun = false, cwd }) {
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("`edits` must be a non-empty array of hashline operations.");
  }

  const raw = fs.readFileSync(absPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const oldLines = raw.split(/\r?\n/);

  // Phase 1: Validate every anchor upfront before mutating anything (all-or-nothing!)
  const resolved = edits.map((edit, idx) => {
    const op = edit.op || (edit.endAnchor ? "replace_range" : "replace_line");
    const newLines =
      edit.content === undefined || edit.content === null
        ? []
        : String(edit.content).split(/\r?\n/);

    if (op === "replace_line") {
      const a = validateAnchor(oldLines, edit.anchor || edit.startAnchor, `edit[${idx}]`);
      return { op, startIdx: a.line - 1, endIdx: a.line - 1, newLines };
    }
    if (op === "replace_range") {
      const s = validateAnchor(oldLines, edit.startAnchor || edit.anchor, `edit[${idx}].start`);
      const e = validateAnchor(oldLines, edit.endAnchor || edit.startAnchor || edit.anchor, `edit[${idx}].end`);
      if (e.line < s.line) {
        throw new Error(`edit[${idx}]: endAnchor line ${e.line} < startAnchor line ${s.line}`);
      }
      return { op, startIdx: s.line - 1, endIdx: e.line - 1, newLines };
    }
    if (op === "delete_range") {
      const s = validateAnchor(oldLines, edit.startAnchor || edit.anchor, `edit[${idx}].start`);
      const e = validateAnchor(oldLines, edit.endAnchor || edit.startAnchor || edit.anchor, `edit[${idx}].end`);
      if (e.line < s.line) {
        throw new Error(`edit[${idx}]: endAnchor line ${e.line} < startAnchor line ${s.line}`);
      }
      return { op, startIdx: s.line - 1, endIdx: e.line - 1, newLines: [] };
    }
    if (op === "insert_after") {
      const a = validateAnchor(oldLines, edit.anchor || edit.startAnchor, `edit[${idx}]`);
      return { op, startIdx: a.line, endIdx: a.line - 1, newLines };
    }
    if (op === "insert_before") {
      const a = validateAnchor(oldLines, edit.anchor || edit.startAnchor, `edit[${idx}]`);
      return { op, startIdx: a.line - 1, endIdx: a.line - 2, newLines };
    }
    throw new Error(`Unsupported hashline op "${op}" in edit[${idx}].`);
  });

  // Sort bottom-to-top so indices never shift during batch application; check overlap
  const sorted = [...resolved].sort((a, b) => b.startIdx - a.startIdx);
  for (let i = 0; i < sorted.length - 1; i++) {
    const hi = sorted[i];
    const lo = sorted[i + 1];
    // Pure inserts have endIdx < startIdx; overlapping ranges conflict
    if (hi.startIdx <= lo.endIdx && lo.endIdx >= lo.startIdx) {
      throw new Error(
        `Overlapping hashline edits detected around lines ${lo.startIdx + 1}-${lo.endIdx + 1} and ${hi.startIdx + 1}-${hi.endIdx + 1}.`
      );
    }
  }

  const nextLines = [...oldLines];
  for (const edit of sorted) {
    const deleteCount = edit.endIdx >= edit.startIdx ? edit.endIdx - edit.startIdx + 1 : 0;
    nextLines.splice(edit.startIdx, deleteCount, ...edit.newLines);
  }

  const diff = buildUnifiedDiff(absPath, oldLines, nextLines);
  const newContent = nextLines.join(eol);

  if (!dryRun) {
    const tmp = `${absPath}.omp-hashline.${process.pid}.tmp`;
    fs.writeFileSync(tmp, newContent, "utf8");
    fs.renameSync(tmp, absPath);
  }

  // Return refreshed anchor window around first modified line
  const focusLine = Math.max(1, sorted[sorted.length - 1].startIdx);
  const previewStart = Math.max(1, focusLine - 2);
  const previewEnd = Math.min(nextLines.length, focusLine + 12);
  const refreshedAnchors = [];
  for (let l = previewStart; l <= previewEnd; l++) {
    refreshedAnchors.push(formatHashline(l, nextLines[l - 1]));
  }

  return {
    path: absPath,
    applied: !dryRun,
    editsCount: edits.length,
    linesBefore: oldLines.length,
    linesAfter: nextLines.length,
    diff,
    refreshedAnchors: refreshedAnchors.join("\n"),
  };
}
