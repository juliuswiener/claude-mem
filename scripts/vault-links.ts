#!/usr/bin/env bun
// K5a measurement (read-only): how well do observations recover the declared applies_to of vault notes.
// Usage: bun scripts/vault-links.ts --project <db-project> --repo <repo-root> --since <YYYY-MM-DD> [--json]
import { resolveDbPath } from '../src/shared/paths.js';
import { renderJson, renderMarkdown, runReport } from '../src/services/vault-links/report.js';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const project = opt('--project');
const repo = opt('--repo');
const since = opt('--since');
if (!project || !repo || !since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('Usage: bun scripts/vault-links.ts --project <db-project> --repo <repo-root> --since <YYYY-MM-DD> [--json]');
  process.exit(2);
}
const report = await runReport({ dbPath: resolveDbPath(), project, repo, since, now: Date.now() });
console.log(args.includes('--json') ? renderJson(report) : renderMarkdown(report));
