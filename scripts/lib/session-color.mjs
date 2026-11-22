// Faithful port of Oh My Pi's dark theme tokens and OKLCH hash-derived per-session accent color.

export const OMP_DARK_THEME = {
  name: "omp-dark",
  pageBg: "#18181e",
  chromeBg: "#121212",
  cardBg: "#1e1e24",
  infoBg: "#26262e",
  selectedBg: "#31363f",
  userMsgBg: "#221d1a",
  toolPendingBg: "#1d2129",
  toolSuccessBg: "#161a1f",
  toolErrorBg: "#291d1d",
  customMsgBg: "#2a2530",
  foreground: "#cccccc",
  textBright: "#eceef4",
  muted: "#777d88",
  dim: "#5f6673",
  borderMuted: "#3d424a",
  border: "#178fb9",
  borderAccent: "#0088fa",
  accent: "#febc38",
  cyan: "#0088fa",
  blue: "#178fb9",
  green: "#89d281",
  red: "#fc3a4b",
  yellow: "#e4c00f",
  lavender: "#e5c1ff",
  purple: "#b281d6",
  rose: "#d787af",
  teal: "#00afaf",
  gitClean: "#5faf5f",
  gitDirty: "#d7af5f",
  contextBar: "#8787af",
};

function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (((hash << 5) + hash) ^ str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function linearToSrgb(c) {
  const x = clamp01(c);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function oklchToRgb(L, C, Hdeg) {
  const hRad = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return {
    r: Math.round(linearToSrgb(rLin) * 255),
    g: Math.round(linearToSrgb(gLin) * 255),
    b: Math.round(linearToSrgb(bLin) * 255),
    inGamut: rLin >= -0.001 && rLin <= 1.001 && gLin >= -0.001 && gLin <= 1.001 && bLin >= -0.001 && bLin <= 1.001,
  };
}

function rgbToHex({ r, g, b }) {
  return (
    "#" +
    [r, g, b]
      .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Derive a vivid, legible per-session accent color in OKLCH space from a session name,
 * matching Oh My Pi's signature per-session statusline & frame tinting.
 */
export function getSessionAccentHex(sessionName) {
  const seed = sessionName || "omp-suite";
  const hash = djb2Hash(seed);
  // Wide dark-mode hue arc covering crisp cyan, mint, amber, coral, lavender, rose
  const hue = (hash % 360);
  const L = 0.76;
  let lo = 0.05;
  let hi = 0.19;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (oklchToRgb(L, mid, hue).inGamut) lo = mid;
    else hi = mid;
  }
  const C = Math.min(0.16, lo * 0.92);
  return rgbToHex(oklchToRgb(L, C, hue));
}

export function hexToRgb(hex) {
  const clean = hex.replace(/^#/, "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

export function fgHex(hex, text) {
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function bgHex(hex, text) {
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}
