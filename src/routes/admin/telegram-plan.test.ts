
import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks = vi.hoisted(() => ({ club: vi.fn(), update: vi.fn(), user: vi.fn() }));
vi.mock('../../lib/db', () => ({ prisma: { club: { findUnique: mocks.club }, user: { update: mocks.update, findUnique: mocks.user } } }));
vi.mock('../../lib/authSecret', () => ({ JWT_SECRET: 'test-subscription-secret' }));
vi.mock('../../lib/telegram', () => ({ botReady: () => true }));
const { telegramRouter } = await import('./telegram');
const app = express(); app.use(express.json()); app.use(telegramRouter);
const token = (role: string) => jwt.sign({userId:'u',clubId:'c',role,trainerId:role==='TRAINER'?'t':null}, 'test-subscription-secret');
beforeEach(() => { vi.clearAllMocks(); mocks.update.mockResolvedValue({}); mocks.user.mockResolvedValue({tgChatId:'123'}); });
for (const role of ['OWNER','ADMIN','TRAINER']) {
 it.each([null,1,2,3])(role + ' Telegram API tier %s', async tier => {
  mocks.club.mockResolvedValue({plan:tier ? {tier,featTrainers:tier>=2,featGroups:tier>=2,featAnalytics:tier===3}:null});
  const res = await request(app).post('/telegram/link').set('Authorization','Bearer '+token(role));
  expect(res.status).toBe(tier===3?200:402);
  if(tier===3) expect(res.body.code).toMatch(/^[A-Z0-9]{6}$/);
  else { expect(res.body).toMatchObject({error:'PLAN_REQUIRED',feature:'telegram'}); expect(mocks.update).not.toHaveBeenCalled(); }
 });
}
it('does not disclose connection status on lower tiers', async () => {
 mocks.club.mockResolvedValue({plan:{tier:2}});
 expect((await request(app).get('/telegram').set('Authorization','Bearer '+token('OWNER'))).status).toBe(402);
 expect(mocks.user).not.toHaveBeenCalled();
});
it('allows unlinking after downgrade', async () => {
 expect((await request(app).delete('/telegram').set('Authorization','Bearer '+token('TRAINER'))).status).toBe(204);
 expect(mocks.update).toHaveBeenCalled();
});
