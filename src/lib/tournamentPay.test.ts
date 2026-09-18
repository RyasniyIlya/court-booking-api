import { describe, expect, it } from 'vitest';
import { isTournament, tournamentPayMode, resolveJoinPayment } from './tournamentPay';

/**
 * Перевіряємо не підписи, а два випадки, через які гроші зникають: турнір
 * «тільки онлайн» у клубі без еквайрингу (реєстрація переходить на
 * оплату в клубі) і турнір «на місці» в клубі з обовʼязковою
 * передоплатою (гравця не можна вести на платіжку).
 */

const group = { capacity: 16, title: 'Ранкова йога' };
const tournament = (method?: string) => ({
  capacity: 16,
  title: '🏆 Осінній кубок',
  paymentPlan: method ? { method } : null,
});

describe('isTournament', () => {
  it('групове заняття турніром не є', () => {
    expect(isTournament(group)).toBe(false);
  });

  it('приватна бронь із маркером у назві — теж ні: у неї немає місць', () => {
    expect(isTournament({ capacity: null, title: '🏆 Осінній кубок' })).toBe(false);
  });

  it('турнір — це місткість плюс маркер', () => {
    expect(isTournament(tournament())).toBe(true);
  });
});

describe('tournamentPayMode', () => {
  it('без налаштування — за правилами клубу', () => {
    expect(tournamentPayMode(tournament())).toBe('CLUB');
    expect(tournamentPayMode(tournament('UNSPECIFIED'))).toBe('CLUB');
  });

  it('онлайн і готівка читаються прямо', () => {
    expect(tournamentPayMode(tournament('ONLINE'))).toBe('ONLINE');
    expect(tournamentPayMode(tournament('CASH'))).toBe('ONSITE');
  });

  it('термінал, переказ і бонуси — це теж оплата в клубі, а не клубні правила', () => {
    expect(tournamentPayMode(tournament('CARD'))).toBe('ONSITE');
    expect(tournamentPayMode(tournament('TRANSFER'))).toBe('ONSITE');
    expect(tournamentPayMode(tournament('BONUS'))).toBe('ONSITE');
  });

  it('у звичайного заняття режиму немає, хоч би що лежало в плані', () => {
    expect(tournamentPayMode({ ...group, paymentPlan: { method: 'ONLINE' } })).toBe('CLUB');
  });
});

describe('resolveJoinPayment', () => {
  const club = { prepayEnabled: true, prepayRequired: false };

  it('безкоштовна участь не питає нічого', () => {
    expect(resolveJoinPayment({ mode: 'CLUB', price: 0, ...club })).toEqual({ online: false });
    expect(resolveJoinPayment({ mode: 'ONLINE', price: 0, prepayEnabled: false, prepayRequired: false }))
      .toEqual({ online: false });
  });

  it('турнір «на місці» сильніший за обовʼязкову передоплату клубу', () => {
    expect(resolveJoinPayment({
      mode: 'ONSITE', price: 50000, prepayEnabled: true, prepayRequired: true,
    })).toEqual({ online: false });
  });

  it('турнір «на місці» не питає гравця про спосіб оплати', () => {
    expect(resolveJoinPayment({ mode: 'ONSITE', price: 50000, ...club })).toEqual({ online: false });
  });

  it('турнір «тільки онлайн» веде на платіжку без питань', () => {
    expect(resolveJoinPayment({ mode: 'ONLINE', price: 50000, ...club })).toEqual({ online: true });
  });

  it('«тільки онлайн» без еквайрингу переходить на оплату в клубі', () => {
    expect(resolveJoinPayment({
      mode: 'ONLINE', price: 50000, prepayEnabled: false, prepayRequired: false,
    })).toEqual({ online: false });
  });

  it('за клубними правилами без вибору гравця — 400, а не мовчазна бронь', () => {
    expect(resolveJoinPayment({ mode: 'CLUB', price: 50000, ...club }))
      .toEqual({ error: 'PAY_CHOICE_REQUIRED' });
    expect(resolveJoinPayment({ mode: 'CLUB', price: 50000, ...club, payChoice: 'online' }))
      .toEqual({ online: true });
    expect(resolveJoinPayment({ mode: 'CLUB', price: 50000, ...club, payChoice: 'onsite' }))
      .toEqual({ online: false });
  });

  it('клуб без еквайрингу вибору не має', () => {
    expect(resolveJoinPayment({
      mode: 'CLUB', price: 50000, prepayEnabled: false, prepayRequired: true,
    })).toEqual({ online: false });
  });

  it('обовʼязкова передоплата клубу не питає нічого', () => {
    expect(resolveJoinPayment({
      mode: 'CLUB', price: 50000, prepayEnabled: true, prepayRequired: true,
    })).toEqual({ online: true });
  });
});
