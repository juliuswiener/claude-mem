import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// Same mock/restore convention as vault-edit-sync.test.ts, plus a switchable
// executeWithWorkerFallback (the timeline path) so a hanging worker can be faked.
import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realProjectFilter from '../../src/utils/project-filter.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realProjectNameSnapshot = { ...realProjectName };
const realProjectFilterSnapshot = { ...realProjectFilter };

let workerMode: 'observations' | 'hang' = 'observations';

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
  workerHttpRequest: () => Promise.reject(new Error('unused')),
  isWorkerFallback: () => false,
  executeWithWorkerFallback: () =>
    workerMode === 'hang'
      ? new Promise(() => {}) // never resolves
      : Promise.resolve({
          observations: [{
            id: 1, memory_session_id: 'session-1', title: 'Observation 1', type: 'discovery',
            created_at_epoch: Date.now() + 60_000, files_read: '[]', files_modified: JSON.stringify(['test.md']),
          }],
          count: 1,
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
import { logger } from '../../src/utils/logger.js';

let tmpDir: string;
let testFile: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let prevDataDir: string | undefined;
let prevVaultCmd: string | undefined;

function setVaultScript(body: string) {
  const script = join(tmpDir, 'fake-context');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.NORD_VAULT_CONTEXT_CMD = script;
}

function setVaultNotes() {
  const json = join(tmpDir, 'notes.json');
  writeFileSync(json, JSON.stringify([{ path: 'test.md', notes: [{
    slug: 'regel', title: 'Titel regel', type: 'decision', verified: '', created: '2026-10-01',
    match: 'exact', broad_content: false, npatterns: 1,
  }] }]));
  setVaultScript(`cat '${json}'`);
}

function touch(extra: Record<string, unknown> = {}) {
  return fileContextHandler.execute({
    sessionId: `sess-${Math.random()}`, cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile }, ...extra,
  } as any);
}

/** The test itself aborts with an error after ms, so a hanging handler cannot hang the suite. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ value: T; elapsed: number }> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`test abort after ${ms} ms: handler hangs`)), ms); });
  try {
    const value = await Promise.race([p, guard]);
    return { value, elapsed: Date.now() - t0 };
  } finally {
    clearTimeout(timer!);
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-read-sync-test-'));
  spawnSync('git', ['init', '-q', tmpDir]);
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, 'x'.repeat(2_000));
  workerMode = 'observations';

  prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');
  prevVaultCmd = process.env.NORD_VAULT_CONTEXT_CMD;
  setVaultNotes();

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
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/utils/project-filter.js', () => realProjectFilterSnapshot);
});

const hooksJson = () =>
  JSON.parse(readFileSync(new URL('../../plugin/hooks/hooks.json', import.meta.url), 'utf-8')).hooks;

describe('AK12 vault hint reaches the model at Read', () => {
  it('AK12 hooks.json: der Read-Eintrag hat kein async', () => {
    const readEntry = (hooksJson().PreToolUse as any[]).find(e => e.matcher === 'Read');
    expect(readEntry).toBeDefined();
    expect('async' in readEntry.hooks[0]).toBe(false);
  });

  it('AK12 hooks.json: Read- und Edit-Eintrag sind synchron und rufen dasselbe file-context-Kommando', () => {
    const entries = hooksJson().PreToolUse as any[];
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect('async' in e.hooks[0]).toBe(false);
      expect(e.hooks[0].timeout).toBeLessThanOrEqual(15);
    }
    const [a, b] = entries.map(e => e.hooks[0].command as string);
    expect(a).toContain('hook claude-code file-context');
    expect(a).toBe(b);
  });

  it('AK12 Read liefert die Notizen ohne permissionDecision', async () => {
    const out = (await touch()).hookSpecificOutput as any;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.additionalContext).toContain('[[regel]]');
    expect('permissionDecision' in out).toBe(false);
  });

  it('AK12 Read liefert die Timeline weiter wie bisher', async () => {
    const out = (await touch()).hookSpecificOutput as any;
    expect(Object.keys(out).sort()).toEqual(['additionalContext', 'hookEventName']);
    expect(out.additionalContext).toContain('prior observations');
    expect(out.additionalContext).toContain('Observation 1');
    expect(out.additionalContext).toContain('Vault-Notizen, die diese Datei regieren:');
    expect(out.additionalContext.indexOf('prior observations'))
      .toBeLessThan(out.additionalContext.indexOf('Vault-Notizen'));
  });

  it('AK12 hängender Vault-Befehl: Read kehrt innerhalb der Grenze zurück', async () => {
    setVaultScript('sleep 30'); // no exec: the child keeps the pipe open past the adapter's kill
    writeFileSync(testFile, 'klein'); // < 1500 bytes: no timeline, so "no notes" means silent
    const { value, elapsed } = await within(touch(), 8_000);
    expect(elapsed).toBeLessThan(6_000);
    expect(value).toEqual({ continue: true, suppressOutput: true });
  }, 12_000);

  it('AK12 hängender Worker: Read kehrt innerhalb der Grenze zurück und liefert den Vault-Block', async () => {
    workerMode = 'hang';
    const { value, elapsed } = await within(touch(), 8_000);
    expect(elapsed).toBeLessThan(6_000);
    const out = value.hookSpecificOutput as any;
    expect(out.additionalContext).toContain('[[regel]]');
    expect(out.additionalContext).not.toContain('prior observations');
    expect('permissionDecision' in out).toBe(false);
  }, 12_000);

  it('AK12 Edit bleibt wie in AK11', async () => {
    workerMode = 'hang'; // Edit never asks the worker
    for (const toolName of ['Edit', 'Write', 'MultiEdit']) {
      const out = (await touch({ toolName })).hookSpecificOutput as any;
      expect(out.additionalContext).toBe('Vault-Notizen, die diese Datei regieren:\n[[regel]] — Titel regel (decision, verified —)');
      expect('permissionDecision' in out).toBe(false);
    }
  });
});
