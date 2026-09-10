import { z } from 'zod';
export const paymentPlanSchema = z.object({
  method: z.enum(['UNSPECIFIED', 'CASH', 'CARD', 'TRANSFER', 'ONLINE', 'BONUS']),
  account: z.string().trim().max(150).default(''),
});

export const settlementSettingsSchema = z.object({
  accounts: z.array(z.string().trim().min(1).max(150)).max(30).default(['Каса', 'Термінал', 'Рахунок клубу']),
  cashRefunds: z.boolean().default(true),
  bankRefunds: z.boolean().default(true),
  bonusRefunds: z.boolean().default(true),
  moderatorRefunds: z.boolean().default(false),
});
export const settlementSchema = z.object({
  requestId: z.string().uuid(),
  kind: z.enum(['PAYMENT', 'REFUND']),
  method: z.enum(['CASH', 'CARD', 'TRANSFER', 'BONUS']),
  amount: z.number().int().positive().max(100_000_000),
  account: z.string().trim().max(150).default(''),
  note: z.string().trim().max(1000).default(''),
  originalId: z.string().uuid().optional(),
}).superRefine((d, ctx) => {
  if (d.kind === 'REFUND' && (!d.originalId || !d.note)) ctx.addIssue({ code: 'custom', message: 'Refund requires original payment and reason' });
});
export function totals(entries: { kind: string; amount: number }[], onlinePaid = 0) {
  const received = entries.filter(e => e.kind === 'PAYMENT').reduce((s, e) => s + e.amount, 0) + onlinePaid;
  const refunded = entries.filter(e => e.kind === 'REFUND').reduce((s, e) => s + e.amount, 0);
  return { received, refunded, net: received - refunded };
}
