// Die Pausenmeldung beim Sitzungsstart liest observer-health.json. Die Sperre selbst endet
// bei quotaCooldownEndsAtMs() (Entscheidung die-gemeldete-ruecksetzzeit-schlaegt-die-geschaetzte);
// die Kopie des Fensters, die syncObserverHealthQuotaCooldown dorthin spiegelt, muss dieselbe
// Zeit nennen. Ticket: die-pausenmeldung-nennt-30-minuten-statt-der-gemeldeten-ruecksetzzeit.
//
// Der Datenordner ist der pro Lauf frische aus tests/preload.ts: recordQuotaExhausted und
// resetQuotaCooldownsForTesting schreiben und LOESCHEN quota-cooldown.json und
// observer-health.json dort.

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import {
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  getQuotaCooldown,
  quotaCooldownEndsAtMs,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import {
  OBSERVER_HEALTH_FILENAME,
  isObserverQuotaCooldownActive,
  readObserverHealth,
  renderObserverQuotaCooldownNotice,
} from '../../src/shared/observer-health.js';
import { paths } from '../../src/shared/paths.js';

const armedAt = 1_800_000_000_000;
const MIN = 60_000;

function mirrored() {
  const health = readObserverHealth(join(paths.dataDir(), OBSERVER_HEALTH_FILENAME));
  expect(health).not.toBeNull();
  expect(health!.quotaCooldown).not.toBeNull();
  return health!;
}

describe('observer-health.json spiegelt das Sperrfenster samt Ruecksetzzeit', () => {
  beforeEach(() => resetQuotaCooldownsForTesting());
  afterAll(() => resetQuotaCooldownsForTesting());

  it('traegt die gemeldete Ruecksetzzeit, wenn sie Tage entfernt liegt (Wochenfenster)', () => {
    const resetsAt = armedAt + 3 * 24 * 60 * MIN;
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', armedAt, resetsAt);

    expect(mirrored().quotaCooldown!.until).toBe(resetsAt);
    // Die Sperre endet schon dort; der Spiegel darf keine zweite Meinung sein.
    expect(mirrored().quotaCooldown!.until).toBe(quotaCooldownEndsAtMs(getQuotaCooldown('claude')!));
  });

  // Der Client schreibt Sekunden so oft wie Millisekunden (das echte Hauptbuch trug 1791687600).
  it('traegt sie in ms, wenn der Client Epochensekunden schrieb', () => {
    const resetsAtMs = armedAt + 3 * 24 * 60 * MIN;
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', armedAt, Math.floor(resetsAtMs / 1000));

    expect(mirrored().quotaCooldown!.until).toBe(resetsAtMs);
  });

  // Die Seite, die der Mensch sieht: die Meldung gilt nur, solange `until` voraus liegt. Mit den
  // 30 Minuten verschwindet sie nach 31 Minuten, obwohl noch drei Tage nichts aufgezeichnet wird.
  it('haelt die Sitzungsstart-Meldung ueber die Konstante hinaus und nennt die gemeldete Zeit', () => {
    const resetsAt = armedAt + 3 * 24 * 60 * MIN;
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', armedAt, resetsAt);

    const now = armedAt + (QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + MIN);
    expect(isObserverQuotaCooldownActive(mirrored(), now)).toBe(true);
    expect(renderObserverQuotaCooldownNotice(mirrored(), now)).toContain(new Date(resetsAt).toISOString());
  });

  // Von der anderen Seite: eine Ruecksetzzeit VOR der Konstante. Die Sperre oeffnet sich dort;
  // der Spiegel hielte das Banner 25 Minuten laenger.
  it('haelt die Meldung nicht ueber eine Ruecksetzzeit hinaus, die vor der Konstante liegt', () => {
    const resetsAt = armedAt + 5 * MIN;
    recordQuotaExhausted('claude', 'five hour limit reached', 'five_hour', armedAt, resetsAt);

    expect(mirrored().quotaCooldown!.until).toBe(resetsAt);
    expect(isObserverQuotaCooldownActive(mirrored(), resetsAt + MIN)).toBe(false);
  });

  // Gegenarm: ohne brauchbare Ruecksetzzeit traegt die Konstante, damit ein Fix, der immer die
  // gemeldete Zeit (oder immer die Konstante) nimmt, nicht beide Seiten besteht.
  it('behaelt die 30 Minuten, wo keine Ruecksetzzeit gemeldet wurde', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', armedAt);

    expect(mirrored().quotaCooldown!.until).toBe(armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
  });

  it('behaelt die Konstante, wo die gemeldete Zeit keine Ruecksetzzeit ist', () => {
    for (const bogus of [0, -1, Number.NaN, armedAt - MIN, armedAt]) {
      resetQuotaCooldownsForTesting();
      recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', armedAt, bogus);

      expect(mirrored().quotaCooldown!.until).toBe(armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
    }
  });
});
