import { hashPassword } from '../src/lib/passwordHash.ts';
import { buildBracket, planPropagation, applyPatches } from '../src/lib/tournamentBracket.ts';
import { finalizeTournament } from '../src/lib/tournamentRating.ts';

export async function seedFederationDemo(prisma, mainClub, password) {
  const fed = await prisma.federation.create({ data: { name: 'Федерація сквошу · ДЕМО', code: 'squash-demo',
    accounts: { create: { email: 'federation@demo.test', name: 'Оператор Федерації', passwordHash: await hashPassword(password, 10) } },
    partnerships: { create: { clubId: mainClub.id, status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: 'demo' } } } });
  const second = await prisma.club.create({ data: { name: 'Racket Club · ДЕМО', slug: 'racket-demo', address: 'Львів, демо-адреса',
    federationPartnerships: { create: { federationId: fed.id, status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: 'demo' } } } });
  await prisma.court.create({ data: { clubId: second.id, name: 'Сквош-корт 1', pricePerHour: 0 } });
  const customers = await prisma.customer.findMany({ where: { clubId: mainClub.id }, take: 8, orderBy: { name: 'asc' } });
  const players = [];
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    const p = await prisma.player.create({ data: { name: c.name, phone: c.phone, federationId: fed.id, gender: i % 3 === 0 ? 'FEMALE' : 'MALE',
      ageCategory: 'Adults', skillLevel: ['A', 'B+', 'B', 'C'][i % 4], bio: 'Демонстраційний гравець. Усі дані вигадані.' } });
    await prisma.customer.update({ where: { id: c.id }, data: { playerId: p.id } });
    await prisma.clubPlayerRating.create({ data: { clubId: mainClub.id, playerId: p.id, group: 'Основна', category: 'Amateur',
      ...(i === 0 ? { title: 'Капітан команди', achievements: ['Учасник осіннього кубка'] } : {}) } });
    if (i < 3) await prisma.clubPlayerRating.create({ data: { clubId: second.id, playerId: p.id, category: 'Amateur', group: 'Вечірня' } });
    players.push(p);
  }
  const court = await prisma.court.findFirstOrThrow({ where: { clubId: mainClub.id }, orderBy: { sortOrder: 'asc' } });
  const at = days => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(8, 0, 0, 0); return d; };
  async function event(title, scope, days, participantCount, playedCount) {
    const start = at(days), end = new Date(start.getTime() + 3 * 3600000);
    const b = await prisma.booking.create({ data: { title: `🏆 ${title}`, capacity: participantCount, clubId: mainClub.id, courtId: court.id,
      startTime: start, endTime: end, status: 'CONFIRMED', source: 'ADMIN', priceTotal: 0, pricePerSeat: 0,
      tournamentScope: scope, federationId: scope === 'FEDERATION' ? fed.id : null,
      tournamentStatus: 'RUNNING', tournamentFormat: 'SINGLE_ELIM', thirdPlace: participantCount >= 4,
      tournamentDescription: 'Відкрита демонстрація турнірного процесу: єдиний профіль, посів, сітка, результати та два незалежні рейтинги.',
      tournamentAgeCategory: 'Adults', createdBy: 'demo', confirmedBy: 'demo', confirmedAt: new Date() } });
    const entrants = [];
    for (const [i, p] of players.slice(0, participantCount).entries()) entrants.push(await prisma.tournamentEntry.create({ data: { bookingId: b.id, clubId: mainClub.id, name: p.name, playerId: p.id, seed: i + 1 } }));
    const matches = buildBracket(entrants.map(e => e.id), participantCount >= 4);
    let played = 0;
    for (let i = 0; i < 20 && played < playedCount; i++) {
      const m = matches.find(m => m.entryAId && m.entryBId && !m.winnerEntryId);
      if (!m) break;
      m.status = 'DONE'; m.winnerEntryId = m.entryAId; m.sets = [{ a: 11, b: 7 }, { a: 11, b: 9 }, { a: 11, b: 6 }];
      applyPatches(matches, planPropagation(matches, m.id, m.entryAId, m.entryBId, participantCount >= 4).patches);
      played++;
    }
    await prisma.tournamentMatch.createMany({ data: matches.map(m => ({ ...m, clubId: mainClub.id, bookingId: b.id, version: m.winnerEntryId ? 1 : 0,
      finishedAt: m.winnerEntryId ? start : null, updatedBy: 'demo' })) });
    if (playedCount > 10) await prisma.$transaction(tx => finalizeTournament(tx, b.id, 'demo'), { timeout: 30000 });
    return b;
  }
  await event('Кубок Федерації · завершений', 'FEDERATION', -45, 4, 100);
  await event('Клубний чемпіонат · завершений', 'CLUB', -44, 4, 100);
  const running = await event('Осінній кубок сквошу', 'FEDERATION', 21, 8, 2);
  const draft = await prisma.booking.create({ data: { clubId: mainClub.id, courtId: court.id, title: '🏆 Відкритий турнір Федерації', capacity: 16,
    startTime: at(28), endTime: new Date(at(28).getTime() + 3 * 3600000), status: 'CONFIRMED', source: 'ADMIN', priceTotal: 0, pricePerSeat: 0,
    tournamentScope: 'FEDERATION', federationId: fed.id, tournamentStatus: 'DRAFT', tournamentFormat: 'SINGLE_ELIM', tournamentAgeCategory: 'Adults',
    tournamentDescription: 'Турнір для демонстрації реєстрації гравців і посіву за ELO.' } });
  return { code: fed.code, runningId: running.id, draftId: draft.id, playerId: players[0].id };
}
