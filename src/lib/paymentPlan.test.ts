import { expect, it } from 'vitest';
import { paymentPlanSchema } from './settlements';
it('accepts a cash promise but strips forged payment status and actor', () => {
  expect(paymentPlanSchema.parse({ method: 'CASH', account: ' Каса ', status: 'PAID', by: 'forged' })).toEqual({ method: 'CASH', account: 'Каса' });
});
it('rejects invalid methods and oversized destinations', () => {
  expect(paymentPlanSchema.safeParse({ method: 'PAID' }).success).toBe(false);
  expect(paymentPlanSchema.safeParse({ method: 'TRANSFER', account: 'a'.repeat(151) }).success).toBe(false);
});
