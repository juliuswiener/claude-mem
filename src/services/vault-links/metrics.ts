// K3: how well learned files recover the declared (applies_to) files of a note.
import type { ScoredFile } from './score.js';

export const YIELD_AT = 10;
export const HIT_AT = 3;

export interface NoteMetrics { slug: string; declared: string[]; yield10: number; hit3: number; top3: string[] }
export interface RecoveryMetrics {
  perNote: NoteMetrics[]; // evaluated notes only
  evaluated: number;
  notEvaluated: number; // known notes without declared file or without learned file
  meanYield10: number | null;
  meanHit3: number | null;
}

export function recoveryMetrics(learned: Record<string, ScoredFile[]>, declared: Record<string, string[]>): RecoveryMetrics {
  const slugs = new Set([...Object.keys(learned), ...Object.keys(declared)]);
  const perNote: NoteMetrics[] = [];
  let notEvaluated = 0;
  for (const slug of slugs) {
    const decl = declared[slug] ?? [];
    const ranked = [...(learned[slug] ?? [])].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).map(x => x.file);
    if (decl.length === 0 || ranked.length === 0) { notEvaluated++; continue; }
    const set = new Set(decl);
    perNote.push({
      slug,
      declared: decl,
      yield10: ranked.slice(0, YIELD_AT).filter(f => set.has(f)).length / set.size,
      hit3: ranked.slice(0, HIT_AT).some(f => set.has(f)) ? 1 : 0,
      top3: ranked.slice(0, HIT_AT),
    });
  }
  const mean = (f: (n: NoteMetrics) => number) => (perNote.length ? perNote.reduce((s, n) => s + f(n), 0) / perNote.length : null);
  return { perNote, evaluated: perNote.length, notEvaluated, meanYield10: mean(n => n.yield10), meanHit3: mean(n => n.hit3) };
}
