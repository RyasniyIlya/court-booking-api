import { planFeatures } from './plans';
import { DateTime } from 'luxon';

import { prisma } from './db';
import { sendMessage } from './telegram';

/**
 * Сказати тренеру, що його викликають на заняття.
 *
 * Окремо від notifyClub: та шле в СПІЛЬНУ групу клубу все підряд, і тренер
 * там побачив би чужі броні й виручку. Це — особистий чат конкретної
 * людини, і в ньому лише її заняття.
 *
 * Тихо нічого не робить, якщо тренер не підключив бота: підключення
 * добровільне, і бронь не має падати через те, що людина його не зробила.
 */
export async function notifyTrainerBooked(params: {
  trainerId: string;
  startTime: Date;
  endTime: Date;
  courtName: string;
  customerName: string | null;
  customerPhone: string | null;
}) {
  const { trainerId, startTime, endTime, courtName, customerName, customerPhone } = params;

  /* Шукаємо АКАУНТ, прив'язаний до цієї картки тренера, і заразом тягнемо
     таймзону клубу. Формат часу рахуємо тут, а не в роутах: інакше кожен,
     хто захоче повідомити тренера, мусив би сам дістати клуб і зібрати
     рядок — а їх уже два, і вони збиралися по-різному.
     Картка й акаунт — різні сутності: у клубі може бути тренер у розкладі,
     який кабінетом не користується взагалі. */
  const account = await prisma.user.findFirst({
    where: { trainerId, tgChatId: { not: null } },
    select: { tgChatId: true, club: { select: { timezone: true, plan: true } } },
  });

  if (!account?.tgChatId || !planFeatures(account.club.plan).telegram) return;

  const tz = account.club.timezone;
  const when = `${DateTime.fromJSDate(startTime).setZone(tz).toFormat('dd.MM HH:mm')}–`
    + `${DateTime.fromJSDate(endTime).setZone(tz).toFormat('HH:mm')}`;

  const lines = [
    '<b>Вас записали на заняття</b>',
    '',
    when,
    courtName,
    customerName ? `Клієнт: ${customerName}` : '',
    customerPhone ? `Телефон: ${customerPhone}` : '',
  ].filter(Boolean);

  await sendMessage(account.tgChatId, lines.join('\n'));
}
