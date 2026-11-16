/**
 * Phase 1C.0: the parameter and query validators against a REAL Express 5 application.
 * In Express 5 `req.query` is a getter without setter: `req.query = parsed` throws in strict mode,
 * so validateQuery answered 500 to every request (found while reviewing the `any` lint warnings;
 * not used by a route yet, hence never seen).
 */
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { validateParams, validateQuery } from '../middleware/validation.js';

async function call(app: express.Express, path: string): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    return await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        })
        .on('error', reject);
    });
  } finally {
    server.close();
  }
}

describe('validators on Express 5 (Phase 1C.0)', () => {
  it('validateQuery: a valid query passes, parsed (coerced), and the handler sees it', async () => {
    const app = express();
    app.get('/q', validateQuery(z.object({ n: z.coerce.number().int(), tag: z.string().optional() })), (req, res) => {
      res.json({ query: req.query });
    });
    expect(await call(app, '/q?n=42&tag=a')).toEqual({ status: 200, body: { query: { n: 42, tag: 'a' } } });
    const bad = await call(app, '/q?n=abc');
    expect(bad.status).toBe(400);
  });

  it('validateParams: a valid parameter passes, parsed; an invalid one is refused', async () => {
    const app = express();
    app.get('/p/:id', validateParams(z.object({ id: z.string().regex(/^[a-z]+$/) })), (req, res) => {
      res.json({ id: req.params.id });
    });
    expect(await call(app, '/p/abc')).toEqual({ status: 200, body: { id: 'abc' } });
    expect((await call(app, '/p/123')).status).toBe(400);
  });
});
