import { it, expect } from 'bun:test';
import { scoreLinks, type LinkObservation, type LinkNote } from '../../src/services/vault-links/score.js';

const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 9, 10);
const note: LinkNote = { slug: 'regel-x', created: '2026-09-10' };
let n = 0;
const obs = (session: string, epoch: number, o: Partial<LinkObservation> = {}): LinkObservation => ({
  id: ++n, session, project: 'p', epoch, filesRead: [], filesModified: [], ...o,
});
const score = (observations: LinkObservation[], now = NOW, nt = note) =>
  scoreLinks(observations, [nt], now).get(nt.slug) ?? [];
const of = (list: { file: string; score: number; sessions: number }[], file: string) => list.find(x => x.file === file);

it('K5A unabhängige Sitzungen zählen, nicht Observationen', () => {
  const one = score([obs('A', NOW, { filesModified: ['f.ts'] }), obs('A', NOW, { filesModified: ['f.ts'] }), obs('A', NOW, { filesModified: ['f.ts'] })]);
  expect(of(one, 'f.ts')).toEqual({ file: 'f.ts', score: 2, sessions: 1 });
  const two = score([obs('A', NOW, { filesModified: ['f.ts'] }), obs('B', NOW, { filesModified: ['f.ts'] })]);
  expect(of(two, 'f.ts')).toEqual({ file: 'f.ts', score: 4, sessions: 2 });
});

it('K5A Bearbeiten wiegt mehr als Lesen', () => {
  const l = score([obs('A', NOW, { filesModified: ['m.ts'] }), obs('B', NOW, { filesRead: ['r.ts'] })]);
  expect(of(l, 'm.ts')!.score).toBe(2);
  expect(of(l, 'r.ts')!.score).toBe(1);
  expect(l[0].file).toBe('m.ts'); // absteigend sortiert
  // bearbeitet und gelesen in derselben Observation: nur Bearbeiten zählt
  expect(of(score([obs('A', NOW, { filesModified: ['m.ts'], filesRead: ['m.ts'] })]), 'm.ts')!.score).toBe(2);
});

it('K5A eine Observation über viele Dateien trägt weniger je Datei', () => {
  const l = score([obs('A', NOW, { filesModified: ['a', 'b', 'c', 'd'] }), obs('B', NOW, { filesModified: ['solo'] })]);
  expect(of(l, 'a')!.score).toBeCloseTo(1, 10); // 2 / sqrt(4)
  expect(of(l, 'solo')!.score).toBe(2);
});

it('K5A ältere Belege wiegen weniger', () => {
  const o = obs('A', NOW - 60 * DAY, { filesModified: ['f.ts'] });
  const nt = { slug: 'alt', created: '2026-07-12' }; // Entstehungsfenster liegt im Alter der Beobachtung
  const old = score([{ ...o, epoch: at(2026, 7, 12) }], at(2026, 7, 12) + 60 * DAY, nt);
  expect(of(old, 'f.ts')!.score).toBeCloseTo(1, 6); // 2 * 0.5^(60/60)
  const fresh = score([{ ...o, epoch: at(2026, 7, 12) }], at(2026, 7, 12), nt);
  expect(of(fresh, 'f.ts')!.score).toBeCloseTo(2, 6);
});

it('K5A ein genannter Slug ist der stärkste Beleg', () => {
  // im Fenster und bearbeitet: Stufe a (3) schlägt Stufe b (2), keine Summe
  const l = score([obs('A', NOW, { filesModified: ['f.ts'], narrative: 'siehe [[regel-x]]' })]);
  expect(of(l, 'f.ts')!.score).toBe(3);
  // der Slug im Text von why, title genügt ebenfalls; Stufe a braucht kein Fenster
  const far = at(2026, 8, 1);
  const w = score([obs('B', far, { filesRead: ['g.ts'], why: 'folgt regel-x' }), obs('C', far, { filesRead: ['h.ts'], title: 'regel-x' })], far);
  expect(of(w, 'g.ts')!.score).toBe(3);
  expect(of(w, 'h.ts')!.score).toBe(3);
  // eine Observation ohne Slug außerhalb des Fensters liefert nichts
  expect(score([obs('D', far, { filesRead: ['i.ts'] })], far)).toEqual([]);
});

it('K5A Sitzungen außerhalb des Entstehungsfensters liefern keinen Beleg der Stufe b', () => {
  const f = (epoch: number) => score([obs('A', epoch, { filesModified: ['f.ts'] })], epoch);
  expect(of(f(at(2026, 9, 10, 1)), 'f.ts')!.score).toBe(2); // am Entstehungstag
  expect(of(f(at(2026, 9, 9, 23)), 'f.ts')!.score).toBe(2); // am Vortag
  expect(f(at(2026, 9, 8, 12))).toEqual([]); // vorletzter Tag
  expect(f(at(2026, 9, 11, 12))).toEqual([]); // Tag danach
});
