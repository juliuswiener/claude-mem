// K1: pure scoring of (note, file) pairs from observations. No I/O.
// Value = sum over independent sessions of the strongest evidence of that session, damped and aged.

export interface LinkObservation {
  id: number;
  session: string; // memory_session_id: independent sessions are distinct values
  project: string;
  epoch: number; // ms
  filesRead: string[];
  filesModified: string[];
  title?: string;
  why?: string;
  narrative?: string;
}

export interface LinkNote { slug: string; created: string } // created: YYYY-MM-DD
export interface ScoredFile { file: string; score: number; sessions: number }

export const SLUG_WEIGHT = 3; // (a) observation names the slug or [[slug]]
export const EDIT_WEIGHT = 2; // (b) file modified in a session inside the creation window
export const READ_WEIGHT = 1; // (b) file only read in such a session
export const WINDOW_DAYS_BEFORE = 1; // creation window: day of `created` plus this many days before (local calendar days)
export const HALF_LIFE_DAYS = 60;

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ponytail: the window is per session over all passed observations (one project by contract); a session
// spanning days counts as a whole once any of its observations falls in the window.
function windowDays(created: string): Set<string> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(created);
  if (!m) return new Set();
  const days = new Set<string>();
  for (let k = 0; k <= WINDOW_DAYS_BEFORE; k++) days.add(dayKey(new Date(+m[1], +m[2] - 1, +m[3] - k)));
  return days;
}

export function scoreLinks(observations: LinkObservation[], notes: LinkNote[], now: number): Map<string, ScoredFile[]> {
  const bySession = new Map<string, LinkObservation[]>();
  for (const o of observations) {
    const l = bySession.get(o.session);
    if (l) l.push(o); else bySession.set(o.session, [o]);
  }
  const result = new Map<string, ScoredFile[]>();
  for (const note of notes) {
    const window = windowDays(note.created);
    const totals = new Map<string, { score: number; sessions: number }>();
    for (const obsOfSession of bySession.values()) {
      const inWindow = obsOfSession.some(o => window.has(dayKey(new Date(o.epoch))));
      const ageDays = Math.max(0, (now - Math.max(...obsOfSession.map(o => o.epoch))) / 86_400_000);
      const age = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      const best = new Map<string, number>(); // strongest evidence per file within this session
      for (const o of obsOfSession) {
        const mentioned = [o.title, o.why, o.narrative].some(t => t?.includes(note.slug)); // covers [[slug]] too
        const files = new Set([...o.filesModified, ...o.filesRead]);
        const damp = Math.sqrt(files.size);
        const modified = new Set(o.filesModified);
        for (const f of files) {
          const w = mentioned ? SLUG_WEIGHT : inWindow ? (modified.has(f) ? EDIT_WEIGHT : READ_WEIGHT) : 0;
          if (w > 0) best.set(f, Math.max(best.get(f) ?? 0, w / damp));
        }
      }
      for (const [f, w] of best) {
        const t = totals.get(f) ?? { score: 0, sessions: 0 };
        t.score += w * age;
        t.sessions += 1;
        totals.set(f, t);
      }
    }
    result.set(note.slug, [...totals].map(([file, t]) => ({ file, ...t })).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)));
  }
  return result;
}
