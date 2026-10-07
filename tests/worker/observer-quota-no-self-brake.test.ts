import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RateLimitStore, type RateLimitInfo } from '../../src/services/worker/RateLimitStore.js';
import { abortSessionForQuotaIfNeeded } from '../../src/services/worker/ClaudeProvider.js';
import { consumeAbortReason } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { getQuotaCooldown, resetQuotaCooldownsForTesting, tryAdmitQuotaProbe } from '../../src/shared/quota-cooldown.js';
import { readObserverHealth, OBSERVER_HEALTH_FILENAME } from '../../src/shared/observer-health.js';
import { paths } from '../../src/shared/paths.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

/**
 * The observer has no quota brake of its own (vault ticket
 * claude-mem-zeichnet-taxgraph-seit-1-10-nichts-auf, option b).
 *
 * claude-mem used to abort the observer at seven_day >= 93% / five_hour >= 95%
 * (and ahead of a five_hour reset) and arm the quota cooldown, while the provider
 * "has not refused anything" — taxgraph's memory stood still for days behind it.
 * Now only a refusal by the provider stops the observer.
 *
 * `observe` drives the two real functions of that path in production order:
 * abortSessionForQuotaIfNeeded (ClaudeProvider's SDK loop, on a rate_limit_event)
 * and consumeAbortReason (SessionRoutes' generator .finally()). The controls at
 * the bottom run through the SAME `observe`, so the "nothing happened" rows above
 * are only worth something because a refusal visibly does happen there.
 * DATA_DIR is pinned to a per-run temp dir by tests/preload.ts.
 */
const cliAuth = 'Claude Code OAuth token (read from system keychain at spawn)';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function fakeSession(): ActiveSession {
  return {
    sessionDbId: 1,
    abortController: new AbortController(),
    abortReason: null,
    quotaAbortDetail: null,
  } as unknown as ActiveSession;
}

function failureCount(): number {
  return readObserverHealth()?.consecutiveFailures ?? 0;
}

function observe(info: RateLimitInfo) {
  const failuresBefore = failureCount();
  const store = new RateLimitStore();
  store.set(info);
  const session = fakeSession();
  const aborted = abortSessionForQuotaIfNeeded(session, cliAuth, store);
  const abortReason = consumeAbortReason('claude', session);
  return {
    aborted,
    abortReason,
    controllerAborted: session.abortController.signal.aborted,
    cooldownMessage: getQuotaCooldown('claude')?.message ?? null,
    nextGeneratorStartAdmitted: tryAdmitQuotaProbe('claude').admitted,
    healthCooldownActive: readObserverHealth()?.quotaCooldown?.active ?? false,
    observerFailuresAdded: failureCount() - failuresBefore,
  };
}

const NOTHING_HAPPENED = {
  aborted: false,
  abortReason: null,
  controllerAborted: false,
  cooldownMessage: null,
  nextGeneratorStartAdmitted: true,
  healthCooldownActive: false,
  observerFailuresAdded: 0,
};

const healthFilePath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
let priorHealthFileContent: string | null = null;

beforeEach(() => {
  resetQuotaCooldownsForTesting();
  priorHealthFileContent = existsSync(healthFilePath) ? readFileSync(healthFilePath, 'utf8') : null;
});

afterEach(() => {
  resetQuotaCooldownsForTesting();
  if (priorHealthFileContent === null) {
    rmSync(healthFilePath, { force: true });
  } else {
    writeFileSync(healthFilePath, priorHealthFileContent);
  }
});

// Each snapshot below tripped the old own guard — the five per-window thresholds
// and the five_hour reset-grace buffer — and none of them is a provider refusal.
// The last row is utilization at the ceiling with status still 'allowed_warning':
// the provider has not said no, so claude-mem must not say it for the provider.
const SNAPSHOTS_THE_OLD_GUARD_ABORTED_ON: Array<[string, RateLimitInfo]> = [
  ['seven_day at 93%', { rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 0.93, resetsAt: Date.now() + 2 * DAY }],
  ['five_hour at 95%', { rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.95, resetsAt: Date.now() + 3 * HOUR }],
  ['seven_day_opus at 93%', { rateLimitType: 'seven_day_opus', status: 'allowed_warning', utilization: 0.93, resetsAt: Date.now() + 2 * DAY }],
  ['seven_day_sonnet at 92%', { rateLimitType: 'seven_day_sonnet', status: 'allowed_warning', utilization: 0.92, resetsAt: Date.now() + 2 * DAY }],
  ['overage in use at 95%', { rateLimitType: 'overage', status: 'allowed_warning', utilization: 0.95, isUsingOverage: true, resetsAt: Date.now() + 2 * DAY }],
  ['five_hour at 90% with the reset 10 min away (grace buffer)', { rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.9, resetsAt: Date.now() + 10 * MIN }],
  ['seven_day at 100%, not refused', { rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 1, resetsAt: Date.now() + 2 * DAY }],
];

describe('the observer has no quota brake of its own', () => {
  for (const [name, info] of SNAPSHOTS_THE_OLD_GUARD_ABORTED_ON) {
    it(`${name}: no abort, no cooldown, the next generator start is admitted`, () => {
      expect(observe(info)).toEqual(NOTHING_HAPPENED);
    });
  }
});

describe('control: a real provider refusal still stops the observer', () => {
  it('a rejected snapshot aborts, arms the cooldown and counts as an observer failure', () => {
    expect(
      observe({ rateLimitType: 'seven_day', status: 'rejected', utilization: 1, resetsAt: Date.now() + 2 * DAY }),
    ).toEqual({
      aborted: true,
      abortReason: 'quota:seven_day',
      controllerAborted: true,
      cooldownMessage: 'Provider reported the inference allowance exhausted',
      nextGeneratorStartAdmitted: false,
      healthCooldownActive: true,
      observerFailuresAdded: 1,
    });
  });

  it('a rejected snapshot aborts even when its utilization is low', () => {
    const outcome = observe({ rateLimitType: 'five_hour', status: 'rejected', utilization: 0.2, resetsAt: Date.now() + 3 * HOUR });
    expect(outcome.aborted).toBe(true);
    expect(outcome.cooldownMessage).toBe('Provider reported the inference allowance exhausted');
  });

  it('quota prose from the observer (quota:observer_text) arms the cooldown and counts as an observer failure', () => {
    const before = failureCount();
    const session = { abortReason: 'quota:observer_text', quotaAbortDetail: null };
    expect(consumeAbortReason('claude', session)).toBe('quota:observer_text');
    expect(getQuotaCooldown('claude')?.message).toBe('Provider reported the inference allowance exhausted');
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
    expect(failureCount()).toBe(before + 1);
  });
});
