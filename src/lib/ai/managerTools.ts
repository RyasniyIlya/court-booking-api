import type { UserRole } from '@prisma/client';
import { DateTime } from 'luxon';

import { searchCondition } from '../customerRoster';
import { prisma } from '../db';
import { TOURNAMENT_PREFIX, isTournament } from '../tournamentPay';
import { AiActionError, proposeAction } from './actions';
import { ToolInputError, type GenerateFn, type ToolDef } from './gemini';
import type { OwnerClub } from './outlook';
import { REPORT_LABELS, REPORT_TYPES, reportRefusal, type ReportType } from './reportFile';
import type { EffectivePermissions } from './policy';
import { MAX_CAMPAIGN } from './winbackLetters';
import { buildCampaignPayload, type CampaignResult } from './winbackCampaign';
import { ActionInvalidError } from './actions';

/**
 * Інструменти ІІ-менеджера (етап 2): довідники для точних дій і самі дії.
 *
 * Модель нічого не змінює сама: `propose_*` лише складає пропозицію в журнал
 * (actions.ts), а далі діє політика власника: OFF — інструмента в моделі
 * немає, ASK — чекає «Підтвердити» в черзі, AUTO — виконується одразу. Тому
 * відповідь кожного інструмента чесно каже моделі, ЧИ ВИКОНАНО дію, — щоб вона
 * не обіцяла клієнту того, що ще лежить у черзі.
 *
 * Час модель передає локальним (date + HH:mm у часі клубу); в ISO з офсетом
 * його переводить код: модель не повинна рахувати зсув таймзони сама.
 */

export type ProposedAction = {
  id: string;
  kind: string;
  summary: string;
  status: string;
  error: string | null;
  /** Для картки в кабінеті: деталі за видом дії (клієнт, період, учасники) — окрім тексту summary */
  payload?: unknown;
  result?: unknown;
};

export type ManagerContext = {
  requester: { id: string | null; role: UserRole };
  /** Кожну пропозицію віддаємо кабінету карткою під відповіддю. */
  collect(action: ProposedAction): void;
  /**
   * Скільки пропозицій модель може створити за один запит. Без стелі «три кроки» з
   * промпту — лише прохання: вона могла б завалити чергу власника десятками дій.
   * Не задано — без обмеження (тести, старі виклики).
   */
  maxProposals?: number;
};

/** Стеля пропозицій за один запит у чаті кабінету; сводка в Telegram бере 3 (MORNING_BRIEF_MAX_PROPOSALS). */
export const CHAT_MAX_PROPOSALS = 5;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(v: unknown, name: string, max = 200): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new ToolInputError(`${name} is required`);
  return s.slice(0, max);
}

