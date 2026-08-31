import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { clubDayBounds, digestText, hrn } from './digest';

/**
 * Межі доби й текст зведення.
 *
 * Найважливіше тут — таймзона. Render живе в UTC, і київський вечір там
 * уже наступний день: власник о 23:00 отримав би цифри завтрашнього дня,
 * тобто нулі. Ці перевірки падуть, якщо хтось замінить розрахунок на
 * new Date() без зони.
 */

describe('clubDayBounds — доба рахується в зоні клубу, а не сервера', () => {
  /* 22:30 у Києві 27 серпня = 19:30 UTC. Доба клубу має початись
     26.08 21:00 UTC (тобто 27.08 00:00 за Києвом), а не 27.08 00:00 UTC. */
  const kyivEvening = DateTime.fromISO('2026-08-27T19:30:00Z');

  it('вечір у Києві належить київському, а не UTC-дню', () => {
    const { from, to } = clubDayBounds('Europe/Kyiv', kyivEvening);

    expect(DateTime.fromJSDate(from).setZone('Europe/Kyiv').toFormat('dd.MM HH:mm'))
      .toBe('27.08 00:00');
    expect(DateTime.fromJSDate(to).setZone('Europe/Kyiv').toFormat('dd.MM HH:mm'))
      .toBe('27.08 23:59');
  });

  it('та сама мить в іншій зоні дає інший день', () => {
    /* 19:30 UTC — це вже 28-ме в Києві? Ні. А от у Лісабоні (UTC+1 влітку)
       це 20:30 того ж дня. Перевіряємо, що зона справді враховується, а не
       ігнорується. */
    const kyiv = clubDayBounds('Europe/Kyiv', kyivEvening);
    const lisbon = clubDayBounds('Europe/Lisbon', kyivEvening);

    expect(kyiv.from.getTime()).not.toBe(lisbon.from.getTime());
  });

  it('початок доби завжди раніший за кінець', () => {
    const { from, to } = clubDayBounds('Europe/Kyiv', kyivEvening);
    expect(from.getTime()).toBeLessThan(to.getTime());
  });
});

describe('hrn — копійки в гривні', () => {
  it('45000 копійок це 450 грн', () => {
    expect(hrn(45_000)).toBe('450 грн');
  });

  it('нуль лишається нулем, а не порожнечею', () => {
    expect(hrn(0)).toBe('0 грн');
  });
});

describe('digestText — що бачить власник', () => {
  const base = {
    from: DateTime.fromISO('2026-08-27T00:00:00', { zone: 'Europe/Kyiv' }).toJSDate(),
    to: DateTime.fromISO('2026-08-27T23:59:59', { zone: 'Europe/Kyiv' }).toJSDate(),
    bookings: 7,
    revenue: 315_000,
    newCustomers: 2,
    topCourt: { name: 'Корт 1', bookings: 4 },
  };

  it('день із бронями показує всі чотири числа', () => {
    const t = digestText('Squash Arena', base, 'Europe/Kyiv');
    expect(t).toContain('Squash Arena');
    expect(t).toContain('27.08');
    expect(t).toContain('7 броней');
    /* Звіряємось із самою hrn(), а не з написаним від руки рядком: uk-UA
       розділяє тисячі НЕРОЗРИВНИМ пробілом, і копія з клавіатури ніколи
       з ним не збіжиться. */
    expect(t).toContain(hrn(315_000));
    expect(t).toContain('2 нові клієнти');
    expect(t).toContain('Корт 1');
  });

  it('день тижня написаний словом — це шапка картки, а не клітинка таблиці', () => {
    /* 27.08.2026 — четвер. Якщо WEEKDAY_FULL колись зсунеться на день,
       падає саме тут. */
    expect(digestText('Squash Arena', base, 'Europe/Kyiv')).toContain('четвер');
  });

  it('порівняння з попереднім днем зʼявляється тільки коли є з чим', () => {
    const withPrev = digestText('Squash Arena', { ...base, prevRevenue: 280_000 }, 'Europe/Kyiv');
    expect(withPrev).toContain('↑ 13%');

    /* Без учорашнього числа рядка немає взагалі — «↑ 0%» від нуля збрехало б. */
    expect(digestText('Squash Arena', base, 'Europe/Kyiv')).not.toContain('до попереднього дня');
  });

  /* Порожній день — окреме речення, а не чотири нулі. Нулі читаються як
     «щось зламалось», фраза — як відповідь на питання. */
  it('порожній день не показує нулі', () => {
    const t = digestText('Squash Arena', { ...base, bookings: 0, revenue: 0, newCustomers: 0, topCourt: null }, 'Europe/Kyiv');
    expect(t).toContain('поки немає');
    expect(t).not.toContain('💰');
  });

  it('без кортів рядок про найзавантаженіший просто зникає', () => {
    const t = digestText('Squash Arena', { ...base, topCourt: null }, 'Europe/Kyiv');
    expect(t).not.toContain('🏟');
    expect(t).toContain('7 броней');
  });

  it('нуль нових клієнтів не займає рядок порожнім числом', () => {
    const t = digestText('Squash Arena', { ...base, newCustomers: 0 }, 'Europe/Kyiv');
    expect(t).not.toContain('👤');
    expect(t).toContain('7 броней');
  });
});
