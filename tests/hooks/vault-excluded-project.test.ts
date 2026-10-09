import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// Same mock/restore convention as vault-compaction.test.ts. The one difference:
// the project is EXCLUDED here. An excluded cwd gets no timeline, but still the
// broad notes (startup) and the compaction digest (compact) — nord-mem-ausschluss-
// schaltet-breite-notizen-und-digest-fuer-worker-ab. Pulling the exclusion check
// back in front of digest and overview turns every test here red.
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
  // Not reached for an excluded project; a non-empty answer makes a leak visible.
  executeWithWorkerFallback: () => Promise.resolve('TIMELINE'),
  isWorkerFallback: () => false,
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({ allProjects: ['test-project'] }),
  resolveHookProjectPath: (p: string) => p,
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => true,
}));

import { contextHandler } from '../../src/cli/handlers/context.js';
import { claimVaultNoteDelivery } from '../../src/cli/handlers/file-context-dedupe.js';
import { logger } from '../../src/utils/logger.js';

let tmpDir: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let prevDataDir: string | undefined;
let prevVaultCmd: string | undefined;

const note = (slug: string) => ({
  slug, title: `Titel ${slug}`, type: 'decision', verified: '2026-09-26', created: '2026-10-01',
  match: 'exact', broad_content: false, npatterns: 1,
  path: `/abs/decisions/${slug}.md`, section: 'Entschieden', text: `Text von ${slug}`,
});

/** Fake vault: `--broad` answers with one broad note; a.py is governed by one note. */
function setVault() {
  const broad = join(tmpDir, 'broad.json');
  const governing = join(tmpDir, 'governing.json');
  writeFileSync(broad, JSON.stringify({ repo: tmpDir, notes: [{ ...note('breit'), section: 'Kurzfassung' }] }));
  writeFileSync(governing, JSON.stringify([{ path: 'a.py', notes: [note('gilt')] }]));
  const script = join(tmpDir, 'fake-context');
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = --broad ]; then cat '${broad}'; else case "$4" in a.py) cat '${governing}';; *) echo "[]";; esac; fi\n`);
  chmodSync(script, 0o755);
  process.env.NORD_VAULT_CONTEXT_CMD = script;
}

const sessionStart = async (sessionSource: string) =>
  (await contextHandler.execute({ sessionId: 'main', cwd: tmpDir, platform: 'claude-code', sessionSource } as any))
    .hookSpecificOutput!.additionalContext;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-excluded-test-'));
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

describe('ausgeschlossenes Projekt — breite Notizen und Digest (AK2)', () => {
  it('startup: keine Zeitleiste, aber die breite Notiz', async () => {
    setVault();
    const ctx = await sessionStart('startup');
    expect(ctx).not.toContain('TIMELINE'); // der Ausschluss wirkt wirklich
    expect(ctx).toContain('Breite Vault-Notizen für ');
    expect(ctx).toContain('[[breit]]');
  });

  it('compact: keine Zeitleiste, aber der Digest-Kopf mit der gelieferten Notiz', async () => {
    setVault();
    claimVaultNoteDelivery('main', '', join(tmpDir, 'a.py'), ['gilt']);
    const ctx = await sessionStart('compact');
    expect(ctx).not.toContain('TIMELINE');
    expect(ctx).toContain('Vault-Notizen aus der bisherigen Arbeit');
    expect(ctx).toContain('[[gilt]]');
  });
});
