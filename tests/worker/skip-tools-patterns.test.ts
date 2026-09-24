// Vault: aufgezeichnet-wird-was-sonst-verloren-waere. Die Ausschlussliste
// verglich exakte Namen; `Bash` darin traf die MCP-Shell
// `mcp__plugin_nord-core_t__Bash` nicht, und die machte am 2026-09-24 65 %
// aller eingereihten Aufrufe aus.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext, ingestObservation } from '../../src/services/worker/http/shared.js';
import { logger } from '../../src/utils/logger.js';

const LIST = 'Bash,Read,mcp__plugin_nord-core_t__*,mcp__plugin_nord-mem_*,ToolSearch';

describe('CLAUDE_MEM_SKIP_TOOLS versteht *', () => {
  let store: SessionStore | undefined;
  let saved: string | undefined;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    saved = process.env.CLAUDE_MEM_SKIP_TOOLS;
    process.env.CLAUDE_MEM_SKIP_TOOLS = LIST;
    spies = (['info', 'debug', 'warn', 'error', 'dataIn'] as const)
      .map((level) => spyOn(logger, level).mockImplementation(() => {}));
    store = new SessionStore(new Database(':memory:'));
    setIngestContext({
      sessionManager: { queueObservation: async () => {} } as any,
      dbManager: { getSessionStore: () => store } as any,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
    });
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    store?.close();
    store = undefined;
    if (saved === undefined) delete process.env.CLAUDE_MEM_SKIP_TOOLS;
    else process.env.CLAUDE_MEM_SKIP_TOOLS = saved;
  });

  const ingest = (toolName: string) => ingestObservation({
    contentSessionId: 'content-session-skip',
    toolName,
    toolInput: { x: 1 },
    toolResponse: { ok: true },
    cwd: '/workspace/claude-mem',
    platformSource: 'claude-code',
    toolUseId: `toolu_${toolName}`,
  });

  for (const name of [
    'mcp__plugin_nord-core_t__Bash',
    'mcp__plugin_nord-core_t__lsp_hover',
    'mcp__plugin_nord-mem_mcp-search__search',
    'Bash',
    'ToolSearch',
  ]) {
    it(`${name} wird uebersprungen`, async () => {
      expect(await ingest(name)).toEqual({ ok: true, status: 'skipped', reason: 'tool_excluded' });
    });
  }

  for (const name of ['Edit', 'mcp__context7__query-docs', 'AskUserQuestion', 'mcp__plugin_nord-core_tX']) {
    it(`${name} wird aufgezeichnet`, async () => {
      const result = await ingest(name);
      expect((result as { reason?: string }).reason).not.toBe('tool_excluded');
    });
  }
});
