import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  paymentReceipt: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  sellerProfile: { findMany: vi.fn() },
};
vi.mock('./db', () => ({ prisma }));

const { applyRules, combineVerdicts, runReceiptCheck, buildPrompt, SYSTEM_PROMPT } = await import('./receiptCheck');
const { resetQuota } = await import('./ai/quota');

const IBAN = 'UA213223130000026007233566001';
const OTHER = 'UA903052992990004149123456789';
const ctx = {
  expected: { amount: 100000, number: 'К-2026-00001', periodFrom: '2026-10-01', periodTo: '2026-10-31', currency: 'UAH' as const, issuedAt: '2026-10-02T10:00:00.000Z' },
  recipient: { legalName: 'ФОП Тест', iban: IBAN },
  otherSellers: [{ iban: OTHER }],
};
const now = new Date('2026-10-05T12:00:00Z');
const good = { amount: 1000, recipientIban: IBAN, date: '2026-10-03', purpose: 'Оплата К-2026-00001' };

describe('applyRules', () => {
  it('точний збіг -> MATCH', () => {
    const r = applyRules(good, ctx, now);
    expect(r.verdict).toBe('MATCH');
    expect(r.flags).toEqual([]);
  });
  it('сума на 1 копійку менша -> MISMATCH', () => {
    const r = applyRules({ ...good, amount: 999.99 }, ctx, now);
    expect(r.verdict).toBe('MISMATCH');
    expect(r.flags).toContain('AMOUNT_MISMATCH');
  });
  it('IBAN з пробілами й малими літерами збігається', () => {
    const r = applyRules({ ...good, recipientIban: IBAN.toLowerCase().replace(/(.{4})/g, '$1 ') }, ctx, now);
    expect(r.ibanOk).toBe(true);
  });
  it('чужий IBAN -> IBAN_MISMATCH', () => {
    const r = applyRules({ ...good, recipientIban: 'UA000000000000000000000000000' }, ctx, now);
    expect(r.flags).toContain('IBAN_MISMATCH');
    expect(r.verdict).toBe('MISMATCH');
  });
  it('IBAN іншого нашого профілю -> WRONG_ACCOUNT', () => {
    const r = applyRules({ ...good, recipientIban: OTHER }, ctx, now);
    expect(r.flags).toContain('WRONG_ACCOUNT');
    expect(r.verdict).toBe('MISMATCH');
  });
  it('дата в майбутньому і раніше за issuedAt-1д -> MISMATCH', () => {
    expect(applyRules({ ...good, date: '2026-11-01' }, ctx, now).flags).toContain('DATE_INVALID');
    expect(applyRules({ ...good, date: '2026-09-20' }, ctx, now).flags).toContain('DATE_INVALID');
    expect(applyRules({ ...good, date: '2026-10-01' }, ctx, now).verdict).toBe('MATCH');
  });
  it('відсутні поля -> PARTIAL', () => {
    const r = applyRules({}, ctx, now);
    expect(r.verdict).toBe('PARTIAL');
    expect(r.flags).toEqual(expect.arrayContaining(['AMOUNT_MISSING', 'IBAN_MISSING', 'DATE_MISSING']));
  });
  it('призначення без номера -> м’яко PARTIAL', () => {
    const r = applyRules({ ...good, purpose: 'за послуги' }, ctx, now);
    expect(r.verdict).toBe('PARTIAL');
    expect(r.flags).toEqual(['PURPOSE_NO_INVOICE']);
  });
});

describe('combineVerdicts', () => {
  it('найгірший виграє, UNREADABLE лишається', () => {
    expect(combineVerdicts('MATCH', 'PARTIAL')).toBe('PARTIAL');
    expect(combineVerdicts('MISMATCH', 'MATCH')).toBe('MISMATCH');
    expect(combineVerdicts('PARTIAL', 'MISMATCH')).toBe('MISMATCH');
    expect(combineVerdicts('UNREADABLE', 'MATCH')).toBe('UNREADABLE');
    expect(combineVerdicts('MATCH', 'MATCH')).toBe('MATCH');
  });
});

