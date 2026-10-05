import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

// Same mock/restore convention as file-context.test.ts: mock.module is
// process-global and sticky, so snapshot the real modules first and
// re-register them in afterAll.
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
import { claimVaultNoteDelivery } from '../../src/cli/handlers/file-context-dedupe.js';
import { Database } from 'bun:sqlite';
import { logger } from '../../src/utils/logger.js';

const PADDING = 'x'.repeat(2_000);

let tmpDir: string;
let testFile: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;
let prevDataDir: string | undefined;
let prevVaultCmd: string | undefined;

function note(slug: string, extra: Record<string, unknown> = {}) {
  return { slug, title: `Titel ${slug}`, type: 'decision', verified: '', created: '2026-10-01',
    match: 'exact', broad_content: false, npatterns: 1, ...extra };
}

/** Fake vault command: a shell script that runs `body`. */
function setVaultScript(body: string) {
  const script = join(tmpDir, 'fake-context');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.NORD_VAULT_CONTEXT_CMD = script;
}

function setVaultNotes(notes: unknown[]) {
  const json = join(tmpDir, 'notes.json');
  writeFileSync(json, JSON.stringify([{ path: 'test.md', notes }]));
  setVaultScript(`cat '${json}'`);
}

function observations() {
  return new Response(JSON.stringify({
    observations: [{
      id: 1, memory_session_id: 'session-1', title: 'Observation 1', type: 'discovery',
      created_at_epoch: Date.now() + 60_000, files_read: '[]', files_modified: JSON.stringify(['test.md']),
    }],
    count: 1,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function noObservations() {
  return new Response(JSON.stringify({ observations: [], count: 0 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function read() {
  return fileContextHandler.execute({
    sessionId: 'sess', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile },
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-context-vault-test-'));
  spawnSync('git', ['init', '-q', tmpDir]); // the adapter needs a git repo root
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, PADDING);

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

const VAULT_BLOCK = 'Vault-Notizen, die diese Datei regieren:\n[[regel]] — Titel regel (decision, verified —)';

function run(extra: Record<string, unknown>, file = testFile) {
  return fileContextHandler.execute({
    sessionId: `sess-${Math.random()}`, cwd: tmpDir, toolName: 'Read', toolInput: { file_path: file }, ...extra,
  } as any);
}

describe('fileContextHandler — AK2 edit tools and AK2a silent exits', () => {
  it('AK2 Edit liefert nur den Vault-Block', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultNotes([note('regel')]);
    const out = (await run({ toolName: 'Edit' })).hookSpecificOutput!;
    expect(out.additionalContext).toBe(VAULT_BLOCK);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AK2 Write/MultiEdit ebenso', async () => {
    for (const toolName of ['Write', 'MultiEdit']) {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
      setVaultNotes([note('regel')]);
      const out = (await run({ toolName })).hookSpecificOutput!;
      expect(out.additionalContext).toBe(VAULT_BLOCK);
      expect(out.additionalContext).not.toContain('prior observations');
      fetchSpy.mockRestore();
    }
  });

  it('AK2 kein deny bei Edit', async () => {
    for (const body of ['exit 1', 'echo garbage']) {
      setVaultScript(body);
      const r = await run({ toolName: 'Edit' });
      expect((r.hookSpecificOutput as any)?.permissionDecision).not.toBe('deny');
    }
    setVaultNotes([note('regel')]);
    const r = await run({ toolName: 'Edit' });
    expect((r.hookSpecificOutput as any)?.permissionDecision).toBe('allow');
  });

  it('AK2 Edit ohne Notizen bleibt still', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultNotes([]);
    expect(await run({ toolName: 'Edit' })).toEqual({ continue: true, suppressOutput: true });
  });

  it('AK2a Datei unter 1500 Bytes liefert Notizen', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultNotes([note('regel')]);
    const small = join(tmpDir, 'small.md');
    writeFileSync(small, 'klein');
    const out = (await run({}, small)).hookSpecificOutput!;
    expect(out.additionalContext).toBe(VAULT_BLOCK);
  });

  it('AK2a ausgeschlossenes Projekt liefert Notizen', async () => {
    const prev = process.env.CLAUDE_MEM_INTERNAL;
    process.env.CLAUDE_MEM_INTERNAL = '1'; // shouldTrackProject(cwd) === false
    try {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
      setVaultNotes([note('regel')]);
      const out = (await run({})).hookSpecificOutput!;
      expect(out.additionalContext).toBe(VAULT_BLOCK);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_MEM_INTERNAL;
      else process.env.CLAUDE_MEM_INTERNAL = prev;
    }
  });

  it('AK2a Subagent liefert Notizen aber keine Timeline', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultNotes([note('regel')]);
    const out = (await run({ agentId: 'subagent-1' })).hookSpecificOutput!;
    expect(out.additionalContext).toBe(VAULT_BLOCK);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('AK2a ohne Observations liefert Notizen', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]);
    const out = (await run({})).hookSpecificOutput!;
    expect(out.additionalContext).toBe(VAULT_BLOCK);
  });

  it('AK2 Hook-Matcher fuer file-context traegt Read, Edit, Write, MultiEdit', () => {
    const hooks = JSON.parse(readFileSync(new URL('../../plugin/hooks/hooks.json', import.meta.url), 'utf-8')).hooks;
    const entry = hooks.PreToolUse.find((m: any) =>
      m.hooks.some((h: any) => h.command.includes('hook claude-code file-context')));
    expect(entry.matcher.split('|').sort()).toEqual(['Edit', 'MultiEdit', 'Read', 'Write']);
  });
});

describe('fileContextHandler — vault notes in the gate', () => {
  it('(a) one additionalContext with timeline AND vault block', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultNotes([note('regel-a', { verified: '2026-10-02' })]);

    const out = (await read()).hookSpecificOutput!;
    expect(out.permissionDecision).toBe('allow');
    expect(out.additionalContext).toContain('prior observations');
    expect(out.additionalContext).toContain('Vault-Notizen, die diese Datei regieren:');
    expect(out.additionalContext).toContain('[[regel-a]] — Titel regel-a (decision, verified 2026-10-02)');
    expect(out.additionalContext!.indexOf('prior observations'))
      .toBeLessThan(out.additionalContext!.indexOf('Vault-Notizen'));
  });

  it('(b) file without observations gets the vault block alone', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel-b')]);

    const out = (await read()).hookSpecificOutput!;
    expect(out.permissionDecision).toBe('allow');
    expect(out.additionalContext).not.toContain('prior observations');
    expect(out.additionalContext).toBe(
      'Vault-Notizen, die diese Datei regieren:\n[[regel-b]] — Titel regel-b (decision, verified —)');
  });

  it('(c) failing command, garbage output, missing command: output as before, no throw', async () => {
    const cases = ['exit 1', 'echo not-json', 'echo \'{"a":1}\''];
    for (const body of cases) {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
      setVaultScript(body);
      expect(await read()).toEqual({ continue: true, suppressOutput: true });
      fetchSpy.mockRestore();
    }

    process.env.NORD_VAULT_CONTEXT_CMD = join(tmpDir, 'does-not-exist');
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    const out = (await read()).hookSpecificOutput!;
    expect(out.additionalContext).toContain('prior observations');
    expect(out.additionalContext).not.toContain('Vault-Notizen');
  });

  it('(c) timeout: command hanging past 2 s is dropped, timeline stays', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultScript('exec sleep 10');

    const started = Date.now();
    const out = (await read()).hookSpecificOutput!;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.additionalContext).toContain('prior observations');
    expect(out.additionalContext).not.toContain('Vault-Notizen');
  }, 10_000);

  it('(d) no notes: output byte-identical to the timeline alone', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultNotes([]);
    const withEmpty = (await read()).hookSpecificOutput!.additionalContext;
    fetchSpy.mockRestore();

    // Fresh session id so the dedupe claim of the first call does not apply.
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultScript('exit 1');
    const failing = (await fileContextHandler.execute({
      sessionId: 'sess-2', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile },
    })).hookSpecificOutput!.additionalContext;

    expect(withEmpty).toContain('prior observations');
    expect(withEmpty).not.toContain('Vault-Notizen');
    // `Current:` line carries the clock; compare the rest.
    const strip = (s?: string) => s!.replace(/^Current:.*\n/, '');
    expect(strip(withEmpty)).toBe(strip(failing));
  });

  it('(e) five notes: three lines plus "und 2 weitere"', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(['n1', 'n2', 'n3', 'n4', 'n5'].map(s => note(s)));

    const lines = (await read()).hookSpecificOutput!.additionalContext!.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('[[n1]]');
    expect(lines[3]).toContain('[[n3]]');
    expect(lines[4]).toBe('und 2 weitere');
  });

  it('(f) broad_content notes are left out', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('breit', { broad_content: true }), note('eng')]);

    const ctx = (await read()).hookSpecificOutput!.additionalContext!;
    expect(ctx).toContain('[[eng]]');
    expect(ctx).not.toContain('breit');
  });

  it('(g) never denies, whatever the vault returns', async () => {
    const scenarios: Array<() => void> = [
      () => setVaultNotes([note('x')]),
      () => setVaultNotes([]),
      () => setVaultScript('exit 1'),
      () => setVaultScript('echo garbage'),
    ];
    for (const setup of scenarios) {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
      setup();
      const result = await fileContextHandler.execute({
        sessionId: `sess-${Math.random()}`, cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile },
      });
      expect((result.hookSpecificOutput as any)?.permissionDecision).not.toBe('deny');
      fetchSpy.mockRestore();
    }
  });
});

