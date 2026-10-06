import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, basename } from 'path';
import { spawnSync } from 'child_process';

// Same mock/restore convention as vault-compaction.test.ts: mock.module is
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
import { formatBroadNotes, VAULT_BROAD_MAX_CHARS } from '../../src/cli/handlers/vault-notes.js';
import { logger } from '../../src/utils/logger.js';

let tmpDir: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let prevDataDir: string | undefined;
let prevVaultCmd: string | undefined;
let prevVaultDir: string | undefined;

const broad = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, title: `Titel ${slug}`, type: 'decision', section: 'Kurzfassung', text: `Kurztext von ${slug}`,
  path: `/abs/decisions/${slug}.md`, created: '2026-10-01', verified: '2026-09-26', ...extra,
});

function setVaultScript(body: string) {
  const script = join(tmpDir, 'fake-context');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.NORD_VAULT_CONTEXT_CMD = script;
}

/** Fake vault: `--broad` answers with the notes; the log file records each call's argv. */
function setBroadVault(notes: unknown[]) {
  const json = join(tmpDir, 'broad.json');
  writeFileSync(json, JSON.stringify({ repo: tmpDir, notes }));
  setVaultScript(`echo "$@" >> '${join(tmpDir, 'calls.log')}'\nif [ "$1" = --broad ]; then cat '${json}'; else echo "[]"; fi`);
}

const sessionStart = async (sessionSource: string | undefined, cwd = tmpDir) =>
  (await contextHandler.execute({ sessionId: 'main', cwd, platform: 'claude-code', sessionSource } as any))
    .hookSpecificOutput!.additionalContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-overview-test-'));
  spawnSync('git', ['init', '-q', tmpDir]);
  prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');
  prevVaultCmd = process.env.NORD_VAULT_CONTEXT_CMD;
  prevVaultDir = process.env.VAULT_DIR;
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(s => s.mockRestore());
  if (prevDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = prevDataDir;
  if (prevVaultCmd === undefined) delete process.env.NORD_VAULT_CONTEXT_CMD;
  else process.env.NORD_VAULT_CONTEXT_CMD = prevVaultCmd;
  if (prevVaultDir === undefined) delete process.env.VAULT_DIR;
  else process.env.VAULT_DIR = prevVaultDir;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/utils/project-filter.js', () => realProjectFilterSnapshot);
});

