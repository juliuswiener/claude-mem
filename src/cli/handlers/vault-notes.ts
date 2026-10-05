// Adapter: vault notes that govern a file (`bin/context --governing`).
// Every failure (missing command, timeout, bad JSON, no git repo, exit != 0)
// resolves to "no notes" — this module never throws and never blocks the gate.
// Only title/slug/type/verified are surfaced; no note content, nothing persisted.
import { spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

export const VAULT_NOTE_LIMIT = 3;
const VAULT_TIMEOUT_MS = 2_000;

export interface VaultNote {
  slug: string;
  title: string;
  type: string;
  verified: string;
  broad_content: boolean;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: sanitizeEnv(process.env),
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => resolve(null));
      child.on('close', code => resolve(code === 0 ? out : null));
    } catch {
      resolve(null);
    }
  });
}

export async function getGoverningVaultNotes(absoluteFile: string): Promise<VaultNote[]> {
  try {
    const deadline = Date.now() + VAULT_TIMEOUT_MS;
    const root = (await run('git', ['-C', path.dirname(absoluteFile), 'rev-parse', '--show-toplevel'], VAULT_TIMEOUT_MS))?.trim();
    if (!root) return [];
    const rel = path.relative(root, absoluteFile).split(path.sep).join('/');
    const cmd = process.env.NORD_VAULT_CONTEXT_CMD
      || path.join(process.env.VAULT_DIR || path.join(homedir(), '00_projects', 'vault'), 'bin', 'context');
    const out = await run(cmd, ['--governing', '--repo', root, rel], Math.max(1, deadline - Date.now()));
    if (!out) return [];
    const parsed = JSON.parse(out);
    const notes = Array.isArray(parsed) ? parsed[0]?.notes : null;
    if (!Array.isArray(notes)) return [];
    return notes.filter(n => n && typeof n.slug === 'string' && typeof n.title === 'string');
  } catch {
    return [];
  }
}

function narrowNotes(notes: VaultNote[]): VaultNote[] {
  const seen = new Set<string>();
  return notes.filter(n => {
    if (n.broad_content || seen.has(n.slug)) return false;
    seen.add(n.slug);
    return true;
  });
}

/** Slugs that formatVaultNotes actually shows (at most VAULT_NOTE_LIMIT). */
export function shownVaultSlugs(notes: VaultNote[]): string[] {
  return narrowNotes(notes).slice(0, VAULT_NOTE_LIMIT).map(n => n.slug);
}

/** Format notes as a text block, or null when nothing (non-broad) is left. */
export function formatVaultNotes(notes: VaultNote[]): string | null {
  const narrow = narrowNotes(notes);
  if (narrow.length === 0) return null;
  const lines = ['Vault-Notizen, die diese Datei regieren:'];
  for (const n of narrow.slice(0, VAULT_NOTE_LIMIT)) {
    lines.push(`[[${n.slug}]] — ${n.title} (${n.type}, verified ${n.verified || '—'})`);
  }
  if (narrow.length > VAULT_NOTE_LIMIT) lines.push(`und ${narrow.length - VAULT_NOTE_LIMIT} weitere`);
  return lines.join('\n');
}
