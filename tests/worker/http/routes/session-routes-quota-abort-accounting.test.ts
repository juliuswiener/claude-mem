import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { consumeAbortReason } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { resetQuotaCooldownsForTesting, getQuotaCooldown } from '../../../../src/shared/quota-cooldown.js';
import { readObserverHealth, OBSERVER_HEALTH_FILENAME } from '../../../../src/shared/observer-health.js';
import { paths } from '../../../../src/shared/paths.js';

/**
 * Drives the REAL call site — SessionRoutes' .finally() handler calls this
 * exact exported function, not a reimplementation of it — so a mutant that
 * leaves a field unconsumed, or skips the cooldown or the observer-failure
 * streak, shows up here as red. DATA_DIR is already pinned to a safe
 * per-run temp dir by tests/preload.ts, so the real recordQuotaExhausted /
 * recordObserverFailure disk writes below never touch ~/.claude-mem.
 */
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

describe('consumeAbortReason — real SessionRoutes call site', () => {
  it('provider_rejected: arms the cooldown with the provider-outage message AND the observer-failure streak', () => {
    const before = readObserverHealth()?.consecutiveFailures ?? 0;
    const session = {
      abortReason: 'quota:seven_day',
      quotaAbortDetail: { kind: 'provider_rejected' as const, reason: 'quota:seven_day rejected by provider' },
    };
    expect(consumeAbortReason('claude', session)).toBe('quota:seven_day');
    // Both fields are consumed, so the next generator exit cannot re-read them.
    expect(session.abortReason).toBeNull();
    expect(session.quotaAbortDetail).toBeNull();
    const cooldown = getQuotaCooldown('claude');
    expect(cooldown?.message).toBe('Provider reported the inference allowance exhausted');
    const after = readObserverHealth()?.consecutiveFailures ?? 0;
    expect(after).toBe(before + 1);
  });

  it('non-quota abort reason: leaves the cooldown untouched', () => {
    expect(consumeAbortReason('claude', { abortReason: 'idle', quotaAbortDetail: null })).toBe('idle');
    expect(getQuotaCooldown('claude')).toBeNull();
  });
});
