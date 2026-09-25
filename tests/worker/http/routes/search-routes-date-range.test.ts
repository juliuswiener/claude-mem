import { describe, it, expect, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';

type Handler = (req: Request, res: Response) => void;

function captureGetHandlers(routes: SearchRoutes): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const app = {
    use: mock(() => {}),
    get: mock((path: string, handler: Handler) => {
      handlers.set(path, handler);
    }),
    post: mock(() => {}),
  };

  routes.setupRoutes(app as any);
  return handlers;
}

function makeResponse(): { res: Response; json: ReturnType<typeof mock>; status: ReturnType<typeof mock> } {
  const json = mock(() => {});
  const res = {
    headersSent: false,
    locals: {},
    json,
    status: mock((code: number) => {
      (res as any).statusCode = code;
      return res;
    }),
  } as any;
  return { res: res as Response, json, status: res.status };
}

function makeRequest(query: Record<string, unknown>): Request {
  return {
    path: '/api/search/observations',
    query,
    body: {},
    get: () => undefined,
  } as any;
}

function flushAsyncHandlers(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('SearchRoutes dateEnd/dateStart validation (AK4)', () => {
  it('rejects an unparseable dateEnd with HTTP 400 instead of silently dropping it', async () => {
    const routes = new SearchRoutes(new SearchManager({} as any, {} as any, null, {} as any, {} as any));
    const handlers = captureGetHandlers(routes);
    const handler = handlers.get('/api/search/observations');
    if (!handler) throw new Error('Handler not registered for /api/search/observations');

    const { res, json, status } = makeResponse();
    handler(makeRequest({ query: 'writeMu', dateEnd: 'not-a-date' }), res);
    await flushAsyncHandlers();

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('dateEnd') }));
  });

  it('rejects an unparseable dateStart with HTTP 400', async () => {
    const routes = new SearchRoutes(new SearchManager({} as any, {} as any, null, {} as any, {} as any));
    const handlers = captureGetHandlers(routes);
    const handler = handlers.get('/api/search/observations');
    if (!handler) throw new Error('Handler not registered for /api/search/observations');

    const { res, json, status } = makeResponse();
    handler(makeRequest({ query: 'writeMu', dateStart: 'not-a-date' }), res);
    await flushAsyncHandlers();

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('dateStart') }));
  });
});
