import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { notifyOnWrite } from './tournamentLive';

/* Регресія: id турніру треба брати під префіксом монтування, а не з повного URL на 'finish'. */
describe('notifyOnWrite', () => {
  it.each([[200, 1], [409, 0]])('статус %i → сповіщень %i', async (status, calls) => {
    const notify = vi.fn();
    const app = express(), router = express.Router();
    router.use('/tournaments', notifyOnWrite(notify));
    router.post('/tournaments/:id/start', (_req, res) => { res.status(status).json({}); });
    app.use('/api/federation', router);
    const server = http.createServer(app).listen(0);
    const id = 'f1228a8b-b28a-4f4c-be33-2e4181895a8a';
    await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/federation/tournaments/${id}/start`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 20));
    server.close();
    expect(notify).toHaveBeenCalledTimes(calls);
    if (calls) expect(notify).toHaveBeenCalledWith(id);
  });
});
