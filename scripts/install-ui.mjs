#!/usr/bin/env node
/**
 * Wires OMP Suite's native `statusLine` and `title` scripts into
 * `~/.gemini/antigravity-cli/settings.json` so every normal `agy` session
 * automatically renders the newest OMP v19 / Tern statusline and live tray.
 *
 * Usage:
 *   node scripts/install-ui.mjs               # Install (preserves existing non-OMP custom statusLine)
 *   node scripts/install-ui.mjs --force       # Overwrite existing statusLine/title
 *   node scripts/install-ui.mjs --uninstall   # Remove OMP Suite statusLine/title entries
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

export function resolveSettingsPath(explicitPath) {
  return explicitPath || process.env.AGY_SETTINGS_PATH || path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
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
  const canSetStatus =
    force || !existingStatusCmd || existingStatusCmd.includes("omp-statusline.mjs");

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

// Run when invoked directly from CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--uninstall")) {
    const res = uninstallNativeUi();
    console.log(res.changed ? `Removed OMP Suite statusLine/title from ${res.file}` : `Nothing to remove in ${res.file}`);
  } else {
    const res = installNativeUi({ force: args.has("--force") });
    console.log(
      res.changed
        ? `Installed native OMP v19 statusLine & title into ${res.file}`
        : `OMP Suite native statusLine already configured in ${res.file}`
    );
  }
}
