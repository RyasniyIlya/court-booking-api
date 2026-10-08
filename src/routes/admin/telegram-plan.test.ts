
import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { signToken } from './shared';
const mocks = vi.hoisted(() => ({ club: vi.fn(), update: vi.fn(), user: vi.fn(), password: vi.fn() }));
vi.mock('../../lib/db', () => ({ prisma: { club: { findUnique: mocks.club }, user: { update: mocks.update, updateMany: mocks.update, findUnique: mocks.user } } }));
vi.mock('./shared', async original => ({ ...await original<typeof import('./shared')>(), verifyAccountPassword: mocks.password }));
vi.mock('../../lib/authSecret', () => ({ JWT_SECRET: 'test-subscription-secret' }));
vi.mock('../../lib/telegram', () => ({ botReady: () => true }));
const { telegramRouter } = await import('./telegram');
const app = express(); app.use(express.json()); app.use(telegramRouter);
const token = (role: string) => {
 mocks.user.mockResolvedValue({id:'u',clubId:'c',role,trainerId:role==='TRAINER'?'t':null,passwordHash:'test-hash',tgChatId:'123'});
 return signToken({userId:'u',clubId:'c',role,trainerId:role==='TRAINER'?'t':null}, '1h', 'test-hash');
};
beforeEach(() => { vi.clearAllMocks(); mocks.update.mockResolvedValue({count:1}); mocks.password.mockResolvedValue({ok:true}); mocks.user.mockResolvedValue({tgChatId:'123'}); });
for (const role of ['OWNER','ADMIN','TRAINER']) {
 it.each([null,1,2,3])(role + ' Telegram API tier %s', async tier => {
  mocks.club.mockResolvedValue({plan:tier ? {tier,featTrainers:tier>=2,featGroups:tier>=2,featAnalytics:tier===3}:null});
  const res = await request(app).post('/telegram/link').set('Authorization','Bearer '+token(role)).send({currentPassword:'fixture-password'});
  expect(res.status).toBe(tier?200:402);
  if(tier) expect(res.body.code).toMatch(/^[A-Z0-9]{6}$/);
  else { expect(res.body).toMatchObject({error:'PLAN_REQUIRED',feature:'telegram'}); expect(mocks.update).not.toHaveBeenCalled(); }
 });
}
it('does not disclose connection status for a club without a plan', async () => {
 mocks.club.mockResolvedValue({plan:null});
 expect((await request(app).get('/telegram').set('Authorization','Bearer '+token('OWNER'))).status).toBe(402);
 expect(mocks.user).toHaveBeenCalledTimes(1); // Authentication only, no connection details.
});
it('allows unlinking after downgrade', async () => {
 expect((await request(app).delete('/telegram').set('Authorization','Bearer '+token('TRAINER'))).status).toBe(204);
 expect(mocks.update).toHaveBeenCalled();
});
