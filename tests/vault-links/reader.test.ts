import { it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { readObservations, normalizePath } from '../../src/services/vault-links/reader.js';

const sha = (p: string) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'k5a-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'x');
  writeFileSync(join(repo, 'README.md'), 'x');
  const dbPath = join(dir, 'claude-mem.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
    text TEXT, title TEXT, narrative TEXT, files_read TEXT, files_modified TEXT, created_at_epoch INTEGER NOT NULL, where_field TEXT, why TEXT)`);
  const ins = db.prepare('INSERT INTO observations (memory_session_id, project, title, files_read, files_modified, created_at_epoch, why) VALUES (?,?,?,?,?,?,?)');
  ins.run('s1', 'p', 't1', JSON.stringify([`${repo}/src/a.ts`, 'README.md']), JSON.stringify(['src/missing.ts']), 2_000_000_000_000, 'w');
  ins.run('s2', 'other', 't2', '[]', '[]', 2_000_000_000_000, null);
  return { dir, repo, dbPath, db };
}

it('K5A der Leser ändert die Datenbank nicht', () => {
  const { dbPath, repo, db } = fixture(); // db bleibt offen: das WAL existiert
  const tables = () => (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(r => r.name);
  const before = [sha(dbPath), sha(`${dbPath}-wal`), tables()];
  expect(before[1]).not.toBeNull();
  const rows = readObservations(dbPath, 'p', 0, repo);
  expect(rows.length).toBe(1);
  expect(rows[0].filesRead).toEqual(['src/a.ts']); // absolut -> relativ, .md und fehlende Dateien entfallen
  expect([sha(dbPath), sha(`${dbPath}-wal`), tables()]).toEqual(before);
  db.close();
});

it('K5A der Leser normalisiert Pfade', () => {
  const { repo } = fixture();
  expect(normalizePath(`${repo}/src/a.ts`, repo)).toBe('src/a.ts');
  expect(normalizePath('src/a.ts', repo)).toBe('src/a.ts');
  expect(normalizePath('.claude/worktrees/abc/src/a.ts', repo)).toBe('src/a.ts');
  expect(normalizePath('/x/y/.claude/worktrees/abc/src/a.ts', repo)).toBe('src/a.ts');
  expect(normalizePath('169_orch_tui/repo/src/a.ts', repo)).toBe('src/a.ts'); // nummeriertes Containerpräfix
  expect(normalizePath('README.md', repo)).toBeNull(); // Nicht-Code
  expect(normalizePath('node_modules/x/a.ts', repo)).toBeNull();
  expect(normalizePath('vault/x.ts', repo)).toBeNull();
  expect(normalizePath('/elsewhere/a.ts', repo)).toBeNull();
  expect(normalizePath('src/none.ts', repo)).toBeNull(); // existiert nicht
});
