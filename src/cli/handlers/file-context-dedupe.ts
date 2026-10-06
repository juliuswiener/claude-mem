// #3480 — per-(session, file, observation-epoch) injection gate for the
// file-context PreToolUse handler, persisted in the main SQLite database
// (plan-20 #3608 step 4: the gate is a DB row, not a JSON side-store).
//
// Each hook invocation is a freshly spawned process (via bun-runner), so an
// in-memory Set cannot remember what was already surfaced this session. The
// gate therefore lives in `claude-mem.db` next to every other durable fact:
// one row per (session, file) carrying the newest observation epoch already
// injected for it. A repeated Read of the same unchanged file is skipped
// unless a NEWER observation has landed since that injection.
//
// The row is keyed on (session_id, file_path) and *carries* the epoch rather
// than keying on the triple: the gate only ever asks "was this pair already
// served at an epoch >= the current newest one", so an upsert keeps the exact
// same semantics as an epoch-keyed row while leaving one row per pair instead
// of one row per observation.
//
// Rows are device-local scratch state. Sync enumerates the tables it pushes
// explicitly (observations, session_summaries, user_prompts — see
// SessionStore.initializeSyncHubLaunchBaseline), so a table it does not name is
// never drained: a gate row never leaves the box.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { resolveDbPath } from '../../shared/paths.js';
import { applySqliteConnectionPragmas } from '../../services/sqlite/connection.js';
import { logger } from '../../utils/logger.js';
import { getGoverningVaultNotes, formatVaultDigest, type DigestFile } from './vault-notes.js';

const GATE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS file_context_injections (
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    observation_epoch INTEGER NOT NULL,
    injected_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, file_path)
  )
`;

// Claiming and recording are ONE statement, so two concurrent Reads of the same
// file in the same session cannot both pass the gate: SQLite serializes the
// writers, the first inserts and gets its row back, the second conflicts and is
// filtered out by the WHERE, which returns no row. `RETURNING` is what reports
// the outcome — bun:sqlite's `.changes` is unreliable after RETURNING (see the
// note in SessionStore.ts), so the claim reads the returned row instead.
//
// The `excluded.observation_epoch > ...` guard also keeps the stored epoch
// monotonic: a hook that finishes late carrying an older epoch neither wins the
// claim nor rolls the row back to that stale value.
// Vault-note delivery protocol: which governing notes were already shown to
// (session, agent, file). Derived state, device-local, slugs only (no titles,
// no note text). agent_id is '' for the main session: a subagent has its own
// context and must receive the notes itself.
const VAULT_DELIVERY_DDL = `
  CREATE TABLE IF NOT EXISTS vault_note_deliveries (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    slugs TEXT NOT NULL,
    delivered_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id, file_path)
  )
`;

// Note-text protocol: which notes' TEXT (not just title) this (session, agent)
// already received. Slugs only, same rules as above.
const VAULT_TEXT_DDL = `
  CREATE TABLE IF NOT EXISTS vault_note_texts (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    delivered_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id, slug)
  )
`;

const CLAIM_VAULT_TEXT_SQL = `
  INSERT INTO vault_note_texts (session_id, agent_id, slug, delivered_at_epoch)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(session_id, agent_id, slug) DO NOTHING
  RETURNING 1 AS claimed
`;

const DELETE_EXPIRED_VAULT_TEXT_SQL = `
  DELETE FROM vault_note_texts WHERE delivered_at_epoch < ?
`;

const DELETE_MAIN_TEXTS_SQL = `
  DELETE FROM vault_note_texts WHERE session_id = ? AND agent_id = ''
`;

const CLAIM_VAULT_DELIVERY_SQL = `
  INSERT INTO vault_note_deliveries (session_id, agent_id, file_path, slugs, delivered_at_epoch)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(session_id, agent_id, file_path) DO NOTHING
  RETURNING 1 AS claimed
`;

const SELECT_VAULT_DELIVERY_SQL = `
  SELECT 1 AS hit FROM vault_note_deliveries
  WHERE session_id = ? AND agent_id = ? AND file_path = ?
`;

const DELETE_EXPIRED_VAULT_SQL = `
  DELETE FROM vault_note_deliveries WHERE delivered_at_epoch < ?
