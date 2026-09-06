import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveObservationProject } from '../src/services/worker/agents/ResponseProcessor.ts';

// resolveObservationProject fixes #attribution: a session's project used to be
// resolved once at session-init time and stamped on every observation for the
// rest of the session, even when a later tool call ran in a different repo's
// cwd. This exercises the fix against real git repos (getProjectContext shells
// out to `git rev-parse --show-toplevel`), not a mocked resolver.

let root: string;
let repoA: string;
let repoB: string;

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', dir]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-mem-attribution-'));
  repoA = join(root, 'repo-a');
  repoB = join(root, 'repo-b');
  initRepo(repoA);
  initRepo(repoB);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveObservationProject', () => {
  it('falls back to the session project when no claimed message has a cwd', () => {
    const project = resolveObservationProject(
      [{ type: 'observation', cwd: undefined }],
      'fallback-project'
    );
    expect(project).toBe('fallback-project');
  });

  it('resolves from a single claimed message\'s own tool cwd, not the session cwd', () => {
    const project = resolveObservationProject(
      [{ type: 'observation', cwd: repoA }],
      'stale-session-project'
    );
    expect(project).toBe('repo-a');
  });

  it('uses the most recent claimed message when tool cwd changed mid-batch', () => {
    const project = resolveObservationProject(
      [
        { type: 'observation', cwd: repoA },
        { type: 'observation', cwd: repoB },
      ],
      'fallback-project'
    );
    expect(project).toBe('repo-b');
  });

  it('skips non-observation messages (e.g. summarize) when scanning for a cwd', () => {
    const project = resolveObservationProject(
      [
        { type: 'observation', cwd: repoA },
        { type: 'summarize', cwd: repoB },
      ],
      'fallback-project'
    );
    expect(project).toBe('repo-a');
  });
});
