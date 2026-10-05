import { describe, expect, it } from 'vitest';

import {
  codeMatchesKind, isValidUaIban, makeUaIban, normalizeIban, partnerReadiness,
  partnerRequisitesSchema, sellerCreateSchema,
} from './partnerRequisites';
import { PARTNER_OFFER_VERSION, buildOfferAcceptance, renderPartnerOffer } from './partnerOffer';
import { parseQuarter, quarterOf, renderActHtml } from './partnerActs';

const IBAN = makeUaIban('300001', '26001234567890');

const seller = {
  id: 's1', kind: 'FOP', label: 'ФОП', legalName: 'ФОП Тест', code: '1234567890', taxInfo: null,
  iban: IBAN, bankName: 'Банк', address: 'Київ', signerName: 'Тест Т.Т.', signerBasis: 'виписки з ЄДР',
  email: 's@x.ua', phone: null,
};

describe('IBAN і коди', () => {
  it('генерований IBAN проходить mod-97, довжина 29', () => {
    expect(IBAN).toMatch(/^UA\d{27}$/);
    expect(isValidUaIban(IBAN)).toBe(true);
  });

  it('пробіли й нижній регістр нормалізуються', () => {
    const spaced = IBAN.toLowerCase().replace(/(.{4})/g, '$1 ');
    expect(normalizeIban(spaced)).toBe(IBAN);
    expect(isValidUaIban(spaced)).toBe(true);
  });

  it('невірна контрольна сума, довжина, країна — відхиляються', () => {
    const last = Number(IBAN.at(-1));
    expect(isValidUaIban(IBAN.slice(0, -1) + String((last + 1) % 10))).toBe(false);
    expect(isValidUaIban(IBAN.slice(0, -1))).toBe(false);
    expect(isValidUaIban('PL' + IBAN.slice(2))).toBe(false);
    expect(isValidUaIban('')).toBe(false);
    expect(isValidUaIban('UA' + 'x'.repeat(27))).toBe(false);
  });

  it('ФОП/фізособа — 10 цифр, ТОВ — 8', () => {
    expect(codeMatchesKind('FOP', '1234567890')).toBe(true);
    expect(codeMatchesKind('FOP', '12345678')).toBe(false);
    expect(codeMatchesKind('INDIVIDUAL', '1234567890')).toBe(true);
    expect(codeMatchesKind('TOV', '12345678')).toBe(true);
    expect(codeMatchesKind('TOV', '1234567890')).toBe(false);
    expect(codeMatchesKind('TOV', '1234567a')).toBe(false);
  });

  it('форма реквізитів партнера: код за видом і IBAN', () => {
    const ok = {
      kind: 'TOV', legalName: 'ТОВ Буд', legalCode: '12345678', iban: IBAN, signerName: 'Іван І.',
      docsEmail: 'D@X.ua', kvedConfirmed: true,
    };
    const parsed = partnerRequisitesSchema.safeParse(ok);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.docsEmail).toBe('d@x.ua');
    expect(partnerRequisitesSchema.safeParse({ ...ok, legalCode: '1234567890' }).success).toBe(false);
    expect(partnerRequisitesSchema.safeParse({ ...ok, iban: 'UA00' }).success).toBe(false);
    expect(partnerRequisitesSchema.safeParse({ ...ok, kind: 'INDIVIDUAL' }).success).toBe(false);
    expect(partnerRequisitesSchema.safeParse({ ...ok, hacked: 1 }).success).toBe(false);
  });

  it('профіль отримувача: фізособа з 10 цифрами, IBAN обовʼязково валідний', () => {
    const base = { kind: 'INDIVIDUAL', label: 'Фізособа', legalName: 'Іван Іванов', code: '1234567890', iban: IBAN };
    expect(sellerCreateSchema.safeParse(base).success).toBe(true);
    expect(sellerCreateSchema.safeParse({ ...base, iban: 'UA123' }).success).toBe(false);
    expect(sellerCreateSchema.safeParse({ ...base, kind: 'TOV' }).success).toBe(false);
  });
});

