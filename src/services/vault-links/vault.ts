// Declared files per note, taken from `bin/context --governing` (the vault does the matching; nothing is parsed here).
// Same pattern as src/cli/handlers/vault-notes.ts: child process with time limit, sanitizeEnv, every failure -> error text.
import { spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

export const VAULT_TIMEOUT_MS = 60_000;
const CHUNK = 200; // paths per call, keeps the argument list short

export interface DeclaredNote { slug: string; created: string; declared: string[] }

function run(cmd: string, args: string[]): Promise<{ out: string } | { error: string }> {
  return new Promise(resolve => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: VAULT_TIMEOUT_MS, killSignal: 'SIGKILL', env: sanitizeEnv(process.env) });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('error', e => resolve({ error: `Start fehlgeschlagen: ${e.message}` }));
      child.on('close', (code, sig) => resolve(code === 0 ? { out } : { error: `Exit ${code ?? sig}` }));
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
}

export async function fetchDeclared(repo: string, files: string[]): Promise<{ notes: DeclaredNote[]; error: string | null }> {
  const cmd = process.env.NORD_VAULT_CONTEXT_CMD || path.join(process.env.VAULT_DIR || path.join(homedir(), '00_projects', 'vault'), 'bin', 'context');
  const bySlug = new Map<string, DeclaredNote>();
  try {
    for (let i = 0; i < files.length; i += CHUNK) {
      const r = await run(cmd, ['--governing', '--repo', repo, ...files.slice(i, i + CHUNK)]);
      if ('error' in r) return { notes: [], error: `${cmd}: ${r.error}` };
      const parsed = JSON.parse(r.out);
      if (!Array.isArray(parsed)) return { notes: [], error: `${cmd}: Ausgabe ist kein Array` };
      for (const entry of parsed) {
        if (!entry || typeof entry.path !== 'string' || !Array.isArray(entry.notes)) continue;
        for (const n of entry.notes) {
          if (!n || typeof n.slug !== 'string' || n.broad_content === true) continue;
          const e: DeclaredNote = bySlug.get(n.slug) ?? { slug: n.slug, created: typeof n.created === 'string' ? n.created : '', declared: [] };
          if (!e.declared.includes(entry.path)) e.declared.push(entry.path);
          bySlug.set(n.slug, e);
        }
      }
    }
  } catch (e) {
    return { notes: [], error: `${cmd}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { notes: [...bySlug.values()], error: null };
}
