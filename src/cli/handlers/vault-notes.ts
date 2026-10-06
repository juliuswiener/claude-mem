// Adapter: vault notes that govern a file (`bin/context --governing`).
// Every failure (missing command, timeout, bad JSON, no git repo, exit != 0)
// resolves to "no notes" — this module never throws and never blocks the gate.
// Surfaced to the agent: title/slug/type/verified plus path and the section text
// the vault already cut (`path`, `section`, `text`). Nothing is persisted here.
import { spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

export const VAULT_NOTE_LIMIT = 3; // notes delivered with text
export const VAULT_LIST_LIMIT = 8; // further notes delivered as title lines
export const VAULT_BLOCK_MAX_CHARS = 9000;
const CUT_MARKER = '[… gekürzt]';
const VAULT_TIMEOUT_MS = 2_000;

export interface VaultNote {
  slug: string;
  title: string;
  type: string;
  verified: string;
  broad_content: boolean;
  path: string;
  section: string;
  text: string;
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
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return notes
      .filter(n => n && typeof n.slug === 'string' && typeof n.title === 'string')
      .map(n => ({ ...n, path: str(n.path), section: str(n.section), text: str(n.text) }));
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

const titleLine = (n: VaultNote) => `[[${n.slug}]] — ${n.title} (${n.type}, verified ${n.verified || '—'})`;

interface Rendered { text: string; slugs: string[] }

/** Builds the block under VAULT_BLOCK_MAX_CHARS; slugs = every note that stands in it. */
function render(notes: VaultNote[]): Rendered | null {
  const narrow = narrowNotes(notes);
  if (narrow.length === 0) return null;
  const head = narrow.slice(0, VAULT_NOTE_LIMIT);
  const texts = head.map(n => n.text);
  let list = narrow.slice(VAULT_NOTE_LIMIT, VAULT_NOTE_LIMIT + VAULT_LIST_LIMIT);
  const total = narrow.length;

  const build = () => {
    const lines = ['Vault-Notizen, die diese Datei regieren:'];
    head.forEach((n, i) => {
      lines.push(titleLine(n));
      if (n.path) lines.push(`  Pfad: ${n.path}`);
      if (texts[i]) {
        if (n.section) lines.push(`  ${n.section}:`);
        for (const l of texts[i].split('\n')) lines.push(`    ${l}`);
      }
    });
    if (list.length > 0) {
      lines.push('Weitere Notizen (nach Rang):');
      for (const n of list) lines.push(titleLine(n) + (n.path ? ` → ${n.path}` : ''));
    }
    const rest = total - head.length - list.length;
    if (rest > 0) lines.push(`und ${rest} weitere`);
    return lines.join('\n');
  };

  let out = build();
  // 1. texts: third, second, first note (title and path line stay).
  // The cut shrinks until the block fits; indent and marker add to the length, so one pass is not exact.
  for (let i = head.length - 1; i >= 0 && out.length > VAULT_BLOCK_MAX_CHARS; i--) {
    const full = texts[i];
    let keep = full.length;
    while (out.length > VAULT_BLOCK_MAX_CHARS && keep > 0) {
      keep = Math.max(0, keep - (out.length - VAULT_BLOCK_MAX_CHARS) - CUT_MARKER.length - 5);
      texts[i] = keep > 0 ? `${full.slice(0, keep)}\n${CUT_MARKER}` : '';
      out = build();
    }
  }
  // 2. title lines of the further notes, from the back (rest counts in "und N weitere")
  while (out.length > VAULT_BLOCK_MAX_CHARS && list.length > 0) {
    list = list.slice(0, -1);
    out = build();
  }
  const slugs = [...head, ...list].map(n => n.slug);
  // 3. last resort: hard cut
  if (out.length > VAULT_BLOCK_MAX_CHARS) out = out.slice(0, VAULT_BLOCK_MAX_CHARS - CUT_MARKER.length) + CUT_MARKER;
  return { text: out, slugs };
}

/** Slugs that formatVaultNotes actually shows (notes with text and title lines). */
export function shownVaultSlugs(notes: VaultNote[]): string[] {
  return render(notes)?.slugs ?? [];
}

/** Format notes as a text block, or null when nothing (non-broad) is left. */
export function formatVaultNotes(notes: VaultNote[]): string | null {
  return render(notes)?.text ?? null;
}
