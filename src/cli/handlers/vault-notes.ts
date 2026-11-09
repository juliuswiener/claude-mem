// Adapter: vault notes that govern a file (`bin/context --governing`).
// Every failure (missing command, timeout, bad JSON, no git repo, exit != 0)
// resolves to "no notes" — this module never throws and never blocks the gate.
// Surfaced to the agent: title/slug/type/verified plus the section text the vault
// already cut (`section`, `text`); the note path is built once, in the header, from `path`. Nothing is persisted here.
import { spawn } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

export const VAULT_NOTE_LIMIT = 3; // notes delivered with text
export const VAULT_LIST_LIMIT = 8; // further notes delivered as title lines
export const VAULT_BLOCK_MAX_CHARS = 9000;
export const VAULT_DIGEST_MAX_CHARS = 8000;
export const VAULT_DIGEST_TEXT_NOTES = 3; // digest: notes delivered with text
export const VAULT_DIGEST_TEXT_CHARS = 700;
export const VAULT_DIGEST_LIST_LIMIT = 8;
const VAULT_DIGEST_FILE_NAMES = 3;
const CUT_MARKER = '[… gekürzt]';
const VAULT_TIMEOUT_MS = 2_000;
const VAULT_BROAD_TIMEOUT_MS = 3_000;
const VAULT_TYPE_DIRS = '{decisions,architecture,audits,research}'; // where a note path is built from a slug
export const VAULT_BROAD_MAX_CHARS = 1500;

