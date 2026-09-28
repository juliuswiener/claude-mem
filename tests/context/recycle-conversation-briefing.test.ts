import { describe, it, expect, mock, afterAll } from 'bun:test';

/**
 * Captures generateContext's call args via mock.module, following the
 * established capture-snapshot-then-mock.module pattern (see
 * tests/worker/http/routes/session-routes-provider-switch.test.ts): bun's
 * mock.module is process-global and mock.restore() does NOT undo it, so the
 * real module is explicitly re-installed in afterAll for any later file in a
 * full-suite run.
 */
import * as realContextGenerator from '../../src/services/context-generator.js';
const realContextGeneratorSnapshot = { ...realContextGenerator };

let lastGenerateContextCall: unknown[] | null = null;

mock.module('../../src/services/context-generator.js', () => ({
  ...realContextGeneratorSnapshot,
  generateContext: async (...args: unknown[]) => {
    lastGenerateContextCall = args;
    return 'STUB_CONTEXT';
  },
}));

import { loadSessionStartContext } from '../../src/services/worker/session/recycle-conversation.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

afterAll(() => {
  mock.module('../../src/services/context-generator.js', () => realContextGeneratorSnapshot);
});

/**
 * Drives the REAL call site — recycle-conversation.ts's loadSessionStartContext
 * calls generateContext exactly this way — so a mutant flipping the literal
 * includeHealthWarning=false to true (the observer's own SessionStart briefing
 * must never see its own health/cooldown warning — AK3,
 * eigene-quota-bremse-meldet-sich-als-anbieter-sperre) shows up here as red.
 */
describe('loadSessionStartContext — briefs the observer without its own health warning', () => {
  it('calls generateContext with forHuman=false and includeHealthWarning=false', async () => {
    lastGenerateContextCall = null;
    const fakeSession = {
      sessionDbId: 1,
      project: 'test-project',
      platformSource: 'claude-code',
    } as unknown as ActiveSession;

    const text = await loadSessionStartContext(fakeSession, '/tmp/does-not-matter');

    expect(lastGenerateContextCall).not.toBeNull();
    expect(lastGenerateContextCall?.[1]).toBe(false); // forHuman
    expect(lastGenerateContextCall?.[2]).toBe(false); // includeHealthWarning
    expect(text).toBe('STUB_CONTEXT');
  });
});