const optStr = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function uuidArg(v: unknown, name: string): string {
  const s = str(v, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw new ToolInputError(`${name} must be an id from the lists`);
  return s;
}

/** date + HH:mm у часі клубу → ISO з офсетом. */
function localIso(date: unknown, time: unknown, tz: string, name: string): string {
  const d = typeof date === 'string' ? date : '';
  const t = typeof time === 'string' ? time : '';
  if (!DATE.test(d) || !TIME.test(t)) throw new ToolInputError(`${name}: date YYYY-MM-DD and time HH:mm required`);
  const dt = DateTime.fromISO(`${d}T${t}`, { zone: tz });
  if (!dt.isValid) throw new ToolInputError(`${name}: invalid date/time`);
  return dt.toISO()!;
}

/** Початок і кінець; кінець «до опівночі» чи за північ (≤ початку) — наступної доби. */
function interval(a: Record<string, unknown>, tz: string) {
  const start = localIso(a.date, a.start_time, tz, 'start');
  /* zone: tz обовʼязково: без неї +1 доба рахується в поясі сервера й зсуває кінець на годину при зміні часу. */
  let endDt = DateTime.fromISO(localIso(a.date, a.end_time, tz, 'end'), { zone: tz });
  const startDt = DateTime.fromISO(start, { zone: tz });
  if (endDt <= startDt) endDt = endDt.plus({ days: 1 });
  return { start, end: endDt.toISO()! };
}

/** Результат пропозиції → відповідь моделі, яка не дозволяє збрехати про виконання. */
function outcome(row: { id: string; kind: string; summary: string; status: string; error: string | null; result?: unknown }, role: UserRole) {
  const base = { action_id: row.id, summary: row.summary, status: row.status };
  if (row.status === 'EXECUTED') {
    return {
      ...base,
      note: row.kind === 'report.xlsx'
        ? 'Файл готовий: власник бачить кнопку «Завантажити» під твоєю відповіддю. Не вигадуй посилань.'
        : row.kind === 'winback.campaign'
          ? winbackNote(row.result)
          : 'Дію виконано.',
    };
  }
  if (row.status === 'FAILED') {
    return { ...base, error: row.error, note: 'Дію НЕ виконано. Скажи причину користувачеві й запропонуй інший варіант.' };
  }
  return {
    ...base,
    note: role === 'OWNER'
      ? 'Дію ЩЕ НЕ виконано: вона чекає підтвердження власника в «Черзі дій» (кнопка під твоєю відповіддю). Так і скажи — не пиши, що зроблено.'
      : 'Дію ЩЕ НЕ виконано: вона чекає підтвердження власника клубу. Так і скажи — не пиши, що зроблено.',
  };
}

/** Листи повернення виконані «одразу», але частина може чекати денного вікна 11:00–20:00 — модель не має казати «надіслано» про відкладене. */
function winbackNote(result: unknown): string {
  const r = result as Partial<CampaignResult> | null;
  const sent = r?.sent ?? 0;
  const queued = r?.queued ?? 0;
  const skipped = r?.skipped ?? 0;
  if (queued > 0) return `Листи затверджено: надіслано ${sent}, ${queued} відправляться в денне вікно 11:00–20:00 за часом клубу, пропущено ${skipped}. Не пиши, що всі вже надіслані.`;
  return `Листи оброблено: надіслано ${sent}, пропущено ${skipped} (клієнт передумав чи змінились умови).`;
}

export function managerTools(club: OwnerClub, perms: EffectivePermissions, ctx: ManagerContext, generate?: GenerateFn): ToolDef[] {
  const tz = club.timezone;
  const dateProp = { type: 'string', description: 'Дата YYYY-MM-DD за часом клубу' };
  const timeProp = (what: string) => ({ type: 'string', description: `${what}, HH:mm за часом клубу` });

  let proposed = 0;
  /* Одна партія листів повернення на запит: друга тільки дублювала б першу й пекла квоту Gemini. */
  let winbackProposed = false;
  async function propose(kind: string, payload: unknown) {
    if (ctx.maxProposals !== undefined && proposed >= ctx.maxProposals) {
      throw new ToolInputError(`Ліміт пропозицій на цей запит (${ctx.maxProposals}) вичерпано. Нових дій не пропонуй — скажи, що решту можна запропонувати окремо.`);
    }
    proposed += 1;
    try {
      const row = await proposeAction({ clubId: club.id, kind, payload, requester: ctx.requester });
      ctx.collect({ id: row.id, kind: row.kind, summary: row.summary, status: row.status, error: row.error, payload: row.payload, result: row.result });
      return outcome(row, ctx.requester.role);
    } catch (e) {
      if (e instanceof AiActionError && e.code === 'AI_ACTION_INVALID') throw new ToolInputError(e.detail ?? 'invalid request');
      if (e instanceof AiActionError && e.code === 'AI_ACTION_FORBIDDEN') throw new ToolInputError('Власник не дозволив цю дію. Скажи про це й не повторюй спроб.');
      throw e;
    }
  }

  return [
    /* ── Довідники ───────────────────────────────────────────────────────── */
    {
      decl: {
        name: 'list_courts',
        description: 'Список активних кортів клубу з id. Потрібен перед будь-якою бронею чи заняттям: корт у дії задається id, а не назвою.',
        parameters: { type: 'object', properties: {} },
      },
      run: async () => {
        const courts = await prisma.court.findMany({
          where: { clubId: club.id, isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true, groupName: true },
        });
        return courts.map((c) => ({ id: c.id, name: c.name, group: c.groupName }));
      },
    },
    {
      decl: {
        name: 'list_bookings',
        description: 'Активні (очікують/підтверджені) броні, групові заняття й турніри за одну добу, з id — щоб скасувати чи перенести саме ту, про яку просять. До 60 записів.',
        parameters: { type: 'object', properties: { date: dateProp }, required: ['date'] },
      },
      run: async (a) => {
        const date = typeof a.date === 'string' ? a.date : '';
        const day = DATE.test(date) ? DateTime.fromISO(date, { zone: tz }) : null;
        if (!day?.isValid) throw new ToolInputError('date must be YYYY-MM-DD');
        const rows = await prisma.booking.findMany({
          where: {
            clubId: club.id,
            status: { in: ['PENDING', 'CONFIRMED'] },
            startTime: { gte: day.startOf('day').toJSDate(), lt: day.endOf('day').toJSDate() },
          },
          orderBy: { startTime: 'asc' },
          take: 60,
          include: { court: { select: { name: true } }, trainer: { select: { name: true } } },
        });
        return rows.map((b) => ({
          id: b.id,
          kind: b.capacity === null ? 'private' : isTournament(b) ? 'tournament' : 'group',
          court: b.court.name,
          court_id: b.courtId,
          start: DateTime.fromJSDate(b.startTime).setZone(tz).toFormat('HH:mm'),
          end: DateTime.fromJSDate(b.endTime).setZone(tz).toFormat('HH:mm'),
          status: b.status,
          title: b.title?.replace(TOURNAMENT_PREFIX, '') ?? undefined,
          /* Імена клієнтів, тренери й ціни — лише в межах відкритих читань. */
          ...(perms.readCustomers && b.customerName ? { customer: b.customerName } : {}),
          ...(perms.readStaff && b.trainer ? { trainer: b.trainer.name } : {}),
          ...(perms.readFinance ? { price_uah: Math.round(b.priceTotal / 100) } : {}),
        }));
      },
    },
    {
      decl: {
        name: 'find_customer',
        description: 'Знайти клієнта за імʼям або телефоном (до 8 збігів) з id, щоб поставити бронь на існуючу картку. Якщо збігів кілька — перепитай, котрий; не вгадуй.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Імʼя або частина телефону, від 2 символів' } }, required: ['query'] },
      },
      run: async (a) => {
        const q = str(a.query, 'query', 80);
        if (q.length < 2) throw new ToolInputError('query is too short');
        const OR = searchCondition(q);
        if (!OR) return [];
        const rows = await prisma.customer.findMany({ where: { clubId: club.id, OR }, take: 8, orderBy: { name: 'asc' }, select: { id: true, name: true, phone: true } });
        return rows;
      },
    },
    {
      decl: {
        name: 'list_trainers',
        description: 'Активні тренери клубу з id — для групового заняття з тренером.',
        parameters: { type: 'object', properties: {} },
      },
      run: async () => prisma.trainer.findMany({
        where: { clubId: club.id, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true },
      }),
    },
    {
      decl: {
        name: 'list_tournaments',
        description: 'Турніри клубу (найближчі й нещодавні) з id, статусом і кількістю учасників — щоб зібрати сітку. status DRAFT = сітку ще не зібрано.',
        parameters: { type: 'object', properties: {} },
      },
      run: async () => {
        const rows = await prisma.booking.findMany({
          where: {
            clubId: club.id,
            title: { startsWith: TOURNAMENT_PREFIX },
            capacity: { not: null },
            status: { in: ['PENDING', 'CONFIRMED'] },
            startTime: { gte: DateTime.now().minus({ days: 30 }).toJSDate() },
          },
          orderBy: { startTime: 'asc' },
          take: 20,
          select: { id: true, title: true, startTime: true, tournamentStatus: true, tournamentTeamSize: true, _count: { select: { tournamentEntries: true } } },
        });
        return rows.map((t) => ({
          id: t.id,
          title: t.title?.replace(TOURNAMENT_PREFIX, ''),
          start: DateTime.fromJSDate(t.startTime).setZone(tz).toFormat('yyyy-MM-dd HH:mm'),
          status: t.tournamentStatus ?? 'DRAFT',
          entries: t._count.tournamentEntries,
          team_size: t.tournamentTeamSize,
        }));
      },
    },

    /* ── Дії ─────────────────────────────────────────────────────────────── */
    {
      decl: {
        name: 'propose_booking',
        description: 'Запропонувати приватну бронь корту. Потрібні корт (id із list_courts), дата, початок, кінець і клієнт: або customer_id (find_customer), або customer_name (+ customer_phone). Якщо чогось із цього не названо — СПОЧАТКУ ЗАПИТАЙ користувача, нічого не вигадуй. Бронь не створена, доки відповідь не каже EXECUTED.',
        parameters: {
          type: 'object',
          properties: {
            court_id: { type: 'string' }, date: dateProp, start_time: timeProp('Початок'), end_time: timeProp('Кінець'),
            customer_id: { type: 'string', description: 'id існуючого клієнта' },
            customer_name: { type: 'string' }, customer_phone: { type: 'string' },
            note: { type: 'string', description: 'Коментар до броні' },
          },
          required: ['court_id', 'date', 'start_time', 'end_time'],
        },
      },
      run: async (a) => propose('booking.create', {
        courtId: uuidArg(a.court_id, 'court_id'),
        ...interval(a, tz),
        customerId: a.customer_id ? uuidArg(a.customer_id, 'customer_id') : undefined,
        customerName: optStr(a.customer_name, 80),
        customerPhone: optStr(a.customer_phone, 30),
        note: optStr(a.note, 300),
      }),
    },
    {
      decl: {
        name: 'propose_cancel_booking',
        description: 'Запропонувати скасування приватної броні (id із list_bookings) з причиною. Оплачені броні ІІ не скасовує. Скасовано лише коли відповідь каже EXECUTED.',
        parameters: { type: 'object', properties: { booking_id: { type: 'string' }, reason: { type: 'string' } }, required: ['booking_id', 'reason'] },
      },
      run: async (a) => propose('booking.cancel', { bookingId: uuidArg(a.booking_id, 'booking_id'), reason: str(a.reason, 'reason') }),
    },
    {
      decl: {
        name: 'propose_reschedule',
        description: 'Запропонувати перенесення приватної броні на новий час і/або корт. booking_id із list_bookings; нова дата й час обовʼязкові; court_id — лише якщо змінюється корт.',
        parameters: {
          type: 'object',
          properties: {
            booking_id: { type: 'string' }, court_id: { type: 'string' },
            date: dateProp, start_time: timeProp('Новий початок'), end_time: timeProp('Новий кінець'),
          },
          required: ['booking_id', 'date', 'start_time', 'end_time'],
        },
      },
      run: async (a) => propose('booking.reschedule', {
        bookingId: uuidArg(a.booking_id, 'booking_id'),
        courtId: a.court_id ? uuidArg(a.court_id, 'court_id') : undefined,
        ...interval(a, tz),
      }),
    },
    {
      decl: {
        name: 'propose_group_session',
        description: 'Запропонувати групове заняття: корт, дата, час, назва, кількість місць, ціна місця в гривнях, тренер (id із list_trainers, необовʼязково). Чого не вистачає — запитай.',
        parameters: {
          type: 'object',
          properties: {
            court_id: { type: 'string' }, date: dateProp, start_time: timeProp('Початок'), end_time: timeProp('Кінець'),
            title: { type: 'string' }, seats: { type: 'integer', description: 'Кількість місць, 2–200' },
            price_uah: { type: 'integer', description: 'Ціна одного місця в гривнях' },
            trainer_id: { type: 'string' },
          },
          required: ['court_id', 'date', 'start_time', 'end_time', 'title', 'seats', 'price_uah'],
        },
      },
      run: async (a) => {
        const seats = Number(a.seats);
        const price = Number(a.price_uah);
        if (!Number.isInteger(seats) || !Number.isInteger(price) || price < 0) throw new ToolInputError('seats and price_uah must be integers');
        return propose('groupSession.create', {
          courtId: uuidArg(a.court_id, 'court_id'),
          ...interval(a, tz),
          title: str(a.title, 'title', 80),
          capacity: seats,
          pricePerSeat: price * 100,
          trainerId: a.trainer_id ? uuidArg(a.trainer_id, 'trainer_id') : undefined,
        });
      },
    },
    {
      decl: {
        name: 'propose_cancel_group_session',
        description: 'Запропонувати скасування групового заняття без записаних учасників (id із list_bookings, kind=group) з причиною.',
        parameters: { type: 'object', properties: { booking_id: { type: 'string' }, reason: { type: 'string' } }, required: ['booking_id', 'reason'] },
      },
      run: async (a) => propose('groupSession.cancel', { bookingId: uuidArg(a.booking_id, 'booking_id'), reason: str(a.reason, 'reason') }),
    },
    {
      decl: {
        name: 'propose_tournament_bracket',
        description: 'Запропонувати зібрати сітку турніру (id із list_tournaments, status DRAFT, ≥ 2 учасників). seeding: keep — порядок складу, shuffle — жеребкування. Після збирання склад вже не змінити.',
        parameters: {
          type: 'object',
          properties: {
            tournament_id: { type: 'string' },
            seeding: { type: 'string', enum: ['keep', 'shuffle'] },
            third_place: { type: 'boolean', description: 'Матч за 3 місце (від 4 учасників)' },
          },
          required: ['tournament_id'],
        },
      },
      run: async (a) => propose('tournament.buildBracket', {
        tournamentId: uuidArg(a.tournament_id, 'tournament_id'),
        seeding: a.seeding === 'shuffle' ? 'shuffle' : 'keep',
        thirdPlace: a.third_place === true,
      }),
    },
    {
      decl: {
        name: 'propose_winback',
        description: `Запропонувати листи в Telegram клієнтам «під ризиком» (давно не грали): код сам вибирає лише тих, хто дав згоду на розсилку, має Telegram і до кого за лімітами клубу вже можна писати, а кожному пишеться короткий особистий лист. Імен і текстів ти не складаєш і не передаєш. До ${MAX_CAMPAIGN} листів; один виклик на запит. Вдень (11:00–20:00 за часом клубу) листи йдуть після рішення, в інший час чекають вікна. Відповідь каже, ЧИ ВІДПРАВЛЕНО.`,
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: `Скільки листів, 1–${MAX_CAMPAIGN}; без значення — 10` },
            min_days_since_visit: { type: 'integer', description: 'Не писати тим, хто був пізніше ніж стільки днів тому' },
          },
        },
      },
      run: async (a) => {
        if (winbackProposed) throw new ToolInputError('Партію листів повернення вже запропоновано в цьому запиті. Нової не пропонуй.');
        const limit = a.limit === undefined ? undefined : Number(a.limit);
        const minDays = a.min_days_since_visit === undefined ? undefined : Number(a.min_days_since_visit);
        if ((limit !== undefined && (!Number.isInteger(limit) || limit < 1)) || (minDays !== undefined && (!Number.isInteger(minDays) || minDays < 0))) {
          throw new ToolInputError('limit and min_days_since_visit must be positive integers');
        }
        let payload;
        try {
          payload = await buildCampaignPayload(club.id, { limit, minDays, generate });
        } catch (e) {
          if (e instanceof ActionInvalidError) throw new ToolInputError(e.message);
          throw e;
        }
        winbackProposed = true;
        return propose('winback.campaign', payload);
      },
    },
    {
      decl: {
        name: 'make_report',
        description: `Сформувати xlsx-звіт за період. type: ${REPORT_TYPES.join(' | ')} (${REPORT_TYPES.map((t) => `${t} — ${REPORT_LABELS[t]}`).join('; ')}). Без дат — останні 30 днів. Звіт клієнтів — це картотека на сьогодні, період до неї не застосовується.`,
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...REPORT_TYPES] },
            from: { type: 'string', description: 'YYYY-MM-DD' },
            to: { type: 'string', description: 'YYYY-MM-DD' },
          },
          required: ['type'],
        },
      },
      run: async (a) => {
        const type = a.type as ReportType;
        if (!REPORT_TYPES.includes(type)) throw new ToolInputError(`type must be one of ${REPORT_TYPES.join(', ')}`);
        /* Закритий звіт відхиляємо тут, до журналу: модель одразу чесно скаже «немає доступу». */
        const refusal = reportRefusal(type, perms);
        if (refusal) throw new ToolInputError(refusal);
        const to = typeof a.to === 'string' && DATE.test(a.to) ? a.to : DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
        const from = typeof a.from === 'string' && DATE.test(a.from) ? a.from : DateTime.fromISO(to, { zone: tz }).minus({ days: 29 }).toFormat('yyyy-MM-dd');
        return propose('report.xlsx', { type, from, to });
      },
    },
  ];
}
