import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// Same mock/restore convention as file-context-vault.test.ts.
import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realProjectFilter from '../../src/utils/project-filter.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realProjectNameSnapshot = { ...realProjectName };
const realProjectFilterSnapshot = { ...realProjectFilter };

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: [] }),
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) =>
    globalThis.fetch(`http://127.0.0.1:37777${apiPath}`, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      body: options?.body,
    }),
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({ allProjects: ['test-project'] }),
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

import { fileContextHandler } from '../../src/cli/handlers/file-context.js';
import { claimVaultNoteDelivery, resetVaultNoteDeliveries } from '../../src/cli/handlers/file-context-dedupe.js';
import { Database } from 'bun:sqlite';
import { logger } from '../../src/utils/logger.js';

let tmpDir: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;
let prevDataDir: string | undefined;
let prevVaultCmd: string | undefined;

const ROOT = '/v';
const note = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, title: `Titel ${slug}`, type: 'decision', verified: '', created: '2026-10-01',
  match: 'exact', broad_content: false, npatterns: 1,
  path: `${ROOT}/decisions/${slug}.md`, section: 'Entschieden', text: `Text von ${slug}`, ...extra,
});

/** Fake vault command; `byFile` maps the repo-relative file ($4) to the notes the vault returns. */
function setVault(byFile: Record<string, unknown[]>, pre = '') {
  let body = `${pre}\ncase "$4" in\n`;
  for (const [file, notes] of Object.entries(byFile)) {
    const json = join(tmpDir, `notes-${file}.json`);
    writeFileSync(json, JSON.stringify([{ path: file, notes }]));
    writeFileSync(join(tmpDir, file), 'x');
    body += `  ${file}) cat '${json}';;\n`;
  }
  body += '  *) echo "[]";;\nesac';
  const script = join(tmpDir, 'fake-context');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.NORD_VAULT_CONTEXT_CMD = script;
}

const abs = (f: string) => join(tmpDir, f);
const touch = (f: string, extra: Record<string, unknown> = {}) =>
  fileContextHandler.execute({
    sessionId: 's1', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: abs(f) }, ...extra,
  } as any);
const blockOf = async (f: string, extra: Record<string, unknown> = {}) =>
  (await touch(f, extra)).hookSpecificOutput?.additionalContext as string | undefined;

const dbPath = () => join(tmpDir, 'data', 'claude-mem.db');
function query(sql: string): any[] {
  if (!existsSync(dbPath())) return [];
  const db = new Database(dbPath(), { readonly: true });
  const r = db.query(sql).all() as any[];
  db.close();
  return r;
}
const count = (s: string, sub: string) => s.split(sub).length - 1;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-once-segment-test-'));
  spawnSync('git', ['init', '-q', tmpDir]);
  prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');
  prevVaultCmd = process.env.NORD_VAULT_CONTEXT_CMD;
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    JSON.stringify({ observations: [], count: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(s => s.mockRestore());
  if (fetchSpy) { fetchSpy.mockRestore(); fetchSpy = null; }
  if (prevDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = prevDataDir;
  if (prevVaultCmd === undefined) delete process.env.NORD_VAULT_CONTEXT_CMD;
  else process.env.NORD_VAULT_CONTEXT_CMD = prevVaultCmd;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/utils/project-filter.js', () => realProjectFilterSnapshot);
});

const EMPTY = { continue: true, suppressOutput: true };
const LIST = 'Weitere Notizen (nach Rang):';
const five = ['p', 'q', 'r', 's', 't'];

// Backlog claude-mem/vault-notizen-je-datei-wiederholen-titel-und-rangliste (Julius 2026-10-12:
// je Segment, Rangliste A): a note is named at most once per (session, agent) and segment —
// as text in rank 1–3, or as a title in the list; after compaction it may come again.
describe('vault note named once per segment', () => {
  it('AK1 a second file governed by the same three notes gets no block', async () => {
    setVault({ 'a.py': [note('p'), note('q'), note('r')], 'b.py': [note('p'), note('q'), note('r')] });
    expect(await blockOf('a.py')).toContain('Text von p');
    expect(await touch('b.py')).toEqual(EMPTY);
  });

  it('AK2 parallel reads of two files with the same note: [[p]] stands exactly once', async () => {
    setVault({ 'a.py': [note('p')], 'b.py': [note('p')] });
    const [x, y] = await Promise.all([blockOf('a.py'), blockOf('b.py')]);
    expect(count((x ?? '') + (y ?? ''), '[[p]]')).toBe(1);
    expect(count((x ?? '') + (y ?? ''), 'Text von p')).toBe(1);
  });

  it('AK3 a new note comes with its text, the known one is left out entirely', async () => {
    setVault({ 'a.py': [note('p')], 'b.py': [note('p'), note('n')] });
    await blockOf('a.py');
    const second = (await blockOf('b.py'))!;
    expect(second).toContain('[[n]] — Titel n (decision, verified —)\n  Entschieden:\n    Text von n');
    expect(second).not.toContain('[[p]]');
    expect(second).not.toContain('Text schon geliefert');
  });

  it('AK4-A the list names only titles not yet seen in the segment', async () => {
    setVault({ 'a.py': five.map(s => note(s)), 'b.py': [...five, 'u'].map(s => note(s)) });
    const first = (await blockOf('a.py'))!;
    expect(first).toContain(`${LIST}\n[[s]] — Titel s (decision, verified —)\n[[t]] — Titel t (decision, verified —)`);
    const second = (await blockOf('b.py'))!;
    for (const s of five) expect(second).not.toContain(`[[${s}]]`);
    expect(second).toContain(`${LIST}\n[[u]] — Titel u (decision, verified —)`);
  });

  it('AK4-A without a new title the line "Weitere Notizen" is gone', async () => {
    setVault({ 'a.py': five.map(s => note(s)), 'b.py': ['n', 'p', 'q', 'r', 's'].map(s => note(s)) });
    await blockOf('a.py');
    const second = (await blockOf('b.py'))!;
    expect(second).toContain('Text von n');
    expect(second).not.toContain(LIST);
    expect(second).not.toContain('[[s]]');
  });

  it('AK7-A a note first listed as a title gets its text once it ranks 1–3 for another file', async () => {
    setVault({ 'a.py': ['p', 'q', 'r', 's'].map(s => note(s)), 'b.py': ['s', 'x'].map(s => note(s)) });
    expect(await blockOf('a.py')).toContain(`${LIST}\n[[s]] — Titel s (decision, verified —)`);
    const second = (await blockOf('b.py'))!;
    expect(second).toContain('[[s]] — Titel s (decision, verified —)\n  Entschieden:\n    Text von s');
  });

  it('AK5 / AK5-A after compaction text and title come again (guard against "per session")', async () => {
    setVault({ 'a.py': five.map(s => note(s)), 'b.py': five.map(s => note(s)) });
    await blockOf('a.py');
    await resetVaultNoteDeliveries('s1');
    const again = (await blockOf('b.py'))!;
    expect(again).toContain('Text von p');
    expect(again).toContain(`${LIST}\n[[s]] — Titel s (decision, verified —)`);
  });

  it('AK6 a subagent gets the notes itself', async () => {
    setVault({ 'a.py': five.map(s => note(s)) });
    await blockOf('a.py');
    const sub = (await blockOf('a.py', { agentId: 'sub-1' }))!;
    expect(sub).toContain('Text von p');
    expect(sub).toContain(`${LIST}\n[[s]]`);
  });
});
