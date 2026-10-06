import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'fs';
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
import { logger } from '../../src/utils/logger.js';

let tmpDir: string;
let testFile: string;
let callLog: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let prevDataDir: string | undefined;
let prevVaultCmd: string | undefined;

/** Fake vault command that appends one line per invocation to callLog. */
function setCountingVault() {
  const json = join(tmpDir, 'notes.json');
  writeFileSync(json, JSON.stringify([{ path: 'test.md', notes: [{
    slug: 'regel', title: 'Titel regel', type: 'decision', verified: '', created: '2026-10-01',
    match: 'exact', broad_content: false, npatterns: 1,
  }] }]));
  const script = join(tmpDir, 'fake-context');
  writeFileSync(script, `#!/bin/sh\necho x >> '${callLog}'\ncat '${json}'\n`);
  chmodSync(script, 0o755);
  process.env.NORD_VAULT_CONTEXT_CMD = script;
}

function vaultCalls(): number {
  return existsSync(callLog) ? readFileSync(callLog, 'utf-8').split('\n').filter(Boolean).length : 0;
}

function touch(extra: Record<string, unknown> = {}) {
  return fileContextHandler.execute({
    sessionId: 'sess', cwd: tmpDir, toolName: 'Read', toolInput: { file_path: testFile }, ...extra,
  } as any);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-edit-sync-test-'));
  spawnSync('git', ['init', '-q', tmpDir]);
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, 'x'.repeat(2_000));
  callLog = join(tmpDir, 'calls.log');

  prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');
  prevVaultCmd = process.env.NORD_VAULT_CONTEXT_CMD;
  setCountingVault();

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

describe('AK11 vault hint before the edit', () => {
  it('AK11 Edit liefert die Notizen ohne permissionDecision', async () => {
    const out = (await touch({ toolName: 'Edit' })).hookSpecificOutput as any;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.additionalContext).toContain('[[regel]]');
    expect('permissionDecision' in out).toBe(false);
  });

  it('AK11 Write und MultiEdit ebenso ohne permissionDecision', async () => {
    for (const toolName of ['Write', 'MultiEdit']) {
      const out = (await touch({ toolName, sessionId: `s-${toolName}` })).hookSpecificOutput as any;
      expect(out.additionalContext).toContain('[[regel]]');
      expect('permissionDecision' in out).toBe(false);
    }
  });

  it('AK11 Read behält sein bisheriges Ergebnis', async () => {
    // AK12: Read is synchronous now, so it no longer carries permissionDecision either.
    const out = (await touch()).hookSpecificOutput as any;
    expect('permissionDecision' in out).toBe(false);
    expect(out.additionalContext).toContain('[[regel]]');
  });

  it('AK11 hooks.json: der Eintrag Edit|Write|MultiEdit hat kein async', () => {
    const entries = hooksJson().PreToolUse as any[];
    const edit = entries.find(e => e.matcher === 'Edit|Write|MultiEdit');
    const readEntry = entries.find(e => e.matcher === 'Read');
    expect(edit).toBeDefined();
    expect(readEntry).toBeDefined();
    expect('async' in edit.hooks[0]).toBe(false);
    expect(edit.hooks[0].timeout).toBe(15);
    // AK12: the Read entry is synchronous as well (see vault-read-sync.test.ts).
  });

  it('AK11 hooks.json: beide PreToolUse-Einträge rufen dasselbe file-context-Kommando', () => {
    const entries = hooksJson().PreToolUse as any[];
    expect(entries.length).toBe(2);
    const [a, b] = entries.map(e => e.hooks[0].command as string);
    expect(a).toContain('hook claude-code file-context');
    expect(a).toBe(b);
  });

  it('AK11 erste Berührung startet den Vault-Befehl genau einmal, die zweite nicht', async () => {
    const first = await touch({ toolName: 'Edit' });
    expect((first.hookSpecificOutput as any).additionalContext).toContain('[[regel]]');
    expect(vaultCalls()).toBe(1);
    const second = await touch({ toolName: 'Edit' });
    expect(second).toEqual({ continue: true, suppressOutput: true });
    expect(vaultCalls()).toBe(1);
  });

  it('AK11 der Vorabcheck gilt je Sitzung und Agent', async () => {
    await touch({ toolName: 'Edit' });
    expect(vaultCalls()).toBe(1);
    await touch({ toolName: 'Edit', sessionId: 'other-sess' });
    expect(vaultCalls()).toBe(2);
    await touch({ toolName: 'Edit', agentId: 'sub-1' });
    expect(vaultCalls()).toBe(3);
    await touch({ toolName: 'Edit', agentId: 'sub-1' });
    expect(vaultCalls()).toBe(3);
  });

  it('AK11 ohne sessionId fragt jede Berührung den Vault', async () => {
    await touch({ toolName: 'Edit', sessionId: undefined });
    await touch({ toolName: 'Edit', sessionId: undefined });
    expect(vaultCalls()).toBe(2);
  });
});
