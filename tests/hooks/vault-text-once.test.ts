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
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-text-once-test-'));
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

const ALREADY = ' — Text schon geliefert';

describe('vault text once — AK13', () => {
  it('AK13 dieselbe Notiz in einem zweiten Block trägt keinen Text, nur die Titelzeile mit dem Zusatz', async () => {
    setVault({ 'a.py': [note('p'), note('q'), note('r')], 'b.py': [note('p'), note('q'), note('r')] });
    const first = (await blockOf('a.py'))!;
    expect(first).toContain('Text von p');
    const second = (await blockOf('b.py'))!;
    expect(second).not.toContain('Text von');
    expect(second).not.toContain('Entschieden:');
    for (const s of ['p', 'q', 'r']) {
      expect(second).toContain(`[[${s}]] — Titel ${s} (decision, verified —)${ALREADY}`);
    }
    expect(second.split('\n').filter(l => l.startsWith('[['))).toHaveLength(3); // Rang und Zahl unverändert
  });

  it('AK13 eine neue Notiz bekommt ihren Text beim ersten Mal', async () => {
    setVault({ 'a.py': [note('p')], 'b.py': [note('p'), note('n')] });
    await blockOf('a.py');
    const second = (await blockOf('b.py'))!;
    expect(second).toContain(`[[p]] — Titel p (decision, verified —)${ALREADY}`);
    expect(second).toContain('[[n]] — Titel n (decision, verified —)\n  Entschieden:\n    Text von n');
    expect(second).not.toContain('Text von p');
    expect(second).not.toContain(`[[n]] — Titel n (decision, verified —)${ALREADY}`);
  });

  it('AK13 das Text-Protokoll gilt je Sitzung und Agent', async () => {
    setVault({ 'a.py': [note('p')], 'b.py': [note('p')], 'c.py': [note('p')], 'd.py': [note('p')] });
    expect(await blockOf('a.py')).toContain('Text von p');
    expect(await blockOf('b.py')).not.toContain('Text von p');
    expect(await blockOf('c.py', { sessionId: 'andere' })).toContain('Text von p');
    expect(await blockOf('c.py', { agentId: 'sub-1' })).toContain('Text von p');
    expect(await blockOf('d.py', { agentId: 'sub-1' })).not.toContain('Text von p'); // Subagent: einmal
  });

  it('AK13 parallele Reads auf zwei Dateien mit derselben Notiz: der Text erscheint genau einmal', async () => {
    setVault({ 'a.py': [note('p')], 'b.py': [note('p')] });
    const [x, y] = await Promise.all([blockOf('a.py'), blockOf('b.py')]);
    expect(x).toBeDefined();
    expect(y).toBeDefined();
    expect(count(x! + y!, 'Text von p')).toBe(1);
    expect(count(x! + y!, '[[p]]')).toBe(2);
    expect(count(x! + y!, ALREADY)).toBe(1);
  });

  it('AK13 der Pfad steht einmal im Kopf und nicht je Zeile', async () => {
    setVault({ 'a.py': ['a', 'b', 'c', 'd', 'e'].map(s => note(s)) });
    const ctx = (await blockOf('a.py'))!;
    const lines = ctx.split('\n');
    expect(lines[0]).toBe(
      `Vault-Notizen, die diese Datei regieren (ganze Notiz: ${ROOT}/{decisions,architecture,audits}/<slug>.md):`);
    expect(ctx).not.toContain('Pfad:');
    expect(ctx).not.toContain('→');
    expect(count(ctx, ROOT)).toBe(1);
    expect(ctx).toContain('Weitere Notizen (nach Rang):\n[[d]] — Titel d (decision, verified —)\n[[e]] — Titel e (decision, verified —)');
  });

  it('AK13 die Datenbank enthält nur Slugs, in beiden Tabellen', async () => {
    setVault({ 'a.py': [note('p', { title: 'GEHEIMER-TITEL-77', text: 'GEHEIMER-TEXT-77' }), note('q')] });
    await blockOf('a.py');
    const tables = query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .map(r => r.name).sort();
    expect(tables).toEqual(['file_context_injections', 'vault_note_deliveries', 'vault_note_texts']);
    const texts = query('SELECT * FROM vault_note_texts');
    expect(texts.map(r => r.slug).sort()).toEqual(['p', 'q']);
    expect(Object.keys(texts[0]).sort()).toEqual(['agent_id', 'delivered_at_epoch', 'session_id', 'slug']);
    let dump = '';
    for (const t of tables) dump += JSON.stringify(query(`SELECT * FROM "${t}"`));
    expect(dump).toContain('"p"');
    for (const secret of ['GEHEIMER', 'Titel', 'Text von', `${ROOT}/decisions`, 'Entschieden']) expect(dump).not.toContain(secret);
  });

  it('AK13 nach compact kommt der Text wieder', async () => {
    setVault({ 'a.py': [note('p')], 'b.py': [note('p')] });
    await blockOf('a.py');
    await blockOf('a.py', { agentId: 'sub-1' });
    expect(await blockOf('b.py')).not.toContain('Text von p');
    await resetVaultNoteDeliveries('s1');
    expect(query("SELECT * FROM vault_note_texts WHERE session_id='s1' AND agent_id=''")).toHaveLength(0);
    expect(query("SELECT * FROM vault_note_texts WHERE agent_id='sub-1'")).toHaveLength(1); // Subagent behält
    expect(await blockOf('b.py')).toContain('Text von p');
  });

  it('AK13 ohne sessionId trägt jeder Block den Text', async () => {
    setVault({ 'a.py': [note('p')], 'b.py': [note('p')] });
    expect(await blockOf('a.py', { sessionId: undefined })).toContain('Text von p');
    expect(await blockOf('b.py', { sessionId: undefined })).toContain('Text von p');
    expect(await blockOf('b.py', { sessionId: undefined })).toContain('Text von p'); // auch derselbe Pfad
  });

  it('AK13 der Block ist kleiner: drei Dateien mit denselben drei Notizen liefern zusammen mindestens 30 % weniger Zeichen als mit Text und Pfad je Block', async () => {
    const notes = ['p', 'q', 'r'].map(s => note(s, { text: `Inhalt von ${s}. `.repeat(40).trim() }));
    // Die alte Form, berechnet: Titelzeile, Pfad-Zeile, Abschnitt, Text je Notiz, Pfad in jedem Block.
    const oldBlock = ['Vault-Notizen, die diese Datei regieren:', ...notes.flatMap(n => [
      `[[${n.slug}]] — ${n.title} (decision, verified —)`, `  Pfad: ${n.path}`, `  ${n.section}:`,
      ...n.text.split('\n').map(l => `    ${l}`)])].join('\n');
    setVault({ 'a.py': notes, 'b.py': notes, 'c.py': notes });
    let neu = 0;
    for (const f of ['a.py', 'b.py', 'c.py']) neu += (await blockOf(f))!.length;
    expect(neu).toBeLessThanOrEqual(oldBlock.length * 3 * 0.7);
  });

  it('AK13 Edit und Subagent liefern dieselbe verkürzte Form', async () => {
    setVault({ 'a.py': [note('p'), note('q')], 'b.py': [note('p'), note('q'), note('s')] });
    await blockOf('a.py');                                   // Hauptsitzung hat p, q
    await blockOf('a.py', { agentId: 'sub-1' });             // Subagent hat p, q
    const viaEdit = (await blockOf('b.py', { toolName: 'Edit' }))!;
    const viaSub = (await blockOf('b.py', { agentId: 'sub-1' }))!;
    expect(viaEdit).toBe(viaSub);
    expect(viaEdit).toContain(`[[p]] — Titel p (decision, verified —)${ALREADY}`);
    expect(viaEdit).toContain('Text von s');
    expect(viaEdit).not.toContain('Text von p');
  });

  it('AK13 verliert eine parallele Instanz den Datei-Claim, setzt sie keine Text-Claims', async () => {
    // Das Vault-Skript schläft: in dieser Zeit gewinnt eine andere Instanz den Datei-Claim.
    setVault({ 'a.py': [note('p')] }, 'sleep 0.8');
    const pending = touch('a.py');
    await new Promise(r => setTimeout(r, 300));
    expect(claimVaultNoteDelivery('s1', '', abs('a.py'), ['p'])).toBe(true);
    expect(await pending).toEqual({ continue: true, suppressOutput: true });
    expect(query('SELECT * FROM vault_note_texts')).toHaveLength(0);
  });
});
