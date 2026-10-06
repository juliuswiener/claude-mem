import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// Same mock/restore convention as file-context-vault.test.ts: mock.module is
// process-global and sticky, so snapshot the real modules and re-register them
// in afterAll.
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
  // SessionStart handler: the timeline text comes from here.
  executeWithWorkerFallback: () => Promise.resolve('TIMELINE'),
  isWorkerFallback: () => false,
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({ allProjects: ['test-project'] }),
  resolveHookProjectPath: (p: string) => p,
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

import { contextHandler } from '../../src/cli/handlers/context.js';
import { fileContextHandler } from '../../src/cli/handlers/file-context.js';
import { claimVaultNoteDelivery, resetVaultNoteDeliveries } from '../../src/cli/handlers/file-context-dedupe.js';
import { claudeCodeAdapter } from '../../src/cli/adapters/claude-code.js';
import { Database } from 'bun:sqlite';
import { logger } from '../../src/utils/logger.js';

let tmpDir: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;
let prevDataDir: string | undefined;
let prevVaultCmd: string | undefined;

const note = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, title: `Titel ${slug}`, type: 'decision', verified: '2026-09-26', created: '2026-10-01',
  match: 'exact', broad_content: false, npatterns: 1,
  path: `/abs/decisions/${slug}.md`, section: 'Entschieden', text: `Text von ${slug}`, ...extra,
});

/** Fake vault command; `byFile` maps the repo-relative file to the notes the vault returns. */
function setVault(byFile: Record<string, unknown[]>) {
  let body = 'case "$4" in\n';
  for (const [file, notes] of Object.entries(byFile)) {
    const json = join(tmpDir, `notes-${file}.json`);
    writeFileSync(json, JSON.stringify([{ path: file, notes }]));
    body += `  ${file}) cat '${json}';;\n`;
  }
  body += '  *) echo "[]";;\nesac';
  setVaultScript(body);
}

function setVaultScript(body: string) {
  const script = join(tmpDir, 'fake-context');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.NORD_VAULT_CONTEXT_CMD = script;
}

const abs = (f: string) => join(tmpDir, f);
const seed = (session: string, agent: string, file: string, slugs: string[]) =>
  claimVaultNoteDelivery(session, agent, abs(file), slugs);

function rows(): { session_id: string; agent_id: string; file_path: string; slugs: string }[] {
  const dbPath = join(tmpDir, 'data', 'claude-mem.db');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  const r = db.query('SELECT * FROM vault_note_deliveries').all() as any[];
  db.close();
  return r;
}

const sessionStart = async (sessionSource: string | undefined, sessionId = 'main') =>
  (await contextHandler.execute({ sessionId, cwd: tmpDir, platform: 'claude-code', sessionSource } as any))
    .hookSpecificOutput!.additionalContext;

const DIGEST_HEAD = 'Vault-Notizen aus der bisherigen Arbeit';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-compaction-test-'));
  spawnSync('git', ['init', '-q', tmpDir]);
  prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');
  prevVaultCmd = process.env.NORD_VAULT_CONTEXT_CMD;
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

