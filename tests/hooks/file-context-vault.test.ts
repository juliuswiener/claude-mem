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
    // AK11: no permissionDecision at all for edit tools (user's prompt stays in force).
    expect((r.hookSpecificOutput as any)?.permissionDecision).toBeUndefined();
    // AK12: nor for Read (the hook is synchronous, 'allow' would override the prompt).
    const rd = await run({});
    expect((rd.hookSpecificOutput as any)?.permissionDecision).toBeUndefined();
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
    // AK11: split into two entries (Read, Edit|Write|MultiEdit; both sync since AK12); together they cover all four.
    const matchers = hooks.PreToolUse
      .filter((m: any) => m.hooks.some((h: any) => h.command.includes('hook claude-code file-context')))
      .flatMap((m: any) => m.matcher.split('|'));
    expect(matchers.sort()).toEqual(['Edit', 'MultiEdit', 'Read', 'Write']);
  });
});

describe('fileContextHandler — vault notes in the gate', () => {
  it('(a) one additionalContext with timeline AND vault block', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(observations());
    setVaultNotes([note('regel-a', { verified: '2026-10-02' })]);

    const out = (await read()).hookSpecificOutput!;
    expect(out.permissionDecision).toBeUndefined(); // AK12
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
    expect(out.permissionDecision).toBeUndefined(); // AK12
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

  it('(e) five notes: three notes plus two title lines under "Weitere Notizen"', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(['n1', 'n2', 'n3', 'n4', 'n5'].map(s => note(s)));

    const lines = (await read()).hookSpecificOutput!.additionalContext!.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toContain('[[n1]]');
    expect(lines[3]).toContain('[[n3]]');
    expect(lines[4]).toBe('Weitere Notizen (nach Rang):');
    expect(lines[6]).toContain('[[n5]]');
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
    // AK13: dieselbe Notiz, zweite Datei: Titelzeile mit Zusatz statt Text.
    expect((await at({}, other)).hookSpecificOutput!.additionalContext).toBe(`${VAULT_BLOCK} — Text schon geliefert`);
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

  it('AK4 mehr als elf Notizen: zweiter Zugriff schweigt', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(Array.from({ length: 13 }, (_, i) => note(`n${i + 1}`)));
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
  it('AK3 dreizehn Notizen: drei Notizen, acht Titelzeilen plus "und 2 weitere"', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(Array.from({ length: 13 }, (_, i) => note(`n${i + 1}`)));
    const lines = (await blockOf())!.split('\n');
    expect(lines.filter(l => l.startsWith('[['))).toHaveLength(11);
    expect(lines.filter(l => l.includes('[[n12]]') || l.includes('[[n13]]'))).toHaveLength(0);
    expect(lines.at(-1)).toBe('und 2 weitere');
    expect(lines).toHaveLength(14); // Kopf + 3 + Überschrift + 8 + Rest
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
    expect(tables).toEqual(['file_context_injections', 'vault_note_deliveries', 'vault_note_texts']); // vorher nur die Timeline-Tabelle
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
    expect(after.filter(t => !before.includes(t)).sort()).toEqual(['vault_note_deliveries', 'vault_note_texts']);
    expect(after.sort()).toEqual([...before, 'vault_note_deliveries', 'vault_note_texts'].sort());

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

const rich = (slug: string, extra: Record<string, unknown> = {}) =>
  note(slug, { path: `/abs/decisions/${slug}.md`, section: 'Entschieden', text: `Text von ${slug}`, ...extra });
/** Pfad einer Notiz, wie ihn der Agent aus Kopfzeile und Slug bildet (Ordner decisions). */
const builtPath = (ctx: string, slug: string) =>
  ctx.split('\n')[0].match(/ganze Notiz: (.+)\/\{decisions,architecture,audits,research\}\/<slug>\.md/)![1] + `/decisions/${slug}.md`;
const MARK = (p: string) => `[… gekürzt, ganze Notiz: ${p}]`;

describe('fileContextHandler — AK9 Notiztext im Gate', () => {
  const plain = (n: number, from = 1) => Array.from({ length: n }, (_, i) => rich(`w${from + i}`, { text: '' }));
  const ctxOf = async (notes: unknown[], extra: Record<string, unknown> = {}) => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes(notes);
    return (await blockOf(extra))!;
  };

  it('AK9 die ersten drei Notizen tragen Entschieden-Text, der Pfad steht im Kopf', async () => {
    const ctx = await ctxOf([
      rich('a', { text: 'Zeile eins\nZeile zwei' }), rich('b'), rich('c'), rich('d'),
    ]);
    expect(ctx.startsWith(
      'Vault-Notizen, die diese Datei regieren (ganze Notiz: /abs/{decisions,architecture,audits,research}/<slug>.md):\n' +
      '[[a]] — Titel a (decision, verified —)\n  Entschieden:\n    Zeile eins\n    Zeile zwei\n' +
      '[[b]] — Titel b (decision, verified —)\n  Entschieden:\n    Text von b\n' +
      '[[c]] — Titel c (decision, verified —)\n  Entschieden:\n    Text von c\n' +
      'Weitere Notizen (nach Rang):\n[[d]] — Titel d (decision, verified —)')).toBe(true);
    expect(ctx).not.toContain('Text von d');
  });

  it('AK9 Fallback Worum es geht wird als solcher überschrieben', async () => {
    const ctx = await ctxOf([rich('a', { section: 'Worum es geht', text: 'Kurzfassung' })]);
    expect(ctx).toContain('  Worum es geht:\n    Kurzfassung');
    expect(ctx).not.toContain('Entschieden:');
  });

  it('AK9 Notiz ohne Text bleibt Titelzeile', async () => {
    const ctx = await ctxOf([rich('a', { section: '', text: '' })]);
    expect(ctx).toBe('Vault-Notizen, die diese Datei regieren (ganze Notiz: /abs/{decisions,architecture,audits,research}/<slug>.md):\n' + '[[a]] — Titel a (decision, verified —)');
  });

  it('AK9 fehlende Felder path/section/text sind leer, kein Fehler', async () => {
    expect(await ctxOf([note('a')])).toBe(VAULT_BLOCK.replaceAll('regel', 'a'));
  });

  it('AK9 weitere Notizen erscheinen als Titelzeilen bis 8, danach und N weitere', async () => {
    const ctx = await ctxOf([rich('a'), rich('b'), rich('c'), ...plain(10, 4)]);
    const lines = ctx.split('\n');
    const at = lines.indexOf('Weitere Notizen (nach Rang):');
    expect(lines.slice(at + 1, -1)).toEqual(
      Array.from({ length: 8 }, (_, i) => `[[w${i + 4}]] — Titel w${i + 4} (decision, verified —)`));
    expect(lines.at(-1)).toBe('und 2 weitere');
    expect(ctx).not.toContain('[[w12]]');
  });

  it('AK9 genau elf Notizen: kein und N weitere; drei: kein Block Weitere Notizen', async () => {
    expect(await ctxOf([rich('a'), rich('b'), rich('c'), ...plain(8, 4)])).not.toContain('weitere');
    fetchSpy!.mockRestore();
    expect(await ctxOf([rich('a'), rich('b'), rich('c')])).not.toContain('Weitere');
  });

  it('AK9 Gesamttext überschreitet nie 9000 Zeichen: zuerst dritte, dann zweite, dann erste Notiz', async () => {
    const big = (c: string, n: number) => c.repeat(n);
    // 3 x 6000 + 12 weitere: dritter Text fällt ganz, zweiter wird gekürzt, erster bleibt.
    let ctx = await ctxOf([
      rich('a', { text: big('A', 6000) }), rich('b', { text: big('B', 6000) }), rich('c', { text: big('C', 6000) }),
      ...plain(12, 4),
    ]);
    expect(ctx.length).toBeLessThanOrEqual(9000);
    expect(ctx).toContain(big('A', 6000));
    expect(ctx).not.toContain('C');                               // dritter Text ganz weg ...
    expect(ctx).toContain('[[c]] — Titel c (decision, verified —)'); // ... die Titelzeile bleibt
    expect(ctx.match(/B/g)!.length).toBeGreaterThan(0);
    expect(ctx.match(/B/g)!.length).toBeLessThan(6000);           // zweiter nur gekürzt
    expect(ctx).toContain('[[w11]]');                             // alle acht Titelzeilen bleiben
    expect(ctx).toContain('und 4 weitere');
    fetchSpy!.mockRestore();

    // Nur die dritte Notiz überschreitet: erste und zweite bleiben ganz.
    ctx = await ctxOf([
      rich('a', { text: big('A', 3000) }), rich('b', { text: big('B', 3000) }), rich('c', { text: big('C', 4000) }),
    ]);
    expect(ctx.length).toBeLessThanOrEqual(9000);
    expect(ctx).toContain(big('A', 3000));
    expect(ctx).toContain(big('B', 3000));
    expect(ctx).not.toContain(big('C', 4000));
    expect(ctx).toContain('C');
    fetchSpy!.mockRestore();

    // Der erste Text allein ist zu groß: zweiter und dritter fallen, der erste wird gekürzt.
    ctx = await ctxOf([
      rich('a', { text: big('A', 20000) }), rich('b', { text: big('B', 500) }), rich('c', { text: big('C', 500) }),
      ...plain(8, 4),
    ]);
    expect(ctx.length).toBeLessThanOrEqual(9000);
    expect(ctx).not.toContain('B');
    expect(ctx).not.toContain('C');
    expect(ctx).toContain('[[b]] — Titel b (decision, verified —)');
    expect(ctx.match(/A/g)!.length).toBeGreaterThan(1000);
    expect(ctx).toContain('[[w11]]');
    fetchSpy!.mockRestore();

    // Titelzeilen sind das Letzte: lange Titel, kein Text. Zeilen fallen von hinten, Rest zählt in "und N weitere".
    const longTitle = 'T'.repeat(1500);
    ctx = await ctxOf([
      rich('a', { text: big('A', 1000) }), rich('b'), rich('c'),
      ...Array.from({ length: 12 }, (_, i) => rich(`w${i + 4}`, { title: longTitle, text: '' })),
    ]);
    expect(ctx.length).toBeLessThanOrEqual(9000);
    expect(ctx).not.toContain('Entschieden:');                    // Texte zuerst weg
    expect(ctx).toContain('[[w4]]');
    expect(ctx).not.toContain('[[w11]]');                         // hinten fallen Titelzeilen
    const shown = ctx.split('\n').filter(l => /^\[\[w\d+\]\]/.test(l)).length;
    expect(ctx.split('\n').at(-1)).toBe(`und ${12 - shown} weitere`);
    expect(shown).toBeLessThan(8);
  });

  it('AK9 harte Kürzung mit Marker, wenn die Titelzeilen allein zu lang sind', async () => {
    const ctx = await ctxOf([rich('a', { title: 'T'.repeat(12000), text: '' }), rich('b')]);
    expect(ctx.length).toBeLessThanOrEqual(9000);
    expect(ctx).toContain('[… gekürzt');
  });

  it('AK9 Kürzungsmarker des Vaults bleibt erhalten', async () => {
    const text = `Anfang\n${MARK('/abs/a.md')}`;
    const ctx = await ctxOf([rich('a', { text })]);
    expect(ctx).toContain(`    Anfang\n    ${MARK('/abs/a.md')}`);
  });

  it('AK9 Attrappe: der aus Kopf und Slug gebildete Pfad existiert und Text steht im Block', async () => {
    mkdirSync(join(tmpDir, 'decisions'), { recursive: true });
    writeFileSync(join(tmpDir, 'decisions', 'a.md'), '# Notiz\n');
    const ctx = await ctxOf([rich('a', { path: join(tmpDir, 'decisions', 'a.md'), text: 'ATTRAPPEN-TEXT' })]);
    expect(existsSync(builtPath(ctx, 'a'))).toBe(true);
    expect(ctx).toContain('    ATTRAPPEN-TEXT');
  });

  it('AK9 Protokoll speichert nur Slugs, keinen Text und keinen Pfad', async () => {
    const notes = [rich('a', { text: 'GEHEIMER-TEXT-9' }), rich('b'), rich('c'), ...plain(10, 4)];
    await ctxOf(notes);
    const db = new Database(join(tmpDir, 'data', 'claude-mem.db'), { readonly: true });
    const rows = db.query('SELECT * FROM vault_note_deliveries').all() as any[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].slugs)).toEqual(['a', 'b', 'c', ...Array.from({ length: 8 }, (_, i) => `w${i + 4}`)]);
    const dump = JSON.stringify(rows);
    for (const secret of ['GEHEIMER-TEXT-9', '/abs', 'Titel', 'Entschieden']) expect(dump).not.toContain(secret);
  });

  it('AK9 zweiter Zugriff schweigt weiter', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
    setVaultNotes([rich('a')]);
    const at = () => fileContextHandler.execute({
      sessionId: 'ak9', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile },
    } as any);
    expect((await at()).hookSpecificOutput!.additionalContext).toContain('[[a]] — Titel a');
    expect(await at()).toEqual({ continue: true, suppressOutput: true });
  });

  it('AK9 Edit liefert dieselbe Form wie Read', async () => {
    const notes = [rich('a'), rich('b'), ...plain(4, 3)];
    const viaRead = await ctxOf(notes);
    fetchSpy!.mockRestore();
    const viaEdit = await ctxOf(notes, { toolName: 'Edit' });
    expect(viaEdit).toBe(viaRead);
    expect(viaEdit).toContain('[[a]] — Titel a (decision, verified —)\n  Entschieden:\n    Text von a');
    const r = await fileContextHandler.execute({
      sessionId: 'x', cwd: tmpDir, toolName: 'Edit', toolInput: { file_path: testFile },
    } as any);
    expect((r.hookSpecificOutput as any).permissionDecision).not.toBe('deny');
  });

  const realE2E = it.skipIf(!existsSync(REAL_CONTEXT));
  realE2E('AK9 Ende-zu-Ende gegen den echten bin/context: der aus Kopf und Slug gebildete Pfad existiert und Text steht im Block', async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'file-context-vault-fake-vault-'));
    const prevVaultDir = process.env.VAULT_DIR;
    try {
      mkdirSync(join(vaultDir, 'decisions'), { recursive: true });
      writeFileSync(join(vaultDir, 'decisions', 'aktiv.md'),
        `---\ntitle: "Aktive Entscheidung"\ncreated: 2026-10-01\nrepo: "${tmpDir}"\napplies_to: ["test.md"]\nverified: "2026-09-26"\n---\n\n# Aktive Entscheidung\n\n## Entschieden\n\nE2E-ENTSCHEIDUNGSTEXT-4711\n`);
      process.env.VAULT_DIR = vaultDir;
      process.env.NORD_VAULT_CONTEXT_CMD = REAL_CONTEXT;
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(noObservations());
      const ctx = (await blockOf())!;
      expect(existsSync(builtPath(ctx, 'aktiv'))).toBe(true);
      expect(ctx).toContain('E2E-ENTSCHEIDUNGSTEXT-4711');
    } finally {
      if (prevVaultDir === undefined) delete process.env.VAULT_DIR; else process.env.VAULT_DIR = prevVaultDir;
      try { rmSync(vaultDir, { recursive: true, force: true }); } catch {}
    }
  });
});
