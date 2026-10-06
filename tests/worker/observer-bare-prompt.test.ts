import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';

// Same module-mock discipline as claude-provider-assistant-frames.test.ts:
// snapshot the real modules and restore them in afterAll.
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };
const actualProcessRegistry = { ...(await import('../../src/supervisor/process-registry.js')) };
const actualModeManager = { ...(await import('../../src/services/domain/ModeManager.js')) };

// What the SDK feed receives: one entry per request the observer would be sent.
let sentRequests: string[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...actualAgentSdk,
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) =>
    (async function* () {
      for await (const message of prompt) sentRequests.push(message.message.content);
    })(),
}));

mock.module('../../src/shared/find-claude-executable.js', () => ({
  ...actualFindClaude,
  findClaudeExecutable: () => '/mock/claude',
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnvManager,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH ?? '' }),
  getAuthMethodDescription: () => 'test-auth',
}));

mock.module('../../src/supervisor/process-registry.js', () => ({
  ...actualProcessRegistry,
  waitForSlot: async () => ({ release: () => {} }),
  createSdkSpawnFactory: () => () => {
    throw new Error('spawn factory must not run in this test');
  },
  getSdkProcessForSession: () => undefined,
  ensureSdkProcessExit: async () => {},
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ...actualModeManager,
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: { init: 'INIT-INSTRUCTIONS', observation: 'obs prompt', summary: 'summary prompt' },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
    }),
  },
}));

afterAll(() => {
  mock.module('../../src/services/domain/ModeManager.js', () => actualModeManager);
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualAgentSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnvManager);
  mock.module('../../src/supervisor/process-registry.js', () => actualProcessRegistry);
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

const USER_PROMPT = 'investigate the handover bug';

function createSession(): ActiveSession {
  return {
    sessionDbId: 4336,
    contentSessionId: 'content-4336',
    memorySessionId: null,
    project: 'observer-project',
    platformSource: 'claude',
    userPrompt: USER_PROMPT,
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

function createProvider(queued: Array<Record<string, unknown>>) {
  const sessionManager = {
    confirmClaimedMessages: async () => 0,
    resetProcessingToPending: async () => 0,
    getClaimedMessages: () => [],
    getMessageIterator: async function* () {
      for (const message of queued) yield message;
    },
  };
  const dbManager = {
    getSessionStore: () => ({
      updateMemorySessionId: () => {},
      ensureMemorySessionIdRegistered: () => {},
      getSessionById: () => ({ memory_session_id: null }),
      storeObservations: () => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }),
    }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  };
  return new ClaudeProvider(dbManager as never, sessionManager as never);
}

const OBSERVATION = { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: 'x' };

describe('observer user prompt rides on the first event (#4336)', () => {
  const saved = process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;

  beforeEach(() => {
    sentRequests = [];
    delete process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
    else process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = saved;
  });

  it('sends the init prompt and the first observation in ONE request by default', async () => {
    await createProvider([OBSERVATION]).startSession(createSession());

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toContain(USER_PROMPT);
    expect(sentRequests[0]).toContain('a.ts');
    expect(sentRequests[0].indexOf(USER_PROMPT)).toBeLessThan(sentRequests[0].indexOf('a.ts'));
  });

  it('sends the init prompt only once: the second observation goes alone', async () => {
    await createProvider([OBSERVATION, { ...OBSERVATION, tool_input: { file_path: 'b.ts' } }]).startSession(createSession());

    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[1]).toContain('b.ts');
    expect(sentRequests[1]).not.toContain(USER_PROMPT);
  });

  it('carries the init prompt on the first summary when no observation comes first', async () => {
    await createProvider([{ type: 'summarize', last_assistant_message: 'done' }]).startSession(createSession());

    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toContain(USER_PROMPT);
    expect(sentRequests[0]).toContain('done');
  });

  it('sends nothing for a generation that never gets an event', async () => {
    await createProvider([]).startSession(createSession());

    expect(sentRequests).toHaveLength(0);
  });

  it('CLAUDE_MEM_OBSERVE_BARE_PROMPTS=true restores the separate init request', async () => {
    process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = 'true';
    await createProvider([OBSERVATION]).startSession(createSession());

    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[0]).toContain(USER_PROMPT);
    expect(sentRequests[0]).not.toContain('a.ts');
    expect(sentRequests[1]).toContain('a.ts');
    expect(sentRequests[1]).not.toContain(USER_PROMPT);
  });
});
