// Read-only access to the claude-mem database plus path normalisation. Never writes.
import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import path from 'path';
import type { LinkObservation } from './score.js';

const SKIP_EXT = /\.(md|txt|json|log|png|lock)$/;
const SKIP_DIRS = new Set(['.claude', 'node_modules', '.git', 'graphify-out', 'reports', 'berichte', 'sources', '__pycache__']);

/** Repo-relative path of an existing code file, or null. */
export function normalizePath(raw: string, repo: string): string | null {
  let f = raw.replace(/^(?:.*\/)?\.claude\/worktrees\/[^/]+\//, '');
  if (!existsSync(path.join(repo, f.split('/')[0]))) f = f.replace(/^\d+_[^/]+\/[^/]+\//, ''); // numbered container prefix
  if (f.startsWith(repo + '/')) f = f.slice(repo.length + 1);
  if (f.startsWith('(none') || f.startsWith('vault/') || f.startsWith('/') || f.startsWith('~')) return null;
  if (SKIP_EXT.test(f) || f.split('/').some(s => SKIP_DIRS.has(s))) return null;
  return existsSync(path.join(repo, f)) ? f : null;
}

function files(json: string | null, repo: string): string[] {
  try {
    const arr = JSON.parse(json || '[]');
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.filter((x): x is string => typeof x === 'string').map(x => normalizePath(x, repo)).filter((x): x is string => x !== null))];
  } catch {
    return [];
  }
}

interface Row { id: number; memory_session_id: string; project: string; created_at_epoch: number; files_read: string | null; files_modified: string | null; title: string | null; why: string | null; narrative: string | null }

export function readObservations(dbPath: string, project: string, sinceEpochMs: number, repo: string): LinkObservation[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(
      'SELECT id, memory_session_id, project, created_at_epoch, files_read, files_modified, title, why, narrative FROM observations WHERE project = ? AND created_at_epoch >= ? ORDER BY created_at_epoch',
    ).all(project, sinceEpochMs) as Row[];
    return rows.map(r => ({
      id: r.id,
      session: r.memory_session_id,
      project: r.project,
      epoch: r.created_at_epoch,
      filesRead: files(r.files_read, repo),
      filesModified: files(r.files_modified, repo),
      title: r.title ?? undefined,
      why: r.why ?? undefined,
      narrative: r.narrative ?? undefined,
    }));
  } finally {
    db.close();
  }
}
