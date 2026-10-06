// Report: numbers (one object), rendered as JSON or Markdown from the same object.
import { recoveryMetrics, type NoteMetrics } from './metrics.js';
import { readObservations } from './reader.js';
import { scoreLinks, HALF_LIFE_DAYS, WINDOW_DAYS_BEFORE, type LinkObservation, type ScoredFile } from './score.js';
import { fetchDeclared, type DeclaredNote } from './vault.js';

const WORST_N = 10;
const BEST_N = 5;
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface ReportInput {
  project: string; repo: string; since: string; now: number;
  observations: LinkObservation[]; notes: DeclaredNote[]; vaultError?: string | null;
}
export interface Report {
  project: string; repo: string; since: string;
  touchedFiles: number; notesWithDeclared: number; evaluated: number; notEvaluated: number;
  meanYield10: number | null; meanHit3: number | null;
  daysWithoutObservations: string[];
  worst: NoteMetrics[]; best: NoteMetrics[];
  vaultError: string | null;
  constants: { halfLifeDays: number; windowDaysBefore: number };
}

export function buildReport(i: ReportInput): Report {
  const learned = scoreLinks(i.observations, i.notes, i.now);
  const learnedRec: Record<string, ScoredFile[]> = Object.fromEntries(learned);
  const declared = Object.fromEntries(i.notes.map(n => [n.slug, n.declared]));
  const m = recoveryMetrics(learnedRec, declared);
  const order = (a: NoteMetrics, b: NoteMetrics) => a.yield10 - b.yield10 || b.declared.length - a.declared.length || a.slug.localeCompare(b.slug);
  const have = new Set(i.observations.map(o => dayKey(new Date(o.epoch))));
  const gaps: string[] = [];
  const [y, mo, d] = i.since.split('-').map(Number);
  for (let day = new Date(y, mo - 1, d); day.getTime() <= i.now; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    if (!have.has(dayKey(day))) gaps.push(dayKey(day));
  }
  return {
    project: i.project, repo: i.repo, since: i.since,
    touchedFiles: new Set(i.observations.flatMap(o => [...o.filesRead, ...o.filesModified])).size,
    notesWithDeclared: i.notes.filter(n => n.declared.length > 0).length,
    evaluated: m.evaluated, notEvaluated: m.notEvaluated,
    meanYield10: m.meanYield10, meanHit3: m.meanHit3,
    daysWithoutObservations: gaps,
    worst: [...m.perNote].sort(order).slice(0, WORST_N),
    best: [...m.perNote].sort((a, b) => order(b, a) || a.slug.localeCompare(b.slug)).slice(0, BEST_N),
    vaultError: i.vaultError ?? null,
    constants: { halfLifeDays: HALF_LIFE_DAYS, windowDaysBefore: WINDOW_DAYS_BEFORE },
  };
}

export async function runReport(o: { dbPath: string; project: string; repo: string; since: string; now: number }): Promise<Report> {
  const [y, m, d] = o.since.split('-').map(Number);
  const observations = readObservations(o.dbPath, o.project, new Date(y, m - 1, d).getTime(), o.repo);
  const touched = [...new Set(observations.flatMap(x => [...x.filesRead, ...x.filesModified]))];
  const { notes, error } = await fetchDeclared(o.repo, touched);
  return buildReport({ project: o.project, repo: o.repo, since: o.since, now: o.now, observations, notes, vaultError: error });
}

export const renderJson = (r: Report) => JSON.stringify(r, null, 2);

const num = (x: number | null) => (x === null ? '—' : x.toFixed(3));

export function renderMarkdown(r: Report): string {
  const row = (n: NoteMetrics) => `| ${n.slug} | ${n.declared.join(', ')} | ${n.top3.join(', ')} | ${num(n.yield10)} |`;
  const table = (list: NoteMetrics[]) => ['| Notiz | erklärte Dateien | Top-3 gelernt | Ausbeute@10 |', '|---|---|---|---|', ...list.map(row)];
  const out = [`# Verknüpfungs-Messung: ${r.project} ab ${r.since}`, ''];
  if (r.vaultError) out.push(`**Fehler: Vault-Befehl gescheitert — ${r.vaultError}. Keine Notizen, keine Bewertung.**`, '');
  out.push(
    `- Berührte Dateien: ${r.touchedFiles}`,
    `- Notizen mit erklärten Dateien: ${r.notesWithDeclared}`,
    `- Bewertete Notizen: ${r.evaluated} (nicht bewertet: ${r.notEvaluated})`,
    `- Mittel Ausbeute@10: ${num(r.meanYield10)}`,
    `- Mittel Treffer@3: ${num(r.meanHit3)}`,
    `- Konstanten: Halbwertszeit ${r.constants.halfLifeDays} Tage, Entstehungsfenster ${r.constants.windowDaysBefore} Tag(e) davor`,
    '', `## Tage ohne Beobachtungen (${r.daysWithoutObservations.length})`, '',
    r.daysWithoutObservations.length ? r.daysWithoutObservations.join(', ') : 'keine',
    '', `## Die ${WORST_N} Notizen mit der schlechtesten Ausbeute`, '', ...table(r.worst),
    '', `## Die ${BEST_N} Notizen mit der besten Ausbeute`, '', ...table(r.best), '',
  );
  return out.join('\n');
}