describe('fileContextHandler — AK4 Sitzungsprotokoll der Vault-Notizen', () => {
  const at = (extra: Record<string, unknown>, file = testFile) =>
    fileContextHandler.execute({
      sessionId: 'ak4', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: file }, ...extra,
    } as any);
  const silent = { continue: true, suppressOutput: true };

  it('AK4 erster Read liefert, zweiter derselben Datei schweigt', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]);
    expect((await at({})).hookSpecificOutput!.additionalContext).toBe(VAULT_BLOCK);
    expect(await at({})).toEqual(silent);
  });

  it('AK4 andere Datei liefert wieder', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]);
    const other = join(tmpDir, 'other.md');
    writeFileSync(other, PADDING);
    await at({});
    expect((await at({}, other)).hookSpecificOutput!.additionalContext).toBe(VAULT_BLOCK);
  });

  it('AK4 andere Sitzung liefert wieder', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]);
    await at({});
    expect((await at({ sessionId: 'ak4-zwei' })).hookSpecificOutput!.additionalContext).toBe(VAULT_BLOCK);
  });

  it('AK4 Subagent und Hauptsitzung führen getrennte Protokolle', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]);
    await at({});
    expect((await at({ agentId: 'sub-1' })).hookSpecificOutput!.additionalContext).toBe(VAULT_BLOCK);
    expect(await at({ agentId: 'sub-1' })).toEqual(silent);
    expect((await at({ agentId: 'sub-2' })).hookSpecificOutput!.additionalContext).toBe(VAULT_BLOCK);
    expect(await at({})).toEqual(silent);
  });

  it('AK4 Edit nach Read derselben Datei schweigt', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]);
    await at({});
    for (const toolName of ['Edit', 'Write', 'MultiEdit']) expect(await at({ toolName })).toEqual(silent);
  });

  it('AK4 Protokoll speichert Slugs und keinen Notiztext', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel', { title: 'GEHEIMER-TITEL' })]);
    await at({});
    const db = new Database(join(tmpDir, 'data', 'claude-mem.db'), { readonly: true });
    const rows = db.query('SELECT * FROM vault_note_deliveries').all() as any[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].slugs)).toEqual(['regel']);
    expect(JSON.stringify(rows)).not.toContain('GEHEIMER-TITEL');
    expect(JSON.stringify(rows)).not.toContain('Titel');
  });

  it('AK4 ohne Notizen oder bei Vault-Fehler wird nichts beansprucht', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    for (const body of ['exit 1', 'echo garbage']) {
      setVaultScript(body);
      expect(await at({})).toEqual(silent);
    }
    setVaultNotes([]);
    expect(await at({})).toEqual(silent);
    // Später entstandene Notiz liefert noch.
    setVaultNotes([note('regel')]);
    expect((await at({})).hookSpecificOutput!.additionalContext).toBe(VAULT_BLOCK);
  });

  it('AK4 zwei gleichzeitige Claims: genau einer gewinnt', async () => {
    process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');
    const r = await Promise.all([
      Promise.resolve().then(() => claimVaultNoteDelivery('s', '', '/a', ['x'])),
      Promise.resolve().then(() => claimVaultNoteDelivery('s', '', '/a', ['x'])),
    ]);
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  it('AK4 ohne sessionId liefert jedes Mal', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]);
    for (let i = 0; i < 2; i++) {
      expect((await at({ sessionId: undefined })).hookSpecificOutput!.additionalContext).toBe(VAULT_BLOCK);
    }
  });

  it('AK4 mehr als drei Notizen: zweiter Zugriff schweigt', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(['n1', 'n2', 'n3', 'n4', 'n5'].map(s => note(s)));
    expect((await at({})).hookSpecificOutput!.additionalContext).toContain('und 2 weitere');
    expect(await at({})).toEqual(silent);
  });
});

