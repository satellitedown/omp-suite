/**
 * Zero-dependency Tern Surface Protocol (TSP) v1 client, reconciler, and raw TTY
 * input demuxer (APC/OSC TSP frames + DA1 + Kitty CSI-u + xterm keys + bracketed paste).
 *
 * Wire format: `ESC _ tsp ; <verb> [; k=v]* ; <json-body> ESC \`
 */

const ESC = 0x1b;
const APC_START = "\x1b_tsp;";
const ST = "\x1b\\";
const DA1_QUERY = "\x1b[c";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const KITTY_PUSH = "\x1b[>1u";
const KITTY_POP = "\x1b[<u";
const OSC_PROGRESS_BUSY = "\x1b]9;4;3\x07";
const OSC_PROGRESS_CLEAR = "\x1b]9;4;0;\x07";
const PROGRESS_HEARTBEAT_MS = 1000;
const CREDIT_STALL_MS = 1200;

export const TSP_VERSION = 1;
export const TSP_DEFAULT_APC_LIMIT = 65_536;
export const TSP_DEFAULT_CREDITS = 2;

let globalChunkSeq = 1;

function leadsWithParameter(bytes, at) {
  let i = at;
  while (i < bytes.length) {
    const b = bytes[i];
    const ok =
      (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      b === 0x5f ||
      b === 0x2d;
    if (!ok) break;
    i++;
  }
  if (i === at || bytes[i] !== 0x3d) return false;
  i++;
  while (i < bytes.length && bytes[i] >= 0x21 && bytes[i] <= 0x7e && bytes[i] !== 0x3b) i++;
  return bytes[i] === 0x3b;
}

function chunkEnd(bytes, start, limit) {
  const target = start + limit;
  if (target >= bytes.length) return bytes.length;
  const safe = (at) => (bytes[at] & 0xc0) !== 0x80 && !leadsWithParameter(bytes, at);
  for (let at = target; at > start; at--) if (safe(at)) return at;
  for (let at = target + 1; at < bytes.length; at++) if (safe(at)) return at;
  return bytes.length;
}

export function encodeTspJson(verb, value, limit = TSP_DEFAULT_APC_LIMIT) {
  const body = JSON.stringify(value);
  const byteLen = Buffer.byteLength(body, "utf8");
  if (byteLen <= limit) {
    return `${APC_START}${verb};${body}${ST}`;
  }
  const cid = (globalChunkSeq++).toString(36);
  const bytes = Buffer.from(body, "utf8");
  let out = "";
  for (let start = 0; start < bytes.length; ) {
    const end = chunkEnd(bytes, start, Math.max(256, limit));
    const more = end < bytes.length ? ";m=1" : "";
    out += `${APC_START}${verb};c=${cid}${more};${bytes.toString("utf8", start, end)}${ST}`;
    start = end;
  }
  return out;
}

const PARAM_RE = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/;

export function parseTspInner(inner) {
  const semi = inner.indexOf(";");
  if (semi <= 0) return null;
  const verb = inner.slice(0, semi);
  const params = {};
  let pos = semi + 1;
  while (true) {
    const next = inner.indexOf(";", pos);
    if (next === -1) break;
    const seg = inner.slice(pos, next);
    if (!PARAM_RE.test(seg)) break;
    const eq = seg.indexOf("=");
    params[seg.slice(0, eq)] = seg.slice(eq + 1);
    pos = next + 1;
  }
  return { verb, params, body: inner.slice(pos) };
}

/**
 * Demuxes incoming PTY bytes into:
 * - `{ type: "tsp", verb: "r"|"e", data: object }`
 * - `{ type: "da1" }`
 * - `{ type: "paste", text: string }`
 * - `{ type: "key", key: { name, text?, ctrl, alt, shift, meta } }`
 */
export class TernInputDemuxer {
  constructor() {
    this.buf = "";
    this.chunks = new Map();
    this.inPaste = false;
    this.pasteBuf = "";
  }

  feed(chunk) {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buf += str;
    const out = [];

    while (this.buf.length > 0) {
      if (this.inPaste) {
        const endIdx = this.buf.indexOf("\x1b[201~");
        if (endIdx === -1) {
          // Keep trailing partial escape prefix
          const keep = Math.min(5, this.buf.length);
          const safeLen = this.buf.length - keep;
          if (safeLen > 0) {
            this.pasteBuf += this.buf.slice(0, safeLen);
            this.buf = this.buf.slice(safeLen);
          }
          break;
        }
        this.pasteBuf += this.buf.slice(0, endIdx);
        this.buf = this.buf.slice(endIdx + 6);
        this.inPaste = false;
        out.push({ type: "paste", text: this.pasteBuf });
        this.pasteBuf = "";
        continue;
      }

      const b0 = this.buf.charCodeAt(0);
      if (b0 !== ESC) {
        out.push(...this._decodeChar(b0));
        this.buf = this.buf.slice(1);
        continue;
      }

      // ESC at end of buffer — wait briefly unless alone
      if (this.buf.length === 1) break;

      const c1 = this.buf[1];

      // APC: ESC _ tsp; ... ESC \
      if (c1 === "_") {
        const stIdx = this.buf.indexOf(ST, 2);
        if (stIdx === -1) break; // incomplete APC
        const payload = this.buf.slice(2, stIdx);
        this.buf = this.buf.slice(stIdx + 2);
        if (payload.startsWith("tsp;")) {
          const item = this._decodeTsp(payload.slice(4));
          if (item) out.push(item);
        }
        continue;
      }

      // OSC: ESC ] 877;tsp; ... (BEL or ST)
      if (c1 === "]") {
        const stIdx = this.buf.indexOf(ST, 2);
        const belIdx = this.buf.indexOf("\x07", 2);
        let end = -1;
        let termLen = 1;
        if (stIdx !== -1 && (belIdx === -1 || stIdx < belIdx)) {
          end = stIdx;
          termLen = 2;
        } else if (belIdx !== -1) {
          end = belIdx;
          termLen = 1;
        }
        if (end === -1) break;
        const payload = this.buf.slice(2, end);
        this.buf = this.buf.slice(end + termLen);
        if (payload.startsWith("877;tsp;")) {
          const item = this._decodeTsp(payload.slice(8));
          if (item) out.push(item);
        }
        continue;
      }

      // CSI: ESC [ ...
      if (c1 === "[") {
        if (this.buf.startsWith("\x1b[200~")) {
          this.buf = this.buf.slice(6);
          this.inPaste = true;
          this.pasteBuf = "";
          continue;
        }
        // Match complete CSI sequence: ESC [ <params> <final byte 0x40..0x7e>
        const m = this.buf.match(/^\x1b\[([0-9;?:<>!=]*)([\x40-\x7e])/);
        if (!m) {
          if (this.buf.length < 32) break; // wait for complete CSI
          this.buf = this.buf.slice(2);
          continue;
        }
        const [full, params, fin] = m;
        this.buf = this.buf.slice(full.length);
        // DA1 reply: ESC [ ? ... c
        if (fin === "c" && params.startsWith("?")) {
          out.push({ type: "da1" });
          continue;
        }
        const key = this._decodeCsiKey(params, fin);
        if (key) out.push({ type: "key", key });
        continue;
      }

      // SS3: ESC O <final>
      if (c1 === "O") {
        if (this.buf.length < 3) break;
        const fin = this.buf[2];
        this.buf = this.buf.slice(3);
        const map = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
        if (map[fin]) {
          out.push({ type: "key", key: { name: map[fin], ctrl: false, alt: false, shift: false, meta: false } });
        }
        continue;
      }

      // Alt + key (ESC followed by printable char)
      const ch = this.buf[1];
      this.buf = this.buf.slice(2);
      if (ch === "\r" || ch === "\n") {
        out.push({ type: "key", key: { name: "enter", ctrl: false, alt: true, shift: false, meta: false } });
      } else if (ch === "\x7f" || ch === "\b") {
        out.push({ type: "key", key: { name: "backspace", ctrl: false, alt: true, shift: false, meta: false } });
      } else {
        out.push({
          type: "key",
          key: { name: ch.toLowerCase(), text: ch, ctrl: false, alt: true, shift: false, meta: false },
        });
      }
    }

    return out;
  }

  flushBareEscape() {
    if (this.buf === "\x1b") {
      this.buf = "";
      return [{ type: "key", key: { name: "escape", ctrl: false, alt: false, shift: false, meta: false } }];
    }
    return [];
  }

  _decodeTsp(inner) {
    const raw = parseTspInner(inner);
    if (!raw) return null;
    let body = raw.body;
    if (raw.params.c !== undefined) {
      const joined = (this.chunks.get(raw.params.c) || "") + body;
      if (raw.params.m === "1") {
        this.chunks.set(raw.params.c, joined);
        return null;
      }
      this.chunks.delete(raw.params.c);
      body = joined;
    }
    try {
      return { type: "tsp", verb: raw.verb, data: JSON.parse(body) };
    } catch {
      return null;
    }
  }

  _decodeChar(code) {
    const base = { ctrl: false, alt: false, shift: false, meta: false };
    if (code === 13) return [{ type: "key", key: { ...base, name: "enter" } }];
    if (code === 10) return [{ type: "key", key: { ...base, name: "enter", shift: true } }];
    if (code === 9) return [{ type: "key", key: { ...base, name: "tab" } }];
    if (code === 127 || code === 8) return [{ type: "key", key: { ...base, name: "backspace" } }];
    if (code >= 1 && code <= 26) {
      const letter = String.fromCharCode(code + 96);
      return [{ type: "key", key: { ...base, name: letter, ctrl: true } }];
    }
    if (code >= 32) {
      const ch = String.fromCharCode(code);
      return [{ type: "key", key: { ...base, name: ch === " " ? "space" : ch.toLowerCase(), text: ch } }];
    }
    return [];
  }

  _decodeCsiKey(params, fin) {
    const parts = params.split(";").map((s) => Number(s.split(":")[0]) || 0);
    const modBits = parts.length >= 2 && parts[1] > 0 ? parts[1] - 1 : 0;
    const mods = {
      shift: (modBits & 1) !== 0,
      alt: (modBits & 2) !== 0,
      ctrl: (modBits & 4) !== 0,
      meta: (modBits & 8) !== 0,
    };

    // Kitty CSI u protocol: ESC [ <codepoint> [; <modifiers>] u
    if (fin === "u") {
      const cp = parts[0];
      if (cp === 13) return { name: "enter", ...mods };
      if (cp === 9) return { name: "tab", ...mods };
      if (cp === 27) return { name: "escape", ...mods };
      if (cp === 127 || cp === 8) return { name: "backspace", ...mods };
      if (cp === 32) return { name: "space", text: " ", ...mods };
      if (cp >= 32 && cp <= 0x10ffff) {
        let ch = String.fromCodePoint(cp);
        if (mods.shift && ch.length === 1 && !mods.ctrl && !mods.alt && !mods.meta) {
          ch = ch.toUpperCase();
        }
        return { name: ch.toLowerCase(), text: !mods.ctrl && !mods.alt && !mods.meta ? ch : undefined, ...mods };
      }
      return null;
    }

    const letters = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab" };
    if (letters[fin]) {
      return { name: letters[fin], ...mods, shift: fin === "Z" ? true : mods.shift };
    }
    if (fin === "~") {
      const tildes = { 1: "home", 3: "delete", 4: "end", 5: "page_up", 6: "page_down", 7: "home", 8: "end" };
      if (tildes[parts[0]]) return { name: tildes[parts[0]], ...mods };
    }
    return null;
  }
}

/**
 * Minimal, rock-solid TSP v1 Surface Reconciler:
 * Diffs `{ main, dock, layer }` node trees against the last sent tree and emits
 * minimal `add`, `set`, `text append`, `del`, and `focus` ops under credit flow control.
 */
export class TspSurfaceSession {
  constructor({ input = process.stdin, output = process.stdout, app = "omp", version = "1.3.0" } = {}) {
    this.input = input;
    this.output = output;
    this.app = app;
    this.version = version;
    this.demux = new TernInputDemuxer();
    this.caps = {
      term: "",
      kinds: new Set(),
      features: new Set(),
      apc: TSP_DEFAULT_APC_LIMIT,
      credits: TSP_DEFAULT_CREDITS,
      cols: output.columns || 100,
      dark: true,
    };
    this.surfaceId = "s:1";
    this.seq = 0;
    this.acked = 0;
    this.unacked = [];
    this.opened = false;
    this.closed = false;
    this.lastTree = null;
    this.lastFocus = null;
    this.pendingRender = null;
    this.renderTimer = null;
    this.stallTimer = null;
    this.progressActive = false;
    this.progressTimer = null;
    this.escTimer = null;
    this.onEvent = () => {};
    this.onKey = () => {};
    this.onPaste = () => {};
    this._dataHandler = (chunk) => this._onRawData(chunk);
  }

  async connect(timeoutMs = 600) {
    if (!this.input.isTTY || !this.output.isTTY) return false;
    this.input.setRawMode?.(true);
    this.input.resume?.();
    this.input.on("data", this._dataHandler);

    return await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._helloResolve = null;
        if (ok) {
          this.output.write(PASTE_ON + KITTY_PUSH);
        } else {
          this.input.off("data", this._dataHandler);
          this.input.setRawMode?.(false);
        }
        resolve(ok);
      };
      this._helloResolve = done;
      const timer = setTimeout(() => done(false), timeoutMs);

      this.output.write(
        encodeTspJson("q", {
          q: "hello",
          v: [TSP_VERSION],
          app: this.app,
          features: ["edit", "undo", "send"],
          ver: this.version,
        }) + DA1_QUERY
      );
    });
  }

  open({ id = "s:1", mode = "inline", title = "agy", role = "omp.session", chat = true } = {}) {
    this.surfaceId = id;
    this.opened = true;
    this.lastTree = null;
    this.lastFocus = null;
    this.seq = 0;
    this.acked = 0;
    this.unacked = [];
    this.output.write(encodeTspJson("o", { id, mode, title, role, chat }, this.caps.apc));
  }

  setProgress(active) {
    if (this.closed) return;
    if (active) {
      if (this.progressActive) return;
      this.progressActive = true;
      this.output.write(OSC_PROGRESS_BUSY);
      if (!this.progressTimer) {
        this.progressTimer = setInterval(() => {
          if (this.progressActive && !this.closed) {
            this.output.write(OSC_PROGRESS_BUSY);
          }
        }, PROGRESS_HEARTBEAT_MS);
        this.progressTimer.unref?.();
      }
    } else {
      this.progressActive = false;
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      this.output.write(OSC_PROGRESS_CLEAR);
    }
  }

  close(keep = true) {
    if (this.closed) return;
    this.setProgress(false);
    this.closed = true;
    if (this.escTimer) clearTimeout(this.escTimer);
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.opened) {
      this.output.write(encodeTspJson("x", { id: this.surfaceId, keep }, this.caps.apc));
      this.opened = false;
    }
    this.output.write(KITTY_POP + PASTE_OFF);
    this.input.off("data", this._dataHandler);
    this.input.setRawMode?.(false);
  }

  scheduleRender(fn, delayMs = 16) {
    if (!this.opened || this.closed) return;
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (!this.opened || this.closed) return;
      fn();
    }, delayMs);
  }

  _armStallTimer() {
    if (this.stallTimer || this.closed || !this.unacked.length) return;
    const waitMs = Math.max(25, this.unacked[0] + CREDIT_STALL_MS - Date.now());
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.closed || !this.opened || !this.pendingRender) return;
      this.unacked = [];
      this.acked = this.seq;
      const { tree, focusId } = this.pendingRender;
      this.pendingRender = null;
      this.render(tree, focusId);
    }, waitMs);
    this.stallTimer.unref?.();
  }

  render(tree, focusId = null) {
    if (!this.opened || this.closed) return;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    // Credit-based flow control with guaranteed stall-recovery timer so the final
    // idle frame after a streaming burst can never sit unflushed in `pendingRender`.
    const now = Date.now();
    if (this.unacked.length >= this.caps.credits && now - this.unacked[0] < CREDIT_STALL_MS) {
      this.pendingRender = { tree, focusId };
      this._armStallTimer();
      return;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.unacked.length >= this.caps.credits) {
      this.unacked = [];
      this.acked = this.seq;
    }
    this.pendingRender = null;

    const ops = [];
    if (!this.lastTree) {
      ops.push(["add", "main", this.surfaceId, null, { id: "main", k: "col" }]);
      ops.push(["add", "dock", this.surfaceId, null, { id: "dock", k: "col" }]);
      ops.push(["add", "layer", this.surfaceId, null, { id: "layer", k: "col" }]);
      this.lastTree = { main: [], dock: [], layer: [] };
    }

    for (const region of ["main", "dock", "layer"]) {
      this._diffChildren(region, this.lastTree[region] || [], tree[region] || [], ops);
    }

    if (focusId !== this.lastFocus) {
      ops.push(["focus", focusId]);
      this.lastFocus = focusId;
    }

    this.lastTree = tree;
    if (ops.length === 0) return;

    this.seq++;
    this.unacked.push(now);
    this.output.write(encodeTspJson("f", { sf: this.surfaceId, s: this.seq, ops }, this.caps.apc));
  }

  _diffChildren(parentId, prevList, nextList, ops) {
    const prevById = new Map(prevList.map((n) => [n.id, n]));
    const nextById = new Map(nextList.map((n) => [n.id, n]));
    const liveIds = new Set(prevList.map((n) => n.id));

    // Delete removed children
    for (const oldNode of prevList) {
      if (!nextById.has(oldNode.id)) {
        ops.push(["del", oldNode.id]);
        liveIds.delete(oldNode.id);
      }
    }

    const findAnchorAfter = (idx) => {
      for (let j = idx + 1; j < nextList.length; j++) {
        if (liveIds.has(nextList[j].id)) return nextList[j].id;
      }
      return null;
    };

    // Add new or update existing children in exact target order
    for (let i = 0; i < nextList.length; i++) {
      const nextNode = nextList[i];
      const prevNode = prevById.get(nextNode.id);

      if (!prevNode) {
        const beforeId = findAnchorAfter(i);
        ops.push(["add", nextNode.id, parentId, beforeId, nextNode]);
        liveIds.add(nextNode.id);
      } else if (prevNode.k !== nextNode.k) {
        ops.push(["del", prevNode.id]);
        liveIds.delete(prevNode.id);
        const beforeId = findAnchorAfter(i);
        ops.push(["add", nextNode.id, parentId, beforeId, nextNode]);
        liveIds.add(nextNode.id);
      } else {
        this._diffNode(prevNode, nextNode, ops);
      }
    }
  }

  _diffNode(prev, next, ops) {
    const prevP = prev.p || {};
    const nextP = next.p || {};
    const changedProps = {};
    let hasPropChange = false;

    // Only use incremental `text append` for read-only streaming nodes.
    // Mutable `editor`/`input` nodes update atomically via `set` to avoid cursor desync.
    const textKind = ["text", "md", "code", "ansi"].includes(next.k);
    let usedTextAppend = false;

    if (
      textKind &&
      typeof prevP.text === "string" &&
      typeof nextP.text === "string" &&
      nextP.text.length > prevP.text.length &&
      nextP.text.startsWith(prevP.text)
    ) {
      ops.push(["text", next.id, "append", nextP.text.slice(prevP.text.length)]);
      usedTextAppend = true;
    }

    const keys = new Set([...Object.keys(prevP), ...Object.keys(nextP)]);
    for (const k of keys) {
      if (k === "text" && usedTextAppend) continue;
      const a = prevP[k];
      const b = nextP[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changedProps[k] = b === undefined ? null : b;
        hasPropChange = true;
      }
    }

    if (hasPropChange) {
      ops.push(["set", next.id, changedProps]);
    }

    if (prev.c || next.c) {
      this._diffChildren(next.id, prev.c || [], next.c || [], ops);
    }
  }

  _onRawData(chunk) {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    const items = this.demux.feed(chunk);
    for (const item of items) {
      this._dispatchItem(item);
    }
    if (this.demux.buf === "\x1b") {
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        for (const item of this.demux.flushBareEscape()) this._dispatchItem(item);
      }, 35);
    }
  }

  _dispatchItem(item) {
    if (item.type === "da1") {
      // DA1 arrived before any TSP hello reply -> terminal does not support TSP
      if (this._helloResolve) this._helloResolve(false);
      return;
    }
    if (item.type === "tsp") {
      if (item.verb === "r" && item.data?.r === "hello") {
        const h = item.data;
        this.caps.term = h.term || "tern";
        this.caps.kinds = new Set(Array.isArray(h.kinds) ? h.kinds : []);
        this.caps.features = new Set(Array.isArray(h.features) ? h.features : []);
        this.caps.apc = h.apc > 0 ? h.apc : TSP_DEFAULT_APC_LIMIT;
        this.caps.credits = h.credits > 0 ? h.credits : TSP_DEFAULT_CREDITS;
        if (h.cols) this.caps.cols = h.cols;
        this.caps.dark = h.dark !== false;
        if (this._helloResolve) this._helloResolve(true);
        return;
      }
      if (item.verb === "e" && item.data?.ev) {
        const ev = item.data;
        if (ev.ev === "ack") {
          if (ev.s > this.acked) {
            const newly = Math.min(ev.s, this.seq) - this.acked;
            this.acked = Math.min(ev.s, this.seq);
            this.unacked.splice(0, newly);
          }
          if (this.stallTimer && this.unacked.length < this.caps.credits) {
            clearTimeout(this.stallTimer);
            this.stallTimer = null;
          }
          if (this.pendingRender) {
            const { tree, focusId } = this.pendingRender;
            this.pendingRender = null;
            this.render(tree, focusId);
          }
          return;
        }
        if (ev.ev === "resize" && ev.cols) {
          this.caps.cols = ev.cols;
        }
        this.onEvent(ev);
        return;
      }
      return;
    }
    if (item.type === "paste") {
      this.onPaste(item.text);
      return;
    }
    if (item.type === "key") {
      this.onKey(item.key);
    }
  }
}
