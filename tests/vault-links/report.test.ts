import { it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { recoveryMetrics } from '../../src/services/vault-links/metrics.js';
import { buildReport, renderMarkdown, renderJson, runReport } from '../../src/services/vault-links/report.js';
import type { LinkObservation } from '../../src/services/vault-links/score.js';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const ranked = (...files: string[]) => files.map((file, i) => ({ file, score: 100 - i, sessions: 1 }));

it('K5A Ausbeute und Treffer rechnen gegen eine von Hand berechnete Fixture', () => {
  const learned = {
    A: ranked('a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'),
    B: ranked('b1', 'b2', 'b3', 'b4'),
    C: ranked('c1'),
    D: [],
  };
  const declared = { A: ['a2', 'a11', 'x'], B: ['b4'], C: [], D: ['d1'] };
  const r = recoveryMetrics(learned, declared);
  // A: Top-10 = a1..a10, davon erklärt nur a2 (a11 ist Rang 11, x nie gelernt) -> 1/3; a2 ist Rang 2 -> Treffer@3 = 1
  // B: Top-10 = b1..b4, erklärt b4 -> 1/1; b4 ist Rang 4 -> Treffer@3 = 0
  // C: keine erklärte Datei, D: keine gelernte Datei -> nicht bewertet
  // Mittel: Ausbeute (1/3 + 1) / 2 = 2/3, Treffer (1 + 0) / 2 = 0.5
  const a = r.perNote.find(x => x.slug === 'A')!;
  const b = r.perNote.find(x => x.slug === 'B')!;
  expect(a.yield10).toBeCloseTo(1 / 3, 10);
  expect(a.hit3).toBe(1);
  expect(a.top3).toEqual(['a1', 'a2', 'a3']);
  expect(b.yield10).toBe(1);
  expect(b.hit3).toBe(0);
  expect(r.perNote.map(x => x.slug).sort()).toEqual(['A', 'B']);
  expect(r.evaluated).toBe(2);
  expect(r.notEvaluated).toBe(2);
  expect(r.meanYield10).toBeCloseTo(2 / 3, 10);
  expect(r.meanHit3).toBe(0.5);
});

const NOW = at(2026, 9, 10);
const OBS: LinkObservation[] = [
  { id: 1, session: 's1', project: 'p', epoch: at(2026, 9, 7), filesRead: [], filesModified: ['src/a.ts'] },
  { id: 2, session: 's2', project: 'p', epoch: at(2026, 9, 9), filesRead: ['src/b.ts'], filesModified: [] },
];
const NOTES = [{ slug: 'n1', created: '2026-09-09', declared: ['src/a.ts', 'src/b.ts'] }, { slug: 'n2', created: '2026-09-09', declared: ['src/zzz.ts'] }];

it('K5A der Bericht nennt Tage ohne Beobachtungen', () => {
  const r = buildReport({ project: 'p', repo: '/r', since: '2026-09-07', now: NOW, observations: OBS, notes: NOTES });
  expect(r.daysWithoutObservations).toEqual(['2026-09-08', '2026-09-10']);
  expect(renderMarkdown(r)).toContain('2026-09-08');
  expect(r.touchedFiles).toBe(2);
});

function fakeVault(dir: string, body: string) {
  const p = join(dir, 'fake-context.sh');
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'k5a-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'x');
  writeFileSync(join(repo, 'src', 'b.ts'), 'x');
  const db = new Database(join(dir, 'claude-mem.db'));
  db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT NOT NULL, project TEXT NOT NULL,
    text TEXT, title TEXT, narrative TEXT, files_read TEXT, files_modified TEXT, created_at_epoch INTEGER NOT NULL, where_field TEXT, why TEXT)`);
  const ins = db.prepare('INSERT INTO observations (memory_session_id, project, files_read, files_modified, created_at_epoch) VALUES (?,?,?,?,?)');
  ins.run('s1', 'p', '[]', JSON.stringify(['src/a.ts']), at(2026, 9, 9));
  ins.run('s2', 'p', JSON.stringify(['src/b.ts']), '[]', at(2026, 9, 9, 15));
  db.close();
  return { dir, repo, dbPath: join(dir, 'claude-mem.db') };
}

it('K5A Markdown und JSON tragen dieselben Zahlen', async () => {
  const { dir, repo, dbPath } = seed();
  const cmd = fakeVault(dir, `shift 3; printf '['; sep=''; for p in "$@"; do
  if [ "$p" = src/a.ts ]; then n='[{"slug":"n1","title":"T1","type":"decision","created":"2026-09-09","match":"exact","broad_content":false}]'; else n='[]'; fi
  printf '%s{"path":"%s","notes":%s}' "$sep" "$p" "$n"; sep=','; done; printf ']'`);
  const env = { ...process.env, NORD_VAULT_CONTEXT_CMD: cmd, CLAUDE_MEM_DATA_DIR: dir };
  const run = (extra: string[]) => Bun.spawnSync(['bun', 'scripts/vault-links.ts', '--project', 'p', '--repo', repo, '--since', '2026-09-08', ...extra], { env, cwd: join(import.meta.dir, '..', '..') });
  const md = run([]);
  const js = run(['--json']);
  expect(js.exitCode).toBe(0);
  expect(md.exitCode).toBe(0);
  const j = JSON.parse(js.stdout.toString());
  const m = md.stdout.toString();
  expect(j.touchedFiles).toBe(2);
  expect(j.notesWithDeclared).toBe(1);
  expect(j.evaluated).toBe(1);
  expect(j.meanYield10).toBe(1);
  expect(j.meanHit3).toBe(1);
  expect(j.worst[0].slug).toBe('n1');
  const fmt = (x: number) => x.toFixed(3);
  for (const s of [`${j.touchedFiles}`, `${j.notesWithDeclared}`, `${j.evaluated}`, fmt(j.meanYield10), fmt(j.meanHit3), 'n1', ...j.daysWithoutObservations]) expect(m).toContain(s);
  expect(j.daysWithoutObservations.length).toBeGreaterThan(0);
  // direkt: JSON des Berichts ist verlustfrei
  const r = buildReport({ project: 'p', repo: '/r', since: '2026-09-07', now: NOW, observations: OBS, notes: NOTES });
  expect(JSON.parse(renderJson(r))).toEqual(JSON.parse(JSON.stringify(r)));
  void dbPath;
});

it('K5A scheitert der Vault-Befehl, meldet der Bericht es und stürzt nicht ab', async () => {
  const { dir, repo, dbPath } = seed();
  const prev = process.env.NORD_VAULT_CONTEXT_CMD;
  try {
    for (const cmd of [join(dir, 'gibt-es-nicht'), fakeVault(dir, 'echo kaputt; exit 3'), fakeVault(dir, 'echo "nicht json"')]) {
      process.env.NORD_VAULT_CONTEXT_CMD = cmd;
      const r = await runReport({ dbPath, project: 'p', repo, since: '2026-09-08', now: NOW });
      expect(r.vaultError).toBeTruthy();
      expect(r.evaluated).toBe(0);
      expect(renderMarkdown(r)).toContain('Vault-Befehl');
    }
  } finally {
    if (prev === undefined) delete process.env.NORD_VAULT_CONTEXT_CMD;
    else process.env.NORD_VAULT_CONTEXT_CMD = prev;
  }
});