describe('готовність партнера', () => {
  const full = {
    kind: 'FOP' as const, legalName: 'ФОП П', legalCode: '1234567890', iban: IBAN, signerName: 'П П',
    docsEmail: 'd@x.ua', kvedConfirmed: true,
  };

  it('порожній — усе в missing', () => {
    const r = partnerReadiness({});
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(['kind', 'legalName', 'legalCode', 'iban', 'signerName', 'docsEmail', 'kvedConfirmed', 'contract']);
  });

  it('оферта: потрібен акцепт; індивідуальний: номер і дата', () => {
    expect(partnerReadiness({ ...full, contractMode: 'PUBLIC_OFFER' }).missing).toEqual(['contract']);
    expect(partnerReadiness({ ...full, contractMode: 'PUBLIC_OFFER', offerAcceptedAt: new Date() }).ready).toBe(true);
    expect(partnerReadiness({ ...full, contractMode: 'INDIVIDUAL', contractNo: '5' }).missing).toEqual(['contract']);
    expect(partnerReadiness({ ...full, contractMode: 'INDIVIDUAL', contractNo: '5', contractDate: new Date() }).ready).toBe(true);
  });

  it('галочка КВЕД і валідний IBAN обовʼязкові', () => {
    const base = { ...full, contractMode: 'PUBLIC_OFFER' as const, offerAcceptedAt: new Date() };
    expect(partnerReadiness({ ...base, kvedConfirmed: false }).missing).toEqual(['kvedConfirmed']);
    expect(partnerReadiness({ ...base, iban: 'UA00' }).missing).toEqual(['iban']);
    expect(partnerReadiness({ ...base, kind: 'TOV' }).missing).toEqual(['legalCode']);
  });
});

describe('оферта', () => {
  it('усі значення екрануються (продавець і партнер)', () => {
    const html = renderPartnerOffer(
      { ...seller, legalName: '<script>alert(1)</script>ФОП', address: '"><img src=x onerror=1>' },
      { legalName: '<b>Партнер</b> & Co', legalCode: '1234567890', signerName: "O'Neil <i>", vatPayer: true },
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Партнер');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;ФОП');
    expect(html).toContain('&lt;b&gt;Партнер&lt;/b&gt; &amp; Co');
    expect(html).toContain('O&#39;Neil &lt;i&gt;');
    expect(html).toContain('платник ПДВ');
    expect(html).not.toContain('{{');
  });

  it('порожні поля — прочерк; версія в тексті; є пункт про пріоритет індивідуального договору', () => {
    const html = renderPartnerOffer(seller, {});
    expect(html).toContain(PARTNER_OFFER_VERSION);
    expect(html).toContain('індивідуальний договір, він має пріоритет');
    expect(html).toContain('—');
  });

  it('знімок акцепту містить обидві сторони й версію', () => {
    const at = new Date('2026-10-03T10:00:00Z');
    const d = buildOfferAcceptance(seller, { id: 'p', legalName: 'ФОП П', iban: IBAN }, '1.2.3.4', at);
    expect(d).toMatchObject({ contractMode: 'PUBLIC_OFFER', offerVersion: PARTNER_OFFER_VERSION, offerIp: '1.2.3.4', offerAcceptedAt: at });
    expect(d.offerSnapshot).toMatchObject({ version: PARTNER_OFFER_VERSION, acceptedAt: at.toISOString(), seller: { legalName: 'ФОП Тест' }, partner: { id: 'p', legalName: 'ФОП П' } });
  });
});

describe('квартал і друк акта', () => {
  it('квартал за Києвом: межі [from, to)', () => {
    const q = parseQuarter('2026-Q3')!;
    expect(q.from.toISOString()).toBe('2026-06-30T21:00:00.000Z');
    expect(q.to.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(quarterOf(new Date('2026-09-30T20:59:59Z'))).toBe('2026-Q3');
    expect(quarterOf(new Date('2026-09-30T21:00:00Z'))).toBe('2026-Q4');
    expect(parseQuarter('2026-Q5')).toBeNull();
    expect(parseQuarter('2026-3')).toBeNull();
  });

  it('HTML акта екранує клуби, реквізити сторін і номер', () => {
    const q = parseQuarter('2026-Q3')!;
    const html = renderActHtml({
      number: 'А-2026-Q3-<0001>', periodFrom: q.from, periodTo: q.to, amount: 123456, status: 'ISSUED',
      lines: [{ clubId: 'c', clubName: '<img src=x onerror=alert(1)>', invoiceId: 'abcdef12-0000', paidAt: '2026-07-10T10:00:00Z', invoiceAmount: 200000, rate: 50, commission: 100000 }],
      sellerSnapshot: { ...seller, legalName: '<script>1</script>' },
      partnerSnapshot: { legalName: 'Партнер "X" & <b>', legalCode: '1234567890', signerName: '<u>S</u>', contract: { mode: 'INDIVIDUAL', contractNo: '<7>', contractDate: '2026-01-05T00:00:00Z' } },
    });
    expect(html).not.toMatch(/<img|<script|<u>|Партнер "X" & <b>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;1&lt;/script&gt;');
    expect(html).toContain('Партнер &quot;X&quot; &amp; &lt;b&gt;');
    expect(html).toContain('№ &lt;7&gt;');
    expect(html).toContain('А-2026-Q3-&lt;0001&gt;');
    expect(html).toContain('1 234,56');
  });
});