export interface VaultNote {
  slug: string;
  title: string;
  type: string;
  verified: string;
  broad_content: boolean;
  path: string;
  section: string;
  text: string;
  // Rechnet `bin/context`; fehlt ein Feld, hat der Vault nichts zu sagen (kein "unbekannt").
  baustand?: string; // "gebaut" | "offen"
  erledigt_in?: string; // Freitext, bis 372 Zeichen
  offene_umsetzung?: string; // Slug des ältesten offenen Eintrags
  offene_anzahl?: number;
  alter?: { seit: string; commits: number };
  tote_muster?: { tot: number; von: number }; // Muster in applies_to, die keine versionierte Datei mehr treffen
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

const vaultCommand = () => process.env.NORD_VAULT_CONTEXT_CMD
  || path.join(process.env.VAULT_DIR || path.join(homedir(), '00_projects', 'vault'), 'bin', 'context');

export async function getGoverningVaultNotes(absoluteFile: string): Promise<VaultNote[]> {
  try {
    const deadline = Date.now() + VAULT_TIMEOUT_MS;
    const root = (await run('git', ['-C', path.dirname(absoluteFile), 'rev-parse', '--show-toplevel'], VAULT_TIMEOUT_MS))?.trim();
    if (!root) return [];
    const rel = path.relative(root, absoluteFile).split(path.sep).join('/');
    const out = await run(vaultCommand(), ['--governing', '--repo', root, rel], Math.max(1, deadline - Date.now()));
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

const DONE_MAX_CHARS = 80; // erledigt_in is free text: the hash leads, the rest is cut
const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** `alter` of a note, or null unless it is a date and a count the header may print. */
function noteAge(n: VaultNote): { seit: string; commits: number } | null {
  const a = n.alter;
  if (!a || typeof a.seit !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.seit)) return null;
  return Number.isInteger(a.commits) && a.commits >= 0 ? a : null;
}

/** `tote_muster` of a note, or null unless it is a count the header may print (0 < tot <= von). */
function deadPatterns(n: VaultNote): { tot: number; von: number } | null {
  const t = n.tote_muster;
  if (!t || !Number.isInteger(t.tot) || !Number.isInteger(t.von)) return null;
  return t.tot > 0 && t.tot <= t.von ? t : null;
}

/** Build state, age and dead patterns for the header; anything missing or malformed stays out. */
function standParts(n: VaultNote): string[] {
  const parts: string[] = [];
  const done = oneLine(n.erledigt_in);
  const open = oneLine(n.offene_umsetzung);
  if (n.baustand === 'gebaut') {
    parts.push(done ? `gebaut, erledigt in ${done.length > DONE_MAX_CHARS ? `${done.slice(0, DONE_MAX_CHARS)}…` : done}` : 'gebaut');
  } else if (n.baustand === 'offen' && open) {
    const more = Number.isInteger(n.offene_anzahl) && n.offene_anzahl! > 1 ? ` (und ${n.offene_anzahl! - 1} weitere)` : '';
    parts.push(`Umsetzung offen: ${open}${more}`);
  }
  const age = noteAge(n);
  if (age) {
    parts.push(age.commits === 0
      ? `unverändert seit ${age.seit}`
      : `${age.commits} Commit${age.commits === 1 ? '' : 's'} auf diesen Pfaden seit ${age.seit}`);
  }
  // Always "k von n": a file in the gate matched a pattern, so "Gegenstand nicht auffindbar" would be false here.
  const dead = deadPatterns(n);
  if (dead) parts.push(`${dead.tot} von ${dead.von} Mustern treffen nichts`);
  return parts;
}

/** Label of the text block when paths changed since the note was checked: the text is history, dated. */
function historyLabel(n: VaultNote): string {
  const age = noteAge(n);
  return age && age.commits > 0
    ? `Vorgeschichte (Stand ${age.seit} — der Beschluss gilt; Pfade, Zeilen und Zahlen gelten für damals)` : '';
}

const titleLine = (n: VaultNote) => {
  const stand = standParts(n);
  return `[[${n.slug}]] — ${n.title} (${n.type}, verified ${n.verified || '—'})${stand.length ? ` — ${stand.join(' — ')}` : ''}`;
};

interface Rendered { text: string; slugs: string[] }

/** Vault root = two levels above a note path (<root>/<type>/<slug>.md); '' without any path. */
function vaultRoot(notes: VaultNote[]): string {
  const p = notes.find(n => n.path)?.path;
  return p ? path.dirname(path.dirname(p)) : '';
}

interface RenderConfig {
  header: (hint: string) => string; // hint: how to build a note path from a slug, '' when unknown
  listHeader: string;
  maxChars: number;
  noteLimit: number;
  listLimit: number;
  textChars?: number; // cut each note text to this length (with marker) before the global fit
  suffix?: (n: VaultNote) => string; // appended to the title line of a note with text
  textAllowed?: Set<string>; // notes in the text slot outside this set are left out
  titleAllowed?: Set<string>; // notes in the list outside this set are left out
}

const GATE_CONFIG: RenderConfig = {
  header: hint => `Vault-Notizen, die diese Datei regieren${hint ? ` (${hint})` : ''}:`,
  listHeader: 'Weitere Notizen (nach Rang):',
  maxChars: VAULT_BLOCK_MAX_CHARS,
  noteLimit: VAULT_NOTE_LIMIT,
  listLimit: VAULT_LIST_LIMIT,
};

/** Builds the block under cfg.maxChars; slugs = every note that stands in it. */
function render(notes: VaultNote[], cfg: RenderConfig = GATE_CONFIG): Rendered | null {
  const narrow = narrowNotes(notes);
  // Ranks stay where they are: a left-out note frees no slot for a lower one.
  const head = narrow.slice(0, cfg.noteLimit).filter(n => !cfg.textAllowed || cfg.textAllowed.has(n.slug));
  const listed = narrow.slice(cfg.noteLimit, cfg.noteLimit + cfg.listLimit)
    .filter(n => !cfg.titleAllowed || cfg.titleAllowed.has(n.slug));
  if (head.length === 0 && listed.length === 0) return null;
  const texts = head.map(n => (cfg.textChars && n.text.length > cfg.textChars
    ? `${n.text.slice(0, cfg.textChars)}\n${CUT_MARKER}` : n.text));
  const root = vaultRoot(narrow);
  const header = cfg.header(root ? `ganze Notiz: ${root}/${VAULT_TYPE_DIRS}/<slug>.md` : '');
  let list = listed;
  // "und N weitere": ranks beyond the list, plus list lines the fit below drops.
  const beyond = Math.max(0, narrow.length - cfg.noteLimit - cfg.listLimit);

  const build = () => {
    const lines = [header];
    head.forEach((n, i) => {
      lines.push(titleLine(n) + (cfg.suffix?.(n) ?? ''));
      if (texts[i]) {
        const label = [n.section, historyLabel(n)].filter(Boolean).join(' — ');
        if (label) lines.push(`  ${label}:`);
        for (const l of texts[i].split('\n')) lines.push(`    ${l}`);
      }
    });
    if (list.length > 0) {
      lines.push(cfg.listHeader);
      for (const n of list) lines.push(titleLine(n));
    }
    const rest = beyond + listed.length - list.length;
    if (rest > 0) lines.push(`und ${rest} weitere`);
    return lines.join('\n');
  };

  let out = build();
  // 1. texts: third, second, first note (title line stays).
  // The cut shrinks until the block fits; indent and marker add to the length, so one pass is not exact.
  for (let i = head.length - 1; i >= 0 && out.length > cfg.maxChars; i--) {
    const full = texts[i];
    let keep = full.length;
    while (out.length > cfg.maxChars && keep > 0) {
      keep = Math.max(0, keep - (out.length - cfg.maxChars) - CUT_MARKER.length - 5);
      texts[i] = keep > 0 ? `${full.slice(0, keep)}\n${CUT_MARKER}` : '';
      out = build();
    }
  }
  // 2. title lines of the further notes, from the back (rest counts in "und N weitere")
  while (out.length > cfg.maxChars && list.length > 0) {
    list = list.slice(0, -1);
    out = build();
  }
  const slugs = [...head, ...list].map(n => n.slug);
  // 3. last resort: hard cut
  if (out.length > cfg.maxChars) out = out.slice(0, cfg.maxChars - CUT_MARKER.length) + CUT_MARKER;
  return { text: out, slugs };
}

/** Slugs that formatVaultNotes actually shows (notes with text and title lines). */
export function shownVaultSlugs(notes: VaultNote[]): string[] {
  return render(notes)?.slugs ?? [];
}

/** Slugs of the notes that stand in the text slot (the first VAULT_NOTE_LIMIT). */
export function vaultTextSlugs(notes: VaultNote[]): string[] {
  return narrowNotes(notes).slice(0, VAULT_NOTE_LIMIT).map(n => n.slug);
}

/** Slugs of the notes that stand in the ranked list (the next VAULT_LIST_LIMIT). */
export function vaultListSlugs(notes: VaultNote[]): string[] {
  return narrowNotes(notes).slice(VAULT_NOTE_LIMIT, VAULT_NOTE_LIMIT + VAULT_LIST_LIMIT).map(n => n.slug);
}

/**
 * Format notes as a text block, or null when nothing (non-broad) is left.
 * textAllowed: slugs whose text may be delivered; a text-slot note outside it
 * is left out. titleAllowed: the same for the ranked list. Undefined = no filter.
 */
export function formatVaultNotes(notes: VaultNote[], textAllowed?: Set<string>, titleAllowed?: Set<string>): string | null {
  return render(notes, { ...GATE_CONFIG, textAllowed, titleAllowed })?.text ?? null;
}

export interface DigestFile { file: string; notes: VaultNote[]; seen: string[] }

/**
 * Digest of the notes the agent saw, merged over the working set by slug.
 * Rank: number of files the note governs (desc), then vault order. null = nothing to say.
 */
export function formatVaultDigest(files: DigestFile[]): string | null {
  const merged = new Map<string, { note: VaultNote; files: string[] }>();
  for (const { file, notes, seen } of files) {
    for (const n of narrowNotes(notes)) {
      if (!seen.includes(n.slug)) continue;
      const e = merged.get(n.slug);
      if (e) e.files.push(path.basename(file));
      else merged.set(n.slug, { note: n, files: [path.basename(file)] });
    }
  }
  const ranked = [...merged.values()].sort((a, b) => b.files.length - a.files.length); // stable
  const filesOf = new Map(ranked.map(e => [e.note.slug, e.files]));
  return render(ranked.map(e => e.note), {
    header: hint => `Vault-Notizen aus der bisherigen Arbeit (die Sitzung wurde kompaktiert; das Gate liefert sie beim nächsten Berühren einer Datei erneut${hint ? `; ${hint}` : ''}):`,
    listHeader: 'Weitere:',
    maxChars: VAULT_DIGEST_MAX_CHARS,
    noteLimit: VAULT_DIGEST_TEXT_NOTES,
    listLimit: VAULT_DIGEST_LIST_LIMIT,
    textChars: VAULT_DIGEST_TEXT_CHARS,
    suffix: n => {
      const f = filesOf.get(n.slug)!;
      return ` — gilt für ${f.length} Dateien: ${f.slice(0, VAULT_DIGEST_FILE_NAMES).join(', ')}${f.length > VAULT_DIGEST_FILE_NAMES ? ' …' : ''}`;
    },
  })?.text ?? null;
}

export interface BroadNote {
  slug: string; title: string; type: string; section: string; text: string;
  path: string; created: string; verified: string;
  repo: string; // repo root the vault answered for
}

/** Notes the vault declares broad for the repo around cwd (`bin/context --broad`); every failure → []. */
export async function getBroadVaultNotes(cwd: string): Promise<BroadNote[]> {
  try {
    const deadline = Date.now() + VAULT_BROAD_TIMEOUT_MS;
    const root = (await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], VAULT_BROAD_TIMEOUT_MS))?.trim();
    if (!root) return [];
    const out = await run(vaultCommand(), ['--broad', '--repo', root], Math.max(1, deadline - Date.now()));
    if (!out) return [];
    const notes = JSON.parse(out)?.notes;
    if (!Array.isArray(notes)) return [];
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return notes
      .filter(n => n && typeof n.slug === 'string' && typeof n.title === 'string')
      .map(n => ({
        slug: n.slug, title: n.title, type: str(n.type), section: str(n.section), text: str(n.text),
        path: str(n.path), created: str(n.created), verified: str(n.verified), repo: root,
      }));
  } catch {
    return [];
  }
}