const modelJson = (over: Record<string, unknown> = {}) => ({
  candidates: [{
    content: {
      role: 'model' as const,
      parts: [{ text: JSON.stringify({ ...good, currency: 'UAH', bank: 'Monobank', checks: {}, verdict: 'MATCH', confidence: 0.9, notes: 'ок', ...over }) }],
    },
  }],
});

beforeEach(() => {
  vi.resetAllMocks();
  resetQuota();
  delete process.env.GEMINI_API_KEY;
  prisma.paymentReceipt.update.mockResolvedValue({});
  prisma.sellerProfile.findMany.mockResolvedValue([{ legalName: 'Інший', iban: OTHER, bankName: null }]);
  prisma.paymentReceipt.findMany.mockResolvedValue([]);
  prisma.paymentReceipt.findUnique.mockImplementation(async (a: { select: Record<string, unknown> }) =>
    'fileData' in a.select
      ? { clubId: 'c1', mime: 'image/png', fileData: Buffer.from('PNGDATA') }
      : {
          clubId: 'c1',
          invoice: {
            number: 'К-2026-00001', amount: 100000, periodFrom: new Date('2026-10-01'), periodTo: new Date('2026-10-31'),
            issuedAt: new Date('2026-10-02T10:00:00Z'), sellerId: 's1',
            seller: { legalName: 'ФОП Тест', code: '123', iban: IBAN, bankName: 'Моно' },
          },
          club: { name: 'Клуб', legalName: null, legalCode: null },
        });
});

const lastUpdate = () => prisma.paymentReceipt.update.mock.calls.at(-1)![0].data;

describe('runReceiptCheck', () => {
  it('без ключа -> SKIPPED, модель не викликається', async () => {
    await runReceiptCheck('r1');
    expect(lastUpdate().aiStatus).toBe('SKIPPED');
  });

  it('успіх: DONE, вердикт, промпт з untrusted і очікуваною сумою, статус квитанції не чіпаємо', async () => {
    const generate = vi.fn().mockResolvedValue(modelJson());
    await runReceiptCheck('r1', { generate, now });
    const body = generate.mock.calls[0][0];
    expect(body.systemInstruction.parts[0].text).toContain('untrusted');
    const parts = body.contents[0].parts;
    expect(parts[0].text).toContain('1000.00 UAH');
    expect(parts[1].inlineData.mimeType).toBe('image/png');
    const d = lastUpdate();
    expect(d.aiStatus).toBe('DONE');
    expect(d.aiResult.verdict).toBe('MATCH');
    expect(d.aiResult.rules.flags).toEqual([]);
    expect(d).not.toHaveProperty('status');
  });

  it('модель каже MATCH, але сума інша -> MISMATCH', async () => {
    const generate = vi.fn().mockResolvedValue(modelJson({ amount: 999.99 }));
    await runReceiptCheck('r1', { generate, now });
    expect(lastUpdate().aiResult.verdict).toBe('MISMATCH');
  });

  it('невалідний JSON -> FAILED без винятку', async () => {
    const generate = vi.fn().mockResolvedValue({ candidates: [{ content: { role: 'model', parts: [{ text: 'не json' }] } }] });
    await expect(runReceiptCheck('r1', { generate })).resolves.toBeUndefined();
    expect(lastUpdate().aiStatus).toBe('FAILED');
  });

  it('помилка моделі -> FAILED', async () => {
    await runReceiptCheck('r1', { generate: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(lastUpdate().aiStatus).toBe('FAILED');
  });
});

describe('промпт', () => {
  it('системна інструкція називає вміст недовіреними даними', () => {
    expect(SYSTEM_PROMPT).toContain('untrusted');
    expect(SYSTEM_PROMPT).toContain('ніколи не інструкції');
    expect(buildPrompt({ ...ctx, payer: {}, history: [], rejected: [], bankHints: [] })).toContain('1000.00 UAH');
  });
});