const REAL_CONTEXT = join(homedir(), '00_projects', 'vault', 'bin', 'context');
const blockOf = async (extra: Record<string, unknown> = {}) =>
  (await fileContextHandler.execute({
    sessionId: `s5-${Math.random()}`, cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile }, ...extra,
  } as any)).hookSpecificOutput?.additionalContext;

describe('fileContextHandler — AK3 Obergrenze und Rang', () => {
  it('AK3 fünf Notizen: genau drei Zeilen plus "und 2 weitere"', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(['n1', 'n2', 'n3', 'n4', 'n5'].map(s => note(s)));
    const lines = (await blockOf())!.split('\n');
    expect(lines.filter(l => l.startsWith('[['))).toHaveLength(3);
    expect(lines.filter(l => l.includes('[[n4]]') || l.includes('[[n5]]'))).toHaveLength(0);
    expect(lines.at(-1)).toBe('und 2 weitere');
    expect(lines).toHaveLength(5);
  });

  it('AK3 Reihenfolge des Vault-Ergebnisses bleibt erhalten (exakt vor Verzeichnis vor Wildcard)', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    // Slugs, created und verified laufen absichtlich gegen die Rangfolge:
    // eine Sortierung nach Slug, Datum oder verified würde die Ordnung ändern.
    setVaultNotes([
      note('zz-exakt', { match: 'exact', created: '2026-01-01', verified: '2026-01-01' }),
      note('mm-verzeichnis', { match: 'dir', created: '2026-06-01', verified: '2026-06-01' }),
      note('aa-wildcard', { match: 'wildcard', created: '2026-10-01', verified: '2026-10-01' }),
    ]);
    const lines = (await blockOf())!.split('\n');
    expect(lines.slice(1).map(l => l.match(/^\[\[([^\]]+)\]\]/)![1]))
      .toEqual(['zz-exakt', 'mm-verzeichnis', 'aa-wildcard']);
  });

  it('AK3 bei genau drei Notizen kein "und N weitere"', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(['n1', 'n2', 'n3'].map(s => note(s)));
    const ctx = (await blockOf())!;
    expect(ctx.split('\n')).toHaveLength(4);
    expect(ctx).not.toContain('weitere');
  });
});