describe('vault compaction — AK10', () => {
  it('AK10 compact löscht das Protokoll der Hauptsitzung, nicht das anderer Sitzungen und nicht das von Subagenten', async () => {
    setVault({});
    seed('main', '', 'a.py', ['x']);
    seed('main', '', 'b.py', ['x']);
    seed('main', 'agent-1', 'a.py', ['x']);
    seed('other', '', 'a.py', ['x']);
    expect(rows()).toHaveLength(4);

    await sessionStart('compact', 'main');

    expect(rows().map(r => `${r.session_id}|${r.agent_id}|${r.file_path}`).sort()).toEqual([
      `main|agent-1|${abs('a.py')}`,
      `other||${abs('a.py')}`,
    ]);
  });

  it('AK10 ohne sessionId tut resetVaultNoteDeliveries nichts', async () => {
    setVault({ 'a.py': [note('x')] });
    seed('main', '', 'a.py', ['x']);
    expect(await resetVaultNoteDeliveries('')).toBe('');
    expect(rows()).toHaveLength(1);
  });

  it('AK10 nach compact liefert das Gate dieselbe Datei wieder', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ observations: [], count: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    setVault({ 'a.py': [note('x')] });
    writeFileSync(abs('a.py'), 'x');
    const read = () => fileContextHandler.execute({
      sessionId: 'main', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: abs('a.py') },
    } as any);

    expect((await read()).hookSpecificOutput!.additionalContext).toContain('[[x]]');
    expect(await read()).toEqual({ continue: true, suppressOutput: true }); // schweigt: schon geliefert
    await sessionStart('compact', 'main');
    expect((await read()).hookSpecificOutput!.additionalContext).toContain('[[x]]');
  });

  it('AK10 der Digest nennt die Notizen der Arbeitsmenge, häufigste zuerst, die ersten drei mit Text, der Pfad steht im Kopf', async () => {
    setVault({
      'a.py': [note('p'), note('q')],
      'b.py': [note('q'), note('r')],
      'c.py': [note('q')],
      'd.py': [note('q'), note('p'), note('s')],
    });
    seed('main', '', 'a.py', ['p', 'q']);
    seed('main', '', 'b.py', ['q', 'r']);
    seed('main', '', 'c.py', ['q']);
    seed('main', '', 'd.py', ['q', 'p', 's']);

    const out = await sessionStart('compact', 'main');

    expect(out).toContain(DIGEST_HEAD);
    const order = [...out.matchAll(/^\[\[([a-z]+)\]\]/gm)].map(m => m[1]);
    expect(order).toEqual(['q', 'p', 's', 'r']); // q: 4 Dateien, p: 2, dann Gleichstand nach Vault-Ergebnis der zuletzt gelieferten Datei (d.py)
    expect(out).toContain('[[q]] — Titel q (decision, verified 2026-09-26) — gilt für 4 Dateien: d.py, c.py, b.py …');
    expect(out).toContain('[[p]] — Titel p (decision, verified 2026-09-26) — gilt für 2 Dateien: d.py, a.py');
    expect(out).toContain('ganze Notiz: /abs/{decisions,architecture,audits}/<slug>.md');
    expect(out).not.toContain('Pfad:');
    expect(out).toContain('  Entschieden:\n    Text von q');
    expect(out).not.toContain('Text von r'); // vierte Notiz: nur Titelzeile
    expect(out).toContain('Weitere:\n[[r]] — Titel r (decision, verified 2026-09-26)');
  });

  it('AK10 der Digest kürzt den Text auf 700 Zeichen mit Marker', async () => {
    setVault({ 'a.py': [note('lang', { text: '§'.repeat(3000) })] });
    seed('main', '', 'a.py', ['lang']);
    const out = await sessionStart('compact', 'main');
    expect(out.match(/§/g)!.length).toBe(700);
    expect(out).toContain('[… gekürzt');
  });

  it('AK10 der Digest bleibt unter 8000 Zeichen', async () => {
    const notes = Array.from({ length: 14 }, (_, i) => note(`n${i}`, { text: `T${i}`.repeat(3000) }));
    setVault({ 'a.py': notes });
    seed('main', '', 'a.py', notes.map(n => n.slug));
    const out = await resetVaultNoteDeliveries('main');
    expect(out).toContain(DIGEST_HEAD);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out.length).toBeGreaterThan(3000); // ein echter Digest, nicht leer gekürzt
  });

  it('AK10 der Digest hält die Obergrenze auch bei langen Titelzeilen', async () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`n${i}`, { title: 'W'.repeat(2000), text: '' }));
    setVault({ 'a.py': notes });
    seed('main', '', 'a.py', notes.map(n => n.slug));
    const out = await resetVaultNoteDeliveries('main');
    expect(out.length).toBeLessThanOrEqual(8000);
  });

  it('AK10 leere Arbeitsmenge: kein Digest, kein Fehler', async () => {
    setVault({ 'a.py': [note('x')] });
    expect(await resetVaultNoteDeliveries('main')).toBe('');
    expect(await sessionStart('compact', 'main')).toBe('TIMELINE');
  });

  it('AK10 der Vault liefert nichts: kein Digest, der Schnitt geschieht', async () => {
    setVault({});
    seed('main', '', 'a.py', ['x']);
    expect(await sessionStart('compact', 'main')).toBe('TIMELINE');
    expect(rows()).toHaveLength(0);
  });

  it('AK10 startup, resume und clear lösen weder Schnitt noch Digest aus', async () => {
    setVault({ 'a.py': [note('x')] });
    seed('main', '', 'a.py', ['x']);
    for (const source of ['startup', 'resume', 'clear', undefined]) {
      const out = await sessionStart(source, 'main');
      expect(out).toBe('TIMELINE');
      expect(rows()).toHaveLength(1);
    }
  });

  it('AK10 Vault-Fehler: der Schnitt geschieht, der Digest bleibt leer', async () => {
    seed('main', '', 'a.py', ['x']);
    for (const body of ['exit 1', 'echo garbage']) {
      setVaultScript(body);
      seed('main', '', 'a.py', ['x']);
      expect(await resetVaultNoteDeliveries('main')).toBe('');
      expect(rows()).toHaveLength(0);
    }
    setVaultScript('exit 1');
    seed('main', '', 'a.py', ['x']);
    expect(await sessionStart('compact', 'main')).toBe('TIMELINE');
    expect(rows()).toHaveLength(0);
  });

  it('AK10 der Digest zeigt nur Notizen, die der Agent im Protokoll hatte', async () => {
    setVault({ 'a.py': [note('gesehen'), note('ungesehen')], 'b.py': [note('fremd')] });
    seed('main', '', 'a.py', ['gesehen']);
    seed('other', '', 'b.py', ['fremd']); // andere Sitzung
    seed('main', 'agent-1', 'b.py', ['fremd']); // Subagent
    const out = await sessionStart('compact', 'main');
    expect(out).toContain('[[gesehen]]');
    expect(out).not.toContain('ungesehen');
    expect(out).not.toContain('fremd');
  });

  it('AK10 die Arbeitsmenge sind die zuletzt gelieferten höchstens 10 Dateien', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.py`);
    setVault(Object.fromEntries(files.map(f => [f, [note(`n-${f.replace('.py', '')}`)]])));
    const db = () => new Database(join(tmpDir, 'data', 'claude-mem.db'));
    files.forEach(f => seed('main', '', f, [`n-${f.replace('.py', '')}`]));
    const d = db();
    files.forEach((f, i) => d.query('UPDATE vault_note_deliveries SET delivered_at_epoch = ? WHERE file_path = ?')
      .run(Date.now() - 1000 * (files.length - i), abs(f))); // f11 zuletzt
    d.close();
    const out = await resetVaultNoteDeliveries('main');
    expect(out).toContain('[[n-f11]]');
    expect(out).toContain('[[n-f2]]');
    expect(out).not.toContain('[[n-f1]]');
    expect(out).not.toContain('[[n-f0]]');
  });

  it('AK10 Schnitt und Digest speichern nichts außer Slugs', async () => {
    setVault({ 'a.py': [note('x', { text: 'GEHEIMTEXT' })] });
    seed('main', '', 'a.py', ['x']);
    seed('other', '', 'a.py', ['x']);
    const out = await sessionStart('compact', 'main');
    expect(out).toContain('GEHEIMTEXT');
    const dbPath = join(tmpDir, 'data', 'claude-mem.db');
    const db = new Database(dbPath, { readonly: true });
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as any[]).map(r => r.name).sort();
    let dump = '';
    for (const t of tables) dump += JSON.stringify(db.query(`SELECT * FROM "${t}"`).all());
    db.close();
    expect(tables).toEqual(['file_context_injections', 'vault_note_deliveries', 'vault_note_texts']);
    expect(rows().map(r => JSON.parse(r.slugs))).toEqual([['x']]); // nur der Slug der anderen Sitzung bleibt
    for (const forbidden of ['GEHEIMTEXT', 'Titel x', '/abs/decisions/x.md', 'Entschieden']) expect(dump).not.toContain(forbidden);
  });

  it('AK10 der Digest erscheint auch, wenn der Worker nicht antwortet oder das Projekt ausgeschlossen ist', async () => {
    setVault({ 'a.py': [note('x')] });
    seed('main', '', 'a.py', ['x']);
    const workerUtils = await import('../../src/shared/worker-utils.js');
    const spy = spyOn(workerUtils, 'isWorkerFallback').mockReturnValue(true);
    try {
      expect(await sessionStart('compact', 'main')).toContain('[[x]]');
    } finally {
      spy.mockRestore();
    }
  });

  it('AK10 der claude-code-Adapter reicht source als sessionSource durch', () => {
    const norm = (source: unknown) =>
      claudeCodeAdapter.normalizeInput({ session_id: 's', cwd: tmpDir, source }).sessionSource;
    expect(norm('compact')).toBe('compact');
    expect(norm('startup')).toBe('startup');
    expect(norm('unbekannt')).toBeUndefined();
    expect(norm(undefined)).toBeUndefined();
  });
});
