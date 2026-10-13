import { describe, expect, it } from 'vitest';
import { isDemoLocked } from './demo';

/* Вартовий демо-токена: кожна небезпечна група заблокована, робочі дії — ні. */
const A = '/api/admin';
const F = '/api/federation';

describe('isDemoLocked: кабінет клубу — заблоковано', () => {
  it.each([
    // пароль / пошта / PIN / step-up
    ['POST', `${A}/password`], ['POST', `${A}/email`], ['POST', `${A}/pin`], ['PUT', `${A}/pins/1`], ['POST', `${A}/elevate`],
    // персонал, ролі, запрошення, створення/видалення акаунтів
    ['POST', `${A}/staff`], ['DELETE', `${A}/staff/3f2a`], ['POST', `${A}/invites`], ['PATCH', `${A}/roles/1`],
    // підписка, тариф, рахунки, квитанції
    ['POST', `${A}/billing/invoice`], ['POST', `${A}/billing/invoice/5/receipt`],
    // Telegram
    ['POST', `${A}/telegram/link`], ['DELETE', `${A}/telegram`], ['PUT', `${A}/bot-settings`], ['POST', `${A}/bot-settings/preview`],
    // реквізити розрахунків і податки
    ['PUT', `${A}/settlement-settings`], ['PATCH', `${A}/finance/tax-regime`],
    // оферта, еквайринг, дані партнеру
    ['POST', `${A}/club/accept-offer`], ['POST', `${A}/club/payment-test`], ['PUT', `${A}/club/share-stats`],
    // правила рейтингу клубу
    ['PUT', `${A}/players/rating-rules`],
    // видалення кортів і тренерів
    ['DELETE', `${A}/courts/9`], ['DELETE', `${A}/trainers/9`],
    // бінарні завантаження
    ['POST', `${A}/club/logo`], ['POST', `${A}/courts/9/photos`], ['POST', `${A}/trainers/9/photos`], ['POST', `${A}/inventory/9/photo`],
  ])('%s %s', (method, url) => {
    expect(isDemoLocked(method, url, {})).toBe(true);
  });

  it.each([
    'paymentToken', 'paymentProvider', 'payHoldMinutes', 'prepayEnabled', 'prepayRequired', 'legalName', 'legalCode',
    'legalAddress', 'email', 'lateCancelFeePercent', 'refundDays', 'extraRules',
  ])('PATCH /club з полем %s', (key) => {
    expect(isDemoLocked('PATCH', `${A}/club`, { name: 'X', [key]: 'v' })).toBe(true);
  });

  it('PATCH /club: telegramChatId зі значенням заблоковано, зі значенням null — ні', () => {
    expect(isDemoLocked('PATCH', `${A}/club`, { telegramChatId: '-1001' })).toBe(true);
    expect(isDemoLocked('PATCH', `${A}/club`, { name: 'X', telegramChatId: null })).toBe(false);
  });

  it('регістр, зайві слеші, слеш у кінці та query не обходять правило', () => {
    expect(isDemoLocked('POST', '/API/Admin/Password', {})).toBe(true);
    expect(isDemoLocked('POST', '/api//admin/password/', {})).toBe(true);
    expect(isDemoLocked('POST', `${A}/password?x=1`, {})).toBe(true);
    expect(isDemoLocked('DELETE', `${A}/staff/3f2a/`, {})).toBe(true);
  });
});

describe('isDemoLocked: кабінет федерації — заблоковано', () => {
  it.each([['PUT', `${F}/rating-settings`], ['POST', `${F}/rating-settings/reset`], ['POST', `${F}/password`]])('%s %s', (method, url) => {
    expect(isDemoLocked(method, url, {})).toBe(true);
  });
});

describe('isDemoLocked: федерація — завершення турніру й ELO (варіант 2)', () => {
  it.each([
    ['POST', `${F}/tournaments/1/finish`], ['POST', `${F}/tournaments/1/finish/`], ['POST', `${F}/Tournaments/abc/FINISH?x=1`],
    ['POST', `${F}/tournaments/1/finalize`], ['POST', `${F}/tournaments/1/complete`], ['POST', `${F}/tournaments/1/reopen`],
    ['POST', `${F}/tournaments/1/rollback`], ['PUT', `${F}/tournaments/1/finish`], ['POST', `${F}/ratings`], ['PATCH', `${F}/elo/5`],
  ])('%s %s', (method, url) => {
    expect(isDemoLocked(method, url, {})).toBe(true);
  });

  it('клубний finish (адмін-шлях з тією самою назвою) правилом федерації не зачеплено', () => {
    expect(isDemoLocked('POST', `${A}/tournaments/1/finish`, {})).toBe(false);
  });

  it('читання турніру й ELO дозволено', () => {
    expect(isDemoLocked('GET', `${F}/tournaments/1/finish`, {})).toBe(false);
    expect(isDemoLocked('GET', `${F}/ratings`, {})).toBe(false);
  });
});

describe('isDemoLocked: дозволено', () => {
  it.each([
    ['POST', `${A}/bookings`], ['PATCH', `${A}/bookings/1`], ['POST', `${A}/bookings/1/refund`], ['POST', `${A}/bookings/1/settlements`],
    ['POST', `${A}/customers/1/passes`], ['PATCH', `${A}/customers/1`], ['POST', `${A}/tournaments/1/start`],
    ['PATCH', `${A}/tournaments/matches/1`], ['POST', `${A}/shift/close`], ['PUT', `${A}/hours`], ['POST', `${A}/courts`],
    ['PATCH', `${A}/courts/9`], ['POST', `${A}/trainers`], ['PATCH', `${A}/trainers/9`], ['POST', `${A}/promos`],
    ['PUT', `${A}/staff/3f2a/shifts/2026-10-13`], ['DELETE', `${A}/staff/3f2a/shifts/2026-10-13`], ['PUT', `${A}/staff/3f2a/shifts/hours`],
    ['POST', `${A}/analytics/expenses`], ['POST', `${A}/ai/chat`], ['DELETE', `${A}/courts/9/photos/4`],
    ['POST', `${F}/tournaments`], ['PUT', `${F}/tournaments/1/entries`], ['POST', `${F}/tournaments/1/start`],
    ['POST', `${F}/tournaments/1/withdraw/2`],
    // клубний турнір завершувати в демо можна: очки клубні, стенд скидається щоночі
    ['POST', `${A}/tournaments/1/finish`], ['POST', `${A}/tournaments/1/reopen`],
    ['POST', `${F}/players`], ['POST', `${F}/import`], ['PATCH', `${F}/players/1`],
  ])('%s %s', (method, url) => {
    expect(isDemoLocked(method, url, {})).toBe(false);
  });

  it('PATCH /club з безпечними полями', () => {
    expect(isDemoLocked('PATCH', `${A}/club`, { name: 'X', phone: '+380', brandColor: '#112233', sports: ['SQUASH'], slotMinutes: 45 })).toBe(false);
  });

  it('читання не блокується ніколи, навіть на «небезпечних» шляхах (експорт вигаданих даних теж дозволено)', () => {
    for (const url of [`${A}/staff`, `${A}/billing`, `${A}/password`, `${F}/rating-settings`, `${A}/export/customers`]) {
      expect(isDemoLocked('GET', url, {})).toBe(false);
      expect(isDemoLocked('HEAD', url, {})).toBe(false);
      expect(isDemoLocked('OPTIONS', url, {})).toBe(false);
    }
  });

  it('чужі префікси не чіпає', () => {
    expect(isDemoLocked('POST', '/api/public/bookings', {})).toBe(false);
  });
});
