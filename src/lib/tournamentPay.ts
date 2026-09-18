/**
 * Як платять за участь у турнірі.
 *
 * У клубу є свої правила на всі броні одразу: увімкнений еквайринг і
 * «передоплата обовʼязкова». Турніру цього мало. Один клуб збирає внесок
 * тільки онлайн, бо сітка друкується напередодні і місце без грошей —
 * це дірка в сітці. Інший так само твердо бере готівку на місці, бо
 * призовий фонд лежить у касі. Обидва турніри живуть в одному клубі і в
 * один тиждень, тож правило має бути в події, а не в налаштуваннях клубу.
 *
 * Режим лежить у `Booking.paymentPlan.method` — тому самому полі, де у
 * приватної броні записана домовленість про оплату. Свого поля турнір не
 * отримав навмисно: він і сам зберігається груповою бронню з маркером у
 * назві, і ще одна колонка заради трьох значень означала б міграцію
 * робочої таблиці броней (див. ГРУПОВІ-ЗАНЯТТЯ.md).
 *
 * Дзеркало web/src/lib/tournamentPayment.js: гравець у віджеті і сервер
 * мають однаково відповідати на питання «мене пустять без оплати?».
 */

/** Той самий маркер, що й у web/src/lib/booking.js. */
export const TOURNAMENT_PREFIX = '🏆 ';

/**
 * Назва турніру з маркером — рівно один раз.
 *
 * Дзеркало web/src/lib/booking.js: саме за цим префіксом старий API
 * відрізняє турнір від звичайного групового заняття, і людина, яка
 * стерла емодзі з поля назви, не мала на увазі «перетвори це на йогу».
 */
export function tournamentTitle(title: string): string {
  const clean = String(title ?? '').trim().replace(/^🏆s*/u, '');
  return `${TOURNAMENT_PREFIX}${clean}`;
}

export function isTournament(b: { capacity?: number | null; title?: string | null }): boolean {
  return b.capacity != null && String(b.title ?? '').startsWith(TOURNAMENT_PREFIX);
}

/**
 * Три режими, а не шість способів оплати.
 *
 * `paymentPlan.method` вміє ще CARD, TRANSFER і BONUS — це способи, якими
 * адміністратор приймає гроші РУКАМИ, і для реєстрації всі вони означають
 * одне: гравець платить у клубі, а не в банківському вікні. Тому вони
 * зводяться до ONSITE, а не провалюються назад у клубні правила: клуб,
 * який обрав «переказом», точно не мав на увазі «як вийде».
 */
export type TournamentPayMode = 'CLUB' | 'ONLINE' | 'ONSITE';

export function tournamentPayMode(b: {
  capacity?: number | null;
  title?: string | null;
  paymentPlan?: unknown;
}): TournamentPayMode {
  if (!isTournament(b)) return 'CLUB';
  const method = (b.paymentPlan as { method?: string } | null)?.method;
  if (method === 'ONLINE') return 'ONLINE';
  if (method === 'CASH' || method === 'CARD' || method === 'TRANSFER' || method === 'BONUS') return 'ONSITE';
  return 'CLUB';
}

export type JoinPayment =
  | { online: boolean; error?: undefined }
  | { online?: undefined; error: 'PAY_CHOICE_REQUIRED' | 'ONLINE_PAYMENT_UNAVAILABLE' };

/**
 * Платить гравець зараз чи в клубі — і чи взагалі можна його записати.
 *
 * Режим турніру сильніший за клубні правила в обидва боки, і це навмисно:
 * поставити «на місці» турніру в клубі з обовʼязковою передоплатою — це
 * не помилка, а нормальний випадок дитячого турніру, де внески збирає
 * тренер. Якщо онлайн-оплата недоступна, реєстрацію не блокуємо: учасник
 * записується з оплатою в клубі, а модератор бачить несплачений внесок.
 */
export function resolveJoinPayment(input: {
  mode: TournamentPayMode;
  price: number;
  prepayEnabled: boolean;
  prepayRequired: boolean;
  payChoice?: string | null;
}): JoinPayment {
  const { mode, price, prepayEnabled, prepayRequired, payChoice } = input;

  // Безкоштовна участь нічого не питає й нічого не тримає під оплату.
  if (price <= 0) return { online: false };

  if (mode === 'ONSITE') return { online: false };
  if (mode === 'ONLINE') {
    return { online: prepayEnabled };
  }

  if (!prepayEnabled) return { online: false };
  if (prepayRequired) return { online: true };
  if (payChoice !== 'online' && payChoice !== 'onsite') return { error: 'PAY_CHOICE_REQUIRED' };
  return { online: payChoice === 'online' };
}