`;

const SELECT_MAIN_DELIVERIES_SQL = `
  SELECT file_path, slugs FROM vault_note_deliveries
  WHERE session_id = ? AND agent_id = ''
  ORDER BY delivered_at_epoch DESC, rowid DESC LIMIT ?
`;

const DELETE_MAIN_DELIVERIES_SQL = `
  DELETE FROM vault_note_deliveries WHERE session_id = ? AND agent_id = ''
`;

const DIGEST_WORKING_SET = 10; // most recently delivered files

const CLAIM_GATE_SQL = `
  INSERT INTO file_context_injections
    (session_id, file_path, observation_epoch, injected_at_epoch)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(session_id, file_path) DO UPDATE SET
    observation_epoch = excluded.observation_epoch,
    injected_at_epoch = excluded.injected_at_epoch
  WHERE excluded.observation_epoch > file_context_injections.observation_epoch
  RETURNING 1 AS claimed
`;

const SELECT_SESSION_SEEN_SQL = `
  SELECT 1 AS hit FROM file_context_injections WHERE session_id = ? LIMIT 1
`;

const DELETE_EXPIRED_SQL = `
  DELETE FROM file_context_injections WHERE injected_at_epoch < ?
`;

// Sessions rarely outlive a few days; drop stale rows so the table never grows
// unbounded. Cheap because we only sweep on a session's first claimed row.
const DAY_MS = 86_400_000;
const GATE_ROW_TTL_DAYS = 7;
const GATE_ROW_TTL_MS = GATE_ROW_TTL_DAYS * DAY_MS;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    // The handle is already being discarded — nothing left to salvage.
  }
}

// One handle per process, keyed by path so a data-dir change (tests, a
// re-pointed CLAUDE_MEM_DATA_DIR) reopens instead of serving the stale file.
let cachedGateDb: { path: string; db: Database } | null = null;

function openGateDb(): Database | null {
  const dbPath = resolveDbPath();
  if (cachedGateDb?.path === dbPath) return cachedGateDb.db;
  if (cachedGateDb) {
    closeQuietly(cachedGateDb.db);
    cachedGateDb = null;
  }

  let opened: Database | null = null;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    opened = new Database(dbPath);
    applySqliteConnectionPragmas(opened);
    opened.run(GATE_TABLE_DDL);
    opened.run(VAULT_DELIVERY_DDL);
    opened.run(VAULT_TEXT_DDL);
    cachedGateDb = { path: dbPath, db: opened };
    return cachedGateDb.db;
  } catch (err) {
    // An unopenable/unwritable DB must never break a Read — fail open and let
    // the injection happen, which is strictly safe (worst case: one redundant
    // block).
    logger.debug('HOOK', 'file-context gate database unavailable, skipping dedupe', {
      dbPath,
      error: describeError(err),
    });
    return null;
  } finally {
    // Opened but never adopted into the cache (the DDL threw): close it here or
    // the handle leaks for the life of the process.
    if (opened && cachedGateDb?.db !== opened) closeQuietly(opened);
  }
}

function pruneExpiredRows(db: Database, sessionId: string, now: number): void {
  if (db.query(SELECT_SESSION_SEEN_SQL).get(sessionId) != null) return;
  db.query(DELETE_EXPIRED_SQL).run(now - GATE_ROW_TTL_MS);
}

/**
 * Atomically claim the right to inject this file's timeline into this session.
 *
 * Returns `true` when the caller should inject — either the (session, file)
 * pair was never surfaced, or a NEWER observation has landed since it was.
 * Returns `false` when the pair was already served at an epoch >= this one, so
 * there is nothing new to say.
 *
 * The claim is recorded by the same statement that grants it, so there is no
 * window in which a concurrent hook can claim the same pair. Fails open: when
 * the gate is unusable the caller injects, which is never worse than the
 * un-deduped behavior this replaces.
 */
export function claimFileContextInjection(
  sessionId: string,
  resolvedPath: string,
  newestObservationEpoch: number,
): boolean {
  if (!sessionId) return true;
  const db = openGateDb();
  if (!db) return true;

  try {
    const now = Date.now();
    pruneExpiredRows(db, sessionId, now);
    return db.query(CLAIM_GATE_SQL).get(sessionId, resolvedPath, newestObservationEpoch, now) != null;
  } catch (err) {
    logger.debug('HOOK', 'file-context gate claim failed, injecting without dedupe', {
      error: describeError(err),
    });
    return true;
  }
}

/**
 * Atomically claim the right to deliver these vault-note slugs for
 * (session, agent, file). `true` = this caller delivers; `false` = already
 * delivered. Fails open like the timeline claim.
 */
export function claimVaultNoteDelivery(
  sessionId: string,
  agentId: string,
  absolutePath: string,
  slugs: string[],
): boolean {
  if (!sessionId) return true;
  const db = openGateDb();
  if (!db) return true;

  try {
    const now = Date.now();
    db.query(DELETE_EXPIRED_VAULT_SQL).run(now - GATE_ROW_TTL_MS);
    db.query(DELETE_EXPIRED_VAULT_TEXT_SQL).run(now - GATE_ROW_TTL_MS);
    return db.query(CLAIM_VAULT_DELIVERY_SQL)
      .get(sessionId, agentId, absolutePath, JSON.stringify(slugs), now) != null;
  } catch (err) {
    logger.debug('HOOK', 'vault delivery claim failed, delivering without dedupe', {
      error: describeError(err),
    });
    return true;
  }
}

/**
 * Atomically claim the right to deliver the TEXT of one note to
 * (session, agent). `true` = this caller delivers the text; `false` = the
 * agent already has it. Fails open (no sessionId, DB error: `true`). Call it
 * only after winning claimVaultNoteDelivery, so a losing instance sets nothing.
 */
export function claimVaultNoteText(sessionId: string, agentId: string, slug: string): boolean {
  if (!sessionId) return true;
  const db = openGateDb();
  if (!db) return true;
  try {
    return db.query(CLAIM_VAULT_TEXT_SQL).get(sessionId, agentId, slug, Date.now()) != null;
  } catch (err) {
    logger.debug('HOOK', 'vault text claim failed, delivering text without dedupe', {
      error: describeError(err),
    });
    return true;
  }
}

/**
 * Read-only shortcut for the claim: was this file already delivered to
 * (session, agent)? Only skips the vault call; the atomic claim stays
 * authoritative. No sessionId or any DB error: `false` (ask the vault).
 */
export function hasVaultNoteDelivery(sessionId: string, agentId: string, absolutePath: string): boolean {
  if (!sessionId) return false;
  const db = openGateDb();
  if (!db) return false;
  try {
    return db.query(SELECT_VAULT_DELIVERY_SQL).get(sessionId, agentId, absolutePath) != null;
  } catch (err) {
    logger.debug('HOOK', 'vault delivery lookup failed', { error: describeError(err) });
    return false;
  }
}

/**
 * Compaction cut: the main session (agent_id '') forgets what it was delivered,
 * because the agent no longer has it in context. Other sessions and subagents
 * keep their rows. Returns a digest of the notes the agent had seen (the most
 * recently delivered files), or '' — the cut happens either way and no vault
 * failure escapes. Stores nothing; the digest is only returned.
 */
export async function resetVaultNoteDeliveries(sessionId: string): Promise<string> {
  if (!sessionId) return '';
  const db = openGateDb();
  if (!db) return '';

  let delivered: { file_path: string; slugs: string }[];
  try {
    delivered = db.query(SELECT_MAIN_DELIVERIES_SQL).all(sessionId, DIGEST_WORKING_SET) as typeof delivered;
    db.query(DELETE_MAIN_DELIVERIES_SQL).run(sessionId);
    db.query(DELETE_MAIN_TEXTS_SQL).run(sessionId); // the agent lost the texts too
  } catch (err) {
    logger.debug('HOOK', 'vault delivery reset failed', { error: describeError(err) });
    return '';
  }

  try {
    const files: DigestFile[] = await Promise.all(delivered.map(async row => ({
      file: row.file_path,
      notes: await getGoverningVaultNotes(row.file_path),
      seen: JSON.parse(row.slugs) as string[],
    })));
    return formatVaultDigest(files) ?? '';
  } catch (err) {
    logger.debug('HOOK', 'vault digest failed', { error: describeError(err) });
    return '';
  }
}
