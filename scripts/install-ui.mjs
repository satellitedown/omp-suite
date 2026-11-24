#!/usr/bin/env node
/**
 * Installs OMP Suite's native Antigravity CLI + Tern integrations:
 *  1. Native `agy` statusLine & terminal title in `~/.gemini/antigravity-cli/settings.json`
 *  2. Native Tern Chatbox launcher (`~/.local/bin/agy-tern`) + shell hook in `~/.zshrc` / `~/.bashrc`
 *     so typing `agy` interactively inside Tern automatically launches the real Tern Surface
 *     Protocol (TSP) `omp.session` chatbox backed by official `agy acp --stdio`!
 *
 * Usage:
 *   node scripts/install-ui.mjs                # Install native statusLine/title + Tern `agy` chatbox hook
 *   node scripts/install-ui.mjs --status-only  # Only wire settings.json statusLine/title (no shell rc edit)
 *   node scripts/install-ui.mjs --force        # Overwrite an existing custom statusLine/title
 *   node scripts/install-ui.mjs --uninstall    # Cleanly remove all settings.json & shell rc hooks
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

const BLOCK_START = "# >>> omp-suite tern-agy >>>";
const BLOCK_END = "# <<< omp-suite tern-agy <<<";

export function resolveSettingsPath(explicitPath) {
  return (
    explicitPath ||
    process.env.AGY_SETTINGS_PATH ||
    path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json")
  );
}

function readSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeSettingsAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.omp.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function formatNodeCmd(absScriptPath) {
  const quoted = /\s/.test(absScriptPath) ? `"${absScriptPath}"` : absScriptPath;
  return `node ${quoted}`;
}

export function installNativeUi({ settingsPath, pluginRoot = PLUGIN_ROOT, force = false } = {}) {
  const file = resolveSettingsPath(settingsPath);
  const settings = readSettings(file);

  const statusCmd = formatNodeCmd(path.resolve(pluginRoot, "scripts", "omp-statusline.mjs"));
  const titleCmd = formatNodeCmd(path.resolve(pluginRoot, "scripts", "omp-title.mjs"));

  let changed = false;

  const existingStatusCmd = settings.statusLine?.command || "";
  const canSetStatus = force || !existingStatusCmd || existingStatusCmd.includes("omp-statusline.mjs");

  if (canSetStatus && existingStatusCmd !== statusCmd) {
    settings.statusLine = {
      type: "command",
      command: statusCmd,
      enabled: true,
      padding: 0,
      stack_with_default: false,
    };
    changed = true;
  }

  const existingTitleCmd = settings.title?.command || "";
  const canSetTitle = force || !existingTitleCmd || existingTitleCmd.includes("omp-title.mjs");
  if (canSetTitle && existingTitleCmd !== titleCmd) {
    settings.title = {
      type: "command",
      command: titleCmd,
      enabled: true,
    };
    changed = true;
  }

  if (changed) {
    writeSettingsAtomic(file, settings);
  }
  return { file, changed, statusLine: settings.statusLine, title: settings.title };
}

export function uninstallNativeUi({ settingsPath } = {}) {
  const file = resolveSettingsPath(settingsPath);
  const settings = readSettings(file);
  let changed = false;
  if (settings.statusLine?.command?.includes("omp-statusline.mjs")) {
    delete settings.statusLine;
    changed = true;
  }
  if (settings.title?.command?.includes("omp-title.mjs")) {
    delete settings.title;
    changed = true;
  }
  if (changed) writeSettingsAtomic(file, settings);
  return { file, changed };
}

function buildShellSnippet(ternAgyScript) {
  return `${BLOCK_START}
# Launch OMP Suite's native Tern Surface Protocol (TSP) chatbox when running \`agy\` interactively in Tern.
# Subcommands (\`agy plugin\`, \`agy -p\`, \`agy acp\`, etc.) and non-Tern terminals pass straight to stock \`agy\`.
# Run \`agy -raw\` or \`agy --raw\` anytime to launch pure stock \`agy\` bypassing OMP Suite UI & hooks.
agy() {
  local _omp_raw=0 _omp_has_settings=0 _omp_arg _omp_n _omp_a
  for _omp_arg in "$@"; do
    case "$_omp_arg" in
      -raw|--raw) _omp_raw=1 ;;
      --settings|--settings=*) _omp_has_settings=1 ;;
    esac
  done
  if [ "$_omp_raw" = "1" ]; then
    _omp_n=$#
    while [ "$_omp_n" -gt 0 ]; do
      _omp_a=$1
      shift
      _omp_n=$((_omp_n - 1))
      if [ "$_omp_a" != "-raw" ] && [ "$_omp_a" != "--raw" ]; then
        set -- "$@" "$_omp_a"
      fi
    done
    if [ "$_omp_has_settings" = "1" ]; then
      OMP_RAW_AGY=1 OMP_PLAIN_AGY=1 OMP_NO_AUTO_STATUSLINE=1 command agy "$@"
    else
      OMP_RAW_AGY=1 OMP_PLAIN_AGY=1 OMP_NO_AUTO_STATUSLINE=1 command agy --settings '{"statusLine":{"enabled":false},"title":{"enabled":false}}' "$@"
    fi
    return $?
  fi
  if [ -n "$TERN_PANE" ] && [ -t 0 ] && [ -t 1 ] && [ "$OMP_PLAIN_AGY" != "1" ]; then
    case "\${1:-}" in
      ""|--continue|-c|--conversation|--resume|-r|--agent|--model|--mode|--effort|--sandbox|--add-dir|--dangerously-skip-permissions)
        node "${ternAgyScript}" "$@"
        return $?
        ;;
    esac
  fi
  command agy "$@"
}
${BLOCK_END}`;
}

function stripBlock(content) {
  const re = new RegExp(`\\n?${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n?`, "g");
  return content.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
}

export function installTernShellIntegration({
  pluginRoot = PLUGIN_ROOT,
  binDir = path.join(os.homedir(), ".local", "bin"),
  rcFiles,
} = {}) {
  const ternAgyScript = path.resolve(pluginRoot, "scripts", "tern-agy.mjs");

  // 1. Install standalone `~/.local/bin/agy-tern` launcher
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, "agy-tern");
  const binContent = `#!/usr/bin/env sh\nexec node "${ternAgyScript}" "$@"\n`;
  fs.writeFileSync(binPath, binContent, { mode: 0o755 });

  // 2. Patch interactive shell rc file(s) idempotently
  const targets =
    rcFiles ||
    [path.join(os.homedir(), ".zshrc"), path.join(os.homedir(), ".bashrc")].filter((p) => fs.existsSync(p));

  const snippet = buildShellSnippet(ternAgyScript);
  const updated = [];

  for (const rc of targets) {
    const prev = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
    const cleaned = stripBlock(prev).trimEnd();
    const next = `${cleaned}\n\n${snippet}\n`;
    if (next !== prev) {
      fs.writeFileSync(rc, next, "utf8");
      updated.push(rc);
    }
  }

  return { binPath, updatedRcFiles: updated };
}

export function uninstallTernShellIntegration({
  binDir = path.join(os.homedir(), ".local", "bin"),
  rcFiles,
} = {}) {
  const binPath = path.join(binDir, "agy-tern");
  if (fs.existsSync(binPath)) fs.unlinkSync(binPath);

  const targets =
    rcFiles ||
    [path.join(os.homedir(), ".zshrc"), path.join(os.homedir(), ".bashrc")].filter((p) => fs.existsSync(p));

  const cleanedFiles = [];
  for (const rc of targets) {
    if (!fs.existsSync(rc)) continue;
    const prev = fs.readFileSync(rc, "utf8");
    if (prev.includes(BLOCK_START)) {
      const next = stripBlock(prev).trimEnd() + "\n";
      fs.writeFileSync(rc, next, "utf8");
      cleanedFiles.push(rc);
    }
  }
  return { removedBin: binPath, cleanedFiles };
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--uninstall")) {
    const ui = uninstallNativeUi();
    const sh = uninstallTernShellIntegration();
    console.log(
      `Uninstalled OMP Suite UI (settings changed=${ui.changed}, shell files cleaned=${sh.cleanedFiles.join(", ") || "none"})`
    );
  } else {
    const ui = installNativeUi({ force: args.has("--force") });
    console.log(
      ui.changed
        ? `Installed native OMP v19 statusLine & title into ${ui.file}`
        : `Native OMP v19 statusLine already configured in ${ui.file}`
    );
    if (!args.has("--status-only")) {
      const sh = installTernShellIntegration();
      console.log(`Installed Tern chatbox launcher: ${sh.binPath}`);
      if (sh.updatedRcFiles.length > 0) {
        console.log(`Wired \`agy\` Tern chatbox integration into: ${sh.updatedRcFiles.join(", ")}`);
        console.log(`Run \`source ${sh.updatedRcFiles[0]}\` (or open a new Tern tab) and type \`agy\`!`);
      } else {
        console.log("Shell hook already up to date.");
      }
    }
  }
}