/** Hash über alle Dateien samt relativem Pfad, sortiert. */
function treeHash(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { h.update(`D:${p}\0`); walk(p); }
      else h.update(`F:${p}\0`).update(readFileSync(p)).update('\0');
    }
  };
  walk(root);
  return h.digest('hex');
}

describe('fileContextHandler — AK5/AK6 mit Vault-Attrappe', () => {
  it('AK5 breite Notizen zählen nicht zur Obergrenze', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([
      note('b1', { broad_content: true }), note('b2', { broad_content: true }), note('b3', { broad_content: true }),
      note('e1'), note('e2'), note('e3'),
    ]);
    const ctx = (await blockOf())!;
    expect(ctx.split('\n')).toHaveLength(4);
    expect(ctx).not.toMatch(/\[\[b\d\]\]|weitere/);
  });

  it('AK6 Vault-Ordner vor und nach dem Lauf byte-identisch', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel')]); // Skript und notes.json liegen in tmpDir
    const vd = join(tmpDir, 'vault-attrappe');
    mkdirSync(join(vd, 'decisions'), { recursive: true });
    writeFileSync(join(vd, 'decisions', 'regel.md'), 'inhalt');
    process.env.VAULT_DIR = vd;
    try {
      const before = treeHash(vd);
      expect(await blockOf()).toContain('[[regel]]');
      expect(treeHash(vd)).toBe(before);
    } finally { delete process.env.VAULT_DIR; }
  });

  it('AK6 DB hat nach dem Lauf keinen Titel, nur vault_note_deliveries kommt hinzu', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('regel', { title: 'GEHEIMER-TITEL-4711' })]);
    expect(await blockOf()).toContain('GEHEIMER-TITEL-4711'); // Titel ging an den Agenten, nicht in die DB
    const db = new Database(join(tmpDir, 'data', 'claude-mem.db'), { readonly: true });
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as any[]).map(r => r.name).sort();
    let dump = '';
    for (const t of tables) dump += JSON.stringify(db.query(`SELECT * FROM "${t}"`).all());
    db.close();
    expect(tables).toEqual(['file_context_injections', 'vault_note_deliveries']); // vorher nur die Timeline-Tabelle
    expect(dump).toContain('regel');
    expect(dump).not.toContain('GEHEIMER-TITEL');
  });
});