/**
 * Broad-notes overview for session start, or null when there is nothing to say.
 * Under VAULT_BROAD_MAX_CHARS: first the texts go (last note first), then title
 * lines from the back (counted in "und N weitere"), last a hard cut.
 */
export function formatBroadNotes(notes: BroadNote[]): string | null {
  if (notes.length === 0) return null;
  const root = vaultRoot(notes as unknown as VaultNote[]);
  const repo = path.basename(notes[0].repo ?? '');
  const header = `Breite Vault-Notizen für ${repo} (gelten für das ganze Repo${root ? `; ganze Notiz: ${root}/${VAULT_TYPE_DIRS}/<slug>.md` : ''}):`;
  const withText = notes.map(n => n.text !== '');
  let shown = notes.length;
  const build = () => {
    const lines = [header];
    notes.slice(0, shown).forEach((n, i) => {
      lines.push(titleLine(n as unknown as VaultNote));
      if (!withText[i]) return;
      if (n.section && n.section !== 'Kurzfassung') lines.push(`  ${n.section}:`);
      for (const l of n.text.split('\n')) lines.push(`    ${l}`);
    });
    if (shown < notes.length) lines.push(`und ${notes.length - shown} weitere`);
    return lines.join('\n');
  };
  let out = build();
  for (let i = notes.length - 1; i >= 0 && out.length > VAULT_BROAD_MAX_CHARS; i--) {
    withText[i] = false;
    out = build();
  }
  while (out.length > VAULT_BROAD_MAX_CHARS && shown > 0) {
    shown--;
    out = build();
  }
  if (out.length > VAULT_BROAD_MAX_CHARS) out = out.slice(0, VAULT_BROAD_MAX_CHARS - CUT_MARKER.length) + CUT_MARKER;
  return out;
}

/** Session-start overview text; '' on nothing, error or after the hard 3 s cap. Never throws. */
export async function broadVaultOverview(cwd: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const notes = await Promise.race([
      getBroadVaultNotes(cwd),
      new Promise<BroadNote[]>(resolve => { timer = setTimeout(() => resolve([]), VAULT_BROAD_TIMEOUT_MS); }),
    ]);
    return formatBroadNotes(notes) ?? '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
