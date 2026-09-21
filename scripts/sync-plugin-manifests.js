#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const claudePluginPath = path.join(rootDir, '.claude-plugin', 'plugin.json');
const bundledClaudePluginPath = path.join(rootDir, 'plugin', '.claude-plugin', 'plugin.json');
const cursorPluginPaths = [
  path.join(rootDir, 'claude-mem-grok-bot', '.cursor-plugin', 'plugin.json'),
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

// Dieser Fork heisst als Plugin `nord-mem`, damit er neben dem installierten
// `claude-mem` stehen kann, ohne mit ihm zu kollidieren. Der Name darf deshalb
// NICHT aus package.json kommen:
//
//   - `pkg.name` ist der npm-Paketname und traegt die Modulaufloesung. Ihn
//     umzubenennen bricht jede Stelle, die das eigene Paket ueber seinen Namen
//     findet -- fuer nord-core ist genau dieser Bruch belegt.
//   - Der Plugin-Name ist demgegenueber reine Identitaet gegenueber Claude Code.
//
// `ecd5daca` benannte den Fork in plugin.json und marketplace.json um, aber nicht
// hier -- und weil plugin.json aus package.json ERZEUGT wird, setzte der erste
// Bau danach den Namen still auf `claude-mem` zurueck. Aufgefallen ist es erst
// beim Umschalten am 2026-09-21, an der installierten Kopie.
const PLUGIN_NAME = 'nord-mem';
const PLUGIN_DESCRIPTION =
  'Memory compression for Claude Code — nord fork of thedotmack/claude-mem: ' +
  'subtracted, per-tool-cwd attribution, observer must state where and why';

function syncClaudePlugin(plugin, pkg) {
  return {
    ...plugin,
    name: PLUGIN_NAME,
    version: pkg.version,
    description: PLUGIN_DESCRIPTION,
    homepage: pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    keywords: pkg.keywords,
    author: {
      ...(typeof plugin.author === 'object' && plugin.author ? plugin.author : {}),
      name: normalizeAuthorName(pkg.author),
    },
  };
}

function normalizeAuthorName(author) {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && typeof author.name === 'string') return author.name;
  return '';
}

function syncCursorPlugin(plugin, pkg) {
  return {
    ...plugin,
    version: pkg.version,
    description: plugin.description ?? pkg.description,
    homepage: plugin.homepage ?? pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    author: {
      ...(typeof plugin.author === 'object' && plugin.author ? plugin.author : {}),
      name: normalizeAuthorName(pkg.author),
    },
  };
}

function normalizeRepositoryUrl(repository) {
  if (typeof repository === 'string') return repository.replace(/\.git$/, '');
  if (repository && typeof repository === 'object' && typeof repository.url === 'string')
    return repository.url.replace(/\.git$/, '');
  return '';
}

function main() {
  for (const filePath of [packageJsonPath, claudePluginPath, bundledClaudePluginPath, ...cursorPluginPaths]) {
    if (!fs.existsSync(filePath)) {
      console.error(`Missing required file: ${filePath}`);
      process.exit(1);
    }
  }

  const pkg = readJson(packageJsonPath);
  const claudePlugin = readJson(claudePluginPath);
  const bundledClaudePlugin = readJson(bundledClaudePluginPath);
  const cursorPlugins = cursorPluginPaths.map(readJson);

  writeJson(claudePluginPath, syncClaudePlugin(claudePlugin, pkg));
  writeJson(bundledClaudePluginPath, syncClaudePlugin(bundledClaudePlugin, pkg));
  cursorPluginPaths.forEach((filePath, index) => writeJson(filePath, syncCursorPlugin(cursorPlugins[index], pkg)));

  console.log('✓ Synced plugin manifests from package.json');
}

main();
