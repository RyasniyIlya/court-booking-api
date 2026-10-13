import type { Request, Response, NextFunction } from 'express';

/**
 * Демо-стенд «в один клік»: POST /api/demo/session видає короткий токен
 * фіксованим вигаданим акаунтам (клуб demo-squash-kyiv і федерація squash-demo).
 * Токен несе demo:true, і тут же живе вартовий DEMO_LOCKED: у демо можна
 * бронювати, вести турнір, вносити оплату, але не можна міняти пароль,
 * платіжні й Telegram-налаштування, персонал, тариф і юридичні дані —
 * їх зіпсує або використає проти нас перший, хто натисне кнопку «Демо».
 */

export const DEMO_TTL = '2h';
export const DEMO_CLUB_SLUG = 'demo-squash-kyiv';
export const DEMO_CLUB_EMAIL = 'owner@demo.test';
export const DEMO_FEDERATION_CODE = 'squash-demo';
export const DEMO_FEDERATION_EMAIL = 'federation@demo.test';
/** Перший розділ кабінету федерації (FEDERATION_SECTIONS у вебі). */
export const DEMO_FEDERATION_REDIRECT = '/federation/tournaments';
export const DEMO_CLUB_REDIRECT = '/admin';

/** Вхід у демо вмикає тільки власник змінною середовища (на проді — у Render). */
export const demoLoginEnabled = () => process.env.DEMO_LOGIN === 'true';

type Rule = {
  /** Які методи блокуємо; без поля — усі записуючі. */
  methods?: readonly string[];
  /** Шлях без /api/<scope>, у нижньому регістрі, без кінцевого слеша. */
  re: RegExp;
  /** Блокувати, лише якщо тіло містить хоч одне з цих полів (PATCH /club змішує безпечне з небезпечним). */
  bodyKeys?: readonly string[];
};

/**
 * Кабінет клубу (/api/admin/*). Усе, чого тут немає, у демо дозволено.
 * Кожен рядок покритий тестом у lib/demo.test.ts.
 */
export const CLUB_RULES: readonly Rule[] = [
  // Пароль, пошта, PIN, повторне підтвердження (step-up). Маршрутів email/pin/elevate
  // зараз немає — стоять про запас, щоб поява маршруту не відкрила діру.
  { re: /^\/(password|email|pin|pins|elevate)(\/|$)/ },
  // Персонал і доступи: створення/видалення акаунтів, ролі, запрошення.
  // /staff/:id/shifts (графік змін) — це розклад, а не доступ: лишаємо.
  { re: /^\/staff(\/[^/]+)?$/ },
  { re: /^\/(invites?|invitations?|roles?)(\/|$)/ },
  // Підписка, тариф, рахунки й квитанції про оплату платформі.
  { re: /^\/billing(\/|$)/ },
  // Telegram: прив'язка чату/бота, налаштування бота (тексти, розсилки, повернення клієнтів).
  { re: /^\/telegram(\/|$)/ },
  { re: /^\/bot-settings(\/|$)/ },
  // Реквізити розрахунків, податковий режим.
  { re: /^\/settlement-settings$/ },
  { re: /^\/finance\/tax-regime$/ },
  // Юридичне/ключі/дані партнера: оферта, тест еквайрингу, передача статистики партнеру.
  { re: /^\/club\/(accept-offer|payment-test|share-stats)$/ },
  // Правила рейтингу клубу змінюють рахунок усім наступним відвідувачам демо.
  { re: /^\/players\/rating-rules$/ },
  // Видалення довідників, на яких стоїть уся демо-сітка.
  { methods: ['DELETE'], re: /^\/(courts|trainers)\/[^/]+$/ },
  // Бінарні завантаження: байти потрапляють у прод-БД, а токен демо отримує будь-хто.
  { methods: ['POST', 'PUT'], re: /^\/club\/logo$/ },
  { methods: ['POST', 'PUT'], re: /^\/(courts|trainers)\/[^/]+\/photos$/ },
  { methods: ['POST', 'PUT'], re: /^\/inventory\/[^/]+\/photo$/ },
  // PATCH /club: назва, телефон, години, фон — можна; платіжні поля, чат Telegram,
  // юридичні реквізити, правила клубу, e-mail — ні.
  {
    methods: ['PATCH', 'PUT'],
    re: /^\/club$/,
    bodyKeys: [
      'paymentToken', 'paymentProvider', 'payHoldMinutes', 'prepayEnabled', 'prepayRequired',
      'telegramChatId', 'legalName', 'legalCode', 'legalAddress', 'email',
      'lateCancelFeePercent', 'refundDays', 'extraRules',
    ],
  },
];