describe('Vault-Überblick beim Sitzungsstart (OV2)', () => {
  it('OV2 startup liefert die breiten Notizen als Teil des additionalContext', async () => {
    setBroadVault([broad('alpha'), broad('beta', { type: 'audit', verified: '' })]);
    const ctx = await sessionStart('startup');
    expect(ctx.startsWith('TIMELINE\n\nBreite Vault-Notizen für ')).toBe(true);
    expect(ctx).toContain(`für ${basename(tmpDir)} (gelten für das ganze Repo; ganze Notiz: /abs/{decisions,architecture,audits,research}/<slug>.md):`);
    expect(ctx).toContain('[[alpha]] — Titel alpha (decision, verified 2026-09-26)\n    Kurztext von alpha');
    expect(ctx).toContain('[[beta]] — Titel beta (audit, verified —)');
    expect(ctx).not.toContain('Kurzfassung:');
    const call = spawnSync('cat', [join(tmpDir, 'calls.log')]).stdout.toString();
    expect(call).toContain(`--broad --repo ${spawnSync('git', ['-C', tmpDir, 'rev-parse', '--show-toplevel']).stdout.toString().trim()}`);
  });

  it('OV2 resume und clear liefern sie ebenso', async () => {
    setBroadVault([broad('alpha')]);
    for (const src of ['resume', 'clear']) {
      expect(await sessionStart(src)).toContain('[[alpha]] — Titel alpha');
    }
  });

  it('OV2 compact liefert den Überblick nicht, nur den Digest', async () => {
    setBroadVault([broad('alpha')]);
    expect(await sessionStart('compact')).toBe('TIMELINE');
    expect(await sessionStart(undefined)).toBe('TIMELINE');
    expect(existsSync(join(tmpDir, 'calls.log'))).toBe(false); // nicht einmal gefragt
  });

  it('OV2 der Block bleibt unter 1500 Zeichen', async () => {
    expect(VAULT_BROAD_MAX_CHARS).toBe(1500);
    const notes = Array.from({ length: 5 }, (_, i) => broad(`n${i}`, { text: 'x'.repeat(700) }));
    const ctx = await sessionStart('startup');
    expect(ctx).toBe('TIMELINE'); // noch kein Vault gesetzt: nichts angehängt
    setBroadVault(notes);
    const block = (await sessionStart('startup')).slice('TIMELINE\n\n'.length);
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block).toContain('[[n0]]'); // jüngste bleibt
    // Reihenfolge der Kürzung: erst Texte der letzten Notizen, dann Titelzeilen mit Zählung
    const many = Array.from({ length: 5 }, (_, i) => broad(`m${i}`, { title: 'T'.repeat(400) }));
    const out = formatBroadNotes(many as any)!;
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toMatch(/und \d+ weitere$/);
    // harte Kürzung mit Marker
    const huge = formatBroadNotes([broad('h', { repo: '/' + 'r'.repeat(3000) })] as any)!;
    expect(huge.length).toBeLessThanOrEqual(1500);
    expect(huge.endsWith('[… gekürzt]')).toBe(true);
  });

  it('OV2 der Text der letzten Notiz fällt zuerst weg, die Titelzeile bleibt', () => {
    const notes = [broad('a', { text: 'a'.repeat(600) }), broad('b', { text: 'b'.repeat(600) }), broad('c', { text: 'c'.repeat(600) })];
    const out = formatBroadNotes(notes as any)!;
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain('a'.repeat(600));
    expect(out).not.toContain('c'.repeat(600));
    expect(out).toContain('[[c]] — Titel c');
  });

  it('OV2 ein Vault-Fehler oder eine Zeitgrenzüberschreitung lässt den Kontext unverändert', async () => {
    setVaultScript('exit 3');
    expect(await sessionStart('startup')).toBe('TIMELINE');
    setVaultScript('echo "kein json"');
    expect(await sessionStart('startup')).toBe('TIMELINE');
    setVaultScript('echo \'{"notes": [{"slug": 5}]}\'');
    expect(await sessionStart('startup')).toBe('TIMELINE');
    process.env.NORD_VAULT_CONTEXT_CMD = join(tmpDir, 'gibt-es-nicht');
    expect(await sessionStart('startup')).toBe('TIMELINE');
    setVaultScript('exec sleep 20');
    const t0 = Date.now();
    expect(await sessionStart('startup')).toBe('TIMELINE');
    expect(Date.now() - t0).toBeLessThan(4500);
  }, 15_000);

  it('OV2 ohne breite Notizen entsteht kein Block', async () => {
    setBroadVault([]);
    expect(await sessionStart('startup')).toBe('TIMELINE');
    expect(formatBroadNotes([])).toBeNull();
  });

  it('OV2 außerhalb eines git-Repos entsteht kein Block', async () => {
    setBroadVault([broad('alpha')]);
    const plain = mkdtempSync('/dev/shm/ov2-nogit-');
    try {
      expect(await sessionStart('startup', plain)).toBe('TIMELINE');
      expect(existsSync(join(tmpDir, 'calls.log'))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('OV2 es wird nichts in der Datenbank gespeichert', async () => {
    setBroadVault([broad('alpha')]);
    await sessionStart('startup');
    await sessionStart('resume');
    expect(existsSync(join(tmpDir, 'data'))).toBe(false);
  });

  it('OV2 der Kopf nennt research im Ort, auch im Datei-Gate', async () => {
    expect(formatBroadNotes([broad('a')] as any)).toContain('{decisions,architecture,audits,research}/<slug>.md');
    // ohne path entfällt der Klammerzusatz bis auf die Repo-Angabe
    expect(formatBroadNotes([broad('a', { path: '' })] as any)).toContain('(gelten für das ganze Repo):');
    // Datei-Gate: dieselbe Konstante
    writeFileSync(join(tmpDir, 'f.ts'), 'x');
    const gate = join(tmpDir, 'gate.json');
    writeFileSync(gate, JSON.stringify([{ path: 'f.ts', notes: [{
      slug: 'g', title: 'G', type: 'decision', verified: '', broad_content: false,
      path: '/abs/decisions/g.md', section: 'Entschieden', text: 't' }] }]));
    setVaultScript(`cat '${gate}'`);
    const res = await fileContextHandler.execute({
      sessionId: 'gate', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: join(tmpDir, 'f.ts') }, platform: 'claude-code',
    } as any);
    const ctx = String(res.hookSpecificOutput?.additionalContext ?? '');
    expect(ctx).toContain('{decisions,architecture,audits,research}/<slug>.md');
  });

  it('OV2 Ende-zu-Ende mit einer Attrappe, die den Vertrag des echten bin/context nachbildet', async () => {
    // Läuft immer; der Test gegen den echten Befehl steht darunter.
    const repo = spawnSync('git', ['-C', tmpDir, 'rev-parse', '--show-toplevel']).stdout.toString().trim();
    setVaultScript(`[ "$1 $2 $3" = "--broad --repo ${repo}" ] || exit 1\necho '${JSON.stringify({ repo, notes: [broad('e2e', { path: '/v/architecture/e2e.md', type: 'architecture' })] })}'`);
    const ctx = await sessionStart('startup');
    expect(ctx).toContain('ganze Notiz: /v/{decisions,architecture,audits,research}/<slug>.md');
    expect(ctx).toContain('[[e2e]] — Titel e2e (architecture, verified 2026-09-26)');
  });

  const REAL = join(homedir(), '00_projects', 'vault', 'bin', 'context');
  it.skipIf(!existsSync(REAL))('OV2 Ende-zu-Ende gegen den echten bin/context mit Wegwerf-Vault und Wegwerf-Repo', async () => {
    const vault = join(tmpDir, 'vault');
    mkdirSync(join(vault, 'decisions'), { recursive: true });
    const repo = spawnSync('git', ['-C', tmpDir, 'rev-parse', '--show-toplevel']).stdout.toString().trim();
    writeFileSync(join(vault, 'decisions', 'breit-eins.md'),
      `---\ntitle: Breite Entscheidung\ntype: decision\ncreated: 2026-10-01\nverified: 2026-10-02\nrepo: ${repo}\nbroad_content: true\n---\n\n# Breite Entscheidung\n\n## Kurzfassung\n\nDas gilt fuer das ganze Repo.\n`);
    delete process.env.NORD_VAULT_CONTEXT_CMD;
    process.env.VAULT_DIR = vault;
    // bin/context liegt im echten Vault; VAULT_DIR zeigt auf den Wegwerf-Vault
    process.env.NORD_VAULT_CONTEXT_CMD = REAL;
    const ctx = await sessionStart('startup');
    expect(ctx).toContain('[[breit-eins]] — Breite Entscheidung (decision, verified 2026-10-02)');
    expect(ctx).toContain('    Das gilt fuer das ganze Repo.');
    expect(ctx).toContain(`${vault}/{decisions,architecture,audits,research}/<slug>.md`);
  }, 15_000);
});