describe('fileContextHandler — AK5/AK6 gegen den echten Vault-Befehl', () => {
  const real = it.skipIf(!existsSync(REAL_CONTEXT));
  let vaultDir: string;
  let prevVaultDir: string | undefined;
  const BODY = 'NOTIZ-RUMPF-GEHEIM-4711';

  const frontmatter = (title: string, extra = '') =>
    `---\ntitle: "${title}"\ncreated: 2026-10-01\nrepo: "${tmpDir}"\napplies_to: ["test.md"]\nverified: "2026-09-26"\n${extra}---\n\n# ${title}\n\n${BODY}\n`;

  function buildVault() {
    vaultDir = mkdtempSync(join(tmpdir(), 'file-context-vault-fake-vault-'));
    mkdirSync(join(vaultDir, 'decisions', 'archive'), { recursive: true });
    writeFileSync(join(vaultDir, 'decisions', 'aktiv.md'), frontmatter('Aktive Entscheidung'));
    writeFileSync(join(vaultDir, 'decisions', 'archive', 'alt.md'), frontmatter('Archivierte Entscheidung'));
    prevVaultDir = process.env.VAULT_DIR;
    process.env.VAULT_DIR = vaultDir;
    process.env.NORD_VAULT_CONTEXT_CMD = REAL_CONTEXT;
  }

  afterEach(() => {
    if (prevVaultDir === undefined) delete process.env.VAULT_DIR;
    else process.env.VAULT_DIR = prevVaultDir;
    if (vaultDir) try { rmSync(vaultDir, { recursive: true, force: true }); } catch {}
  });

  it('AK5 broad_content-Notiz fehlt im Block', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('breit', { broad_content: true }), note('eng'), note('breit2', { broad_content: true })]);
    const ctx = (await blockOf())!;
    expect(ctx).toContain('[[eng]]');
    expect(ctx).not.toContain('breit');
    expect(ctx).not.toContain('weitere');
  });

  it('AK5 nur breite Notizen: kein Block, nichts im Protokoll beansprucht', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('breit', { broad_content: true })]);
    expect(await fileContextHandler.execute({
      sessionId: 'ak5', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile },
    } as any)).toEqual({ continue: true, suppressOutput: true });
    const dbPath = join(tmpDir, 'data', 'claude-mem.db');
    if (existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.query('SELECT * FROM vault_note_deliveries').all();
      db.close();
      expect(rows).toHaveLength(0);
    }
    // Eine später deklarierte enge Notiz wird noch geliefert (nichts war beansprucht).
    setVaultNotes([note('eng')]);
    expect((await fileContextHandler.execute({
      sessionId: 'ak5', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile },
    } as any)).hookSpecificOutput!.additionalContext).toContain('[[eng]]');
  });

  real('AK5 Ende-zu-Ende: archive/ bleibt draußen, nur aktiv erscheint', async () => {
    buildVault();
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    const ctx = (await blockOf())!;
    expect(ctx).toContain('[[aktiv]] — Aktive Entscheidung (decision, verified 2026-09-26)');
    expect(ctx).not.toContain('alt');
    expect(ctx).not.toContain('Archivierte');
  });

  real('AK6 Vault vor und nach dem Handler-Lauf byte-identisch', async () => {
    buildVault();
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    const before = treeHash(vaultDir);
    const ctx = await blockOf();
    expect(ctx).toContain('[[aktiv]]'); // der Lauf hat wirklich etwas geliefert
    expect(treeHash(vaultDir)).toBe(before);
    // Gegenprobe: der Hash reagiert auf eine Änderung.
    writeFileSync(join(vaultDir, 'decisions', 'aktiv.md'), frontmatter('Aktive Entscheidung') + '\n');
    expect(treeHash(vaultDir)).not.toBe(before);
  });

  real('AK6 nord-mem-DB enthält weder Titel noch Text, nur vault_note_deliveries kommt hinzu', async () => {
    buildVault();
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    const dbPath = join(tmpDir, 'data', 'claude-mem.db');
    const tables = () => {
      const db = new Database(dbPath, { readonly: true });
      const t = (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as any[]).map(r => r.name).sort();
      db.close();
      return t;
    };
    // Vorher bestand nur die Timeline-Tabelle des Gates; die DB entsteht erst beim ersten Claim.
    const before = ['file_context_injections'];

    expect(await blockOf({ sessionId: 'ak6' })).toContain('[[aktiv]]');
    const after = tables();
    expect(after.filter(t => !before.includes(t))).toEqual(['vault_note_deliveries']);
    expect(after.sort()).toEqual([...before, 'vault_note_deliveries'].sort());

    const db = new Database(dbPath, { readonly: true });
    let dump = '';
    for (const t of after) dump += JSON.stringify(db.query(`SELECT * FROM "${t}"`).all());
    db.close();
    expect(dump).toContain('aktiv'); // Slug darf drin sein
    for (const secret of ['Aktive Entscheidung', 'Entscheidung', BODY]) expect(dump).not.toContain(secret);
  });
});

describe('fileContextHandler — AK7 verified ist Label, kein Filter', () => {
  it('AK7 verified-Datum erscheint in der Zeile', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('mit', { verified: '2026-09-26' })]);
    expect(await blockOf()).toContain('[[mit]] — Titel mit (decision, verified 2026-09-26)');
  });

  it('AK7 Notiz ohne verified wird geliefert und zeigt "verified —"', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([note('leer', { verified: '' })]);
    expect(await blockOf()).toContain('[[leer]] — Titel leer (decision, verified —)');
  });

  it('AK7 verified ändert die Reihenfolge nicht', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([
      note('a-leer', { verified: '' }),
      note('b-alt', { verified: '2020-01-01' }),
      note('c-neu', { verified: '2026-10-05' }),
    ]);
    const lines = (await blockOf())!.split('\n').slice(1);
    expect(lines.map(l => l.match(/^\[\[([^\]]+)\]\]/)![1])).toEqual(['a-leer', 'b-alt', 'c-neu']);
    expect(lines).toHaveLength(3);
  });
});