/** Кабінет федерації (/api/federation/*). */
export const FEDERATION_RULES: readonly Rule[] = [
  // Налаштування ELO діють на всіх, хто зайде в демо після вас.
  { re: /^\/rating-settings(\/|$)/ },
  { re: /^\/(password|email|account|accounts)(\/|$)/ },
  // Варіант 2 (ПЛАН-ДЕМО-СТЕНД.md): турнір федерації не можна завершити чи відкрити знову —
  // finalizeTournament пише FederationPlayerRating/RatingChange (ELO), а це публічна таблиця
  // федерації. Зараз існує лише POST /tournaments/:id/finish; решта назв — про запас,
  // щоб поява маршруту (finalize/complete/reopen/…) не відкрила діру.
  { methods: ['POST', 'PUT', 'PATCH'], re: /^\/tournaments\/[^/]+\/(finish|finalize|complete|close|reopen|unfinish|revert|rollback|recalc|recalculate|apply-?ratings?)$/ },
  // Узагальнене правило: будь-який запис у рейтинг/ELO федерації.
  { re: /^\/(ratings?|elo)(\/|$)/ },
];

/*
 * Клубний demo-токен: POST /api/admin/tournaments/:id/finish ДОЗВОЛЕНО навмисно.
 * Клубний турнір (tournamentScope=CLUB) нараховує лише клубні очки (ClubPlayerRating
 * + RatingChange клубу) — це «пісочниця» демо-клубу, а демо-стенд кожну ніч
 * перестворюється з нуля (scripts/demo-stand-reset.ts), тож накопичені очки зникають.
 * Турнір федерації клубний токен завершити не може й так (403 FEDERATION_FINALIZES),
 * а reopen для нього віддає 409 RATINGS_LOCKED.
 */

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

/** /api/admin/Staff/ -> { scope: 'admin', path: '/staff' }; не наш префікс -> null. */
function split(url: string): { scope: 'admin' | 'federation'; path: string } | null {
  const clean = url.split('?')[0].split('#')[0].toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const m = /^\/api\/(admin|federation)(\/.*)?$/.exec(clean);
  return m ? { scope: m[1] as 'admin' | 'federation', path: m[2] ?? '/' } : null;
}

/** Чи має demo-токен отримати DEMO_LOCKED на цьому запиті. */
export function isDemoLocked(method: string, url: string, body: unknown): boolean {
  const m = method.toUpperCase();
  if (READ_ONLY.has(m)) return false;
  const target = split(url);
  // Невідомий префікс — це не кабінет; демо-токен там нічого не робить, але й не блокуємо.
  if (!target) return false;
  const rules = target.scope === 'admin' ? CLUB_RULES : FEDERATION_RULES;
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return rules.some((r) => {
    if (r.methods && !r.methods.includes(m)) return false;
    if (!r.re.test(target.path)) return false;
    if (!r.bodyKeys) return true;
    // telegramChatId: null — це «очистити», форма «Клуб» шле його щоразу; блокуємо лише значення.
    return r.bodyKeys.some((k) => k in obj && !(k === 'telegramChatId' && obj[k] === null));
  });
}

export const DEMO_LOCKED_BODY = { error: 'DEMO_LOCKED' } as const;

/**
 * Вартовий для токенів із demo:true. requireAuth / requireFederationAuth
 * викликають його одразу після розбору токена, тож він діє на кожен
 * маршрут, що ходить через них, а не лише на ті, що ми не забули підключити.
 */
export function demoGuard(req: Request, res: Response, next: NextFunction) {
  const isDemo = req.auth?.demo === true || req.federationAuth?.demo === true;
  if (isDemo && isDemoLocked(req.method, req.originalUrl, req.body)) {
    return res.status(403).json(DEMO_LOCKED_BODY);
  }
  next();
}
