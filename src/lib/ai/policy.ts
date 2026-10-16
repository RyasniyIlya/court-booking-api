import { z } from 'zod';

/**
 * Права ІІ-менеджера: що він може читати й робити в клубі.
 *
 * Задає тільки власник. Чиста логіка без БД: читання/запис рядка — у
 * policyStore.ts, щоб правила перевірялись тестами без моків.
 *
 * ── Принцип ──────────────────────────────────────────────────────────────
 * Права ролі ніколи не ширші за власницькі: ефективне право = перетин
 * («менше з двох»). Тому власник, вимкнувши щось зверху, закриває це для
 * всіх ролей одразу, не чіпаючи кожну окремо. Усе, що не розпізнано (сміття
 * в JSON, невідома роль, нове поле) — закрито: помилка в даних не має
 * відкривати доступ.
 */

export const AI_MODES = ['OFF', 'ASK', 'AUTO'] as const;
export type AiModeValue = (typeof AI_MODES)[number];

/** OFF < ASK < AUTO: у перетині береться менший. */
const MODE_RANK: Record<AiModeValue, number> = { OFF: 0, ASK: 1, AUTO: 2 };
const minMode = (a: AiModeValue, b: AiModeValue): AiModeValue => (MODE_RANK[a] <= MODE_RANK[b] ? a : b);

export const READ_SCOPES = ['readFinance', 'readCustomers', 'readStaff'] as const;
export type ReadScope = (typeof READ_SCOPES)[number];

/** Дії, які ІІ може пропонувати/виконувати; збігається з `scope` виконавців (actions.ts). */
export const ACTION_SCOPES = ['bookings', 'groupSessions', 'tournaments', 'messaging'] as const;
export type ActionScope = (typeof ACTION_SCOPES)[number];

/** Ролі, яким власник може відкрити розмову з ІІ (OWNER має доступ завжди). */
export const DELEGABLE_ROLES = ['ADMIN', 'TRAINER', 'ACCOUNTANT'] as const;
export type DelegableRole = (typeof DELEGABLE_ROLES)[number];

export type AiPermissions = {
  readFinance: boolean;
  readCustomers: boolean;
  readStaff: boolean;
  /** Файли-звіти (xlsx), етап 2 */
  reports: boolean;
  bookings: AiModeValue;
  groupSessions: AiModeValue;
  tournaments: AiModeValue;
  messaging: AiModeValue;
};

export type RolePermissions = AiPermissions & { enabled: boolean };

export type AiPolicy = AiPermissions & {
  roleAccess: Partial<Record<DelegableRole, RolePermissions>>;
};

/** Права з урахуванням ролі. `access:false` — з ІІ говорити не можна взагалі. */
export type EffectivePermissions = AiPermissions & { access: boolean };

export const DEFAULT_PERMISSIONS: AiPermissions = {
  readFinance: true,
  readCustomers: true,
  readStaff: true,
  reports: true,
  bookings: 'ASK',
  groupSessions: 'ASK',
  tournaments: 'ASK',
  messaging: 'ASK',
};

/** Нуль прав: для ролей без доступу й для відсутніх/зіпсованих полів ролі. */
const NO_PERMISSIONS: AiPermissions = {
  readFinance: false,
  readCustomers: false,
  readStaff: false,
  reports: false,
  bookings: 'OFF',
  groupSessions: 'OFF',
  tournaments: 'OFF',
  messaging: 'OFF',
};

export const DEFAULT_POLICY: AiPolicy = { ...DEFAULT_PERMISSIONS, roleAccess: {} };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const mode = (v: unknown, fallback: AiModeValue): AiModeValue =>
  typeof v === 'string' && (AI_MODES as readonly string[]).includes(v) ? (v as AiModeValue) : fallback;

function readPermissions(src: Record<string, unknown>, fallback: AiPermissions): AiPermissions {
  return {
    readFinance: bool(src.readFinance, fallback.readFinance),
    readCustomers: bool(src.readCustomers, fallback.readCustomers),
    readStaff: bool(src.readStaff, fallback.readStaff),
    reports: bool(src.reports, fallback.reports),
    bookings: mode(src.bookings, fallback.bookings),
    groupSessions: mode(src.groupSessions, fallback.groupSessions),
    tournaments: mode(src.tournaments, fallback.tournaments),
    messaging: mode(src.messaging, fallback.messaging),
  };
}

/**
 * Рядок БД (або його відсутність) → політика. Немає рядка — типові права
 * (читання вкл., дії «з підтвердженням»). roleAccess: що не схоже на
 * об'єкт ролі — роль вимкнена; поле ролі без значення — закрите.
 */
export function normalizePolicy(row: Record<string, unknown> | null | undefined): AiPolicy {
  if (!row) return { ...DEFAULT_POLICY, roleAccess: {} };
  const own = readPermissions(row, DEFAULT_PERMISSIONS);
  const roleAccess: AiPolicy['roleAccess'] = {};
  const raw = isRecord(row.roleAccess) ? row.roleAccess : {};
  for (const role of DELEGABLE_ROLES) {
    const entry = raw[role];
    if (!isRecord(entry) || entry.enabled !== true) continue;
    roleAccess[role] = { enabled: true, ...readPermissions(entry, NO_PERMISSIONS) };
  }
  return { ...own, roleAccess };
}

/** Перетин: булеві — «і», режими — менший. */
function intersect(owner: AiPermissions, role: AiPermissions): AiPermissions {
  return {
    readFinance: owner.readFinance && role.readFinance,
    readCustomers: owner.readCustomers && role.readCustomers,
    readStaff: owner.readStaff && role.readStaff,
    reports: owner.reports && role.reports,
    bookings: minMode(owner.bookings, role.bookings),
    groupSessions: minMode(owner.groupSessions, role.groupSessions),
    tournaments: minMode(owner.tournaments, role.tournaments),
    messaging: minMode(owner.messaging, role.messaging),
  };
}

export function effectivePermissions(policy: AiPolicy, role: string): EffectivePermissions {
  if (role === 'OWNER') {
    const { roleAccess: _ignored, ...own } = policy;
    return { ...own, access: true };
  }
  const entry = (DELEGABLE_ROLES as readonly string[]).includes(role) ? policy.roleAccess[role as DelegableRole] : undefined;
  if (!entry?.enabled) return { ...NO_PERMISSIONS, access: false };
  const { enabled: _enabled, ...perms } = entry;
  return { ...intersect(policy, perms), access: true };
}

/**
 * Яке читання потрібне кожному інструменту аналітика. `null` — нейтральний
 * (прогноз броней, завантаження, погода): доступний усім, хто має доступ до ІІ.
 * Нового інструмента тут нема — значить, невідомий: він вимагає ВСІ три читання
 * одразу, тож без повного доступу не з'явиться, доки його не внесуть сюди.
 */
export const toolScope: Record<string, ReadScope | null> = {
  get_day_summary: 'readFinance',
  get_revenue_trend: 'readFinance',
  get_court_report: 'readFinance',
  get_revenue_mix: 'readFinance',
  get_passes_status: 'readFinance',
  get_customer_health: 'readCustomers',
  get_booking_outlook: null,
  get_load_heatmap: null,
  web_lookup: null,
  /* Етап 2: довідкові інструменти менеджера. Поля з іменами, телефонами й тренерами
     гейтяться всередині, коли інструмент нейтральний; список клієнтів і тренерів — цілком. */
  list_courts: null,
  list_bookings: null,
  list_tournaments: null,
  find_customer: 'readCustomers',
  list_trainers: 'readStaff',
  /* Інструменти-дії: читання вони не потребують, їх відкриває режим дії (actionToolAllowed). */
  propose_booking: null,
  propose_cancel_booking: null,
  propose_reschedule: null,
  propose_group_session: null,
  propose_cancel_group_session: null,
  propose_tournament_bracket: null,
  make_report: null,
};

/** Яке право відкриває інструмент-дію. Звіти — булеве `reports`, решта — режим дії. */
export const actionToolScope: Record<string, ActionScope | 'reports'> = {
  propose_booking: 'bookings',
  propose_cancel_booking: 'bookings',
  propose_reschedule: 'bookings',
  propose_group_session: 'groupSessions',
  propose_cancel_group_session: 'groupSessions',
  propose_tournament_bracket: 'tournaments',
  make_report: 'reports',
};

/** Режим права: булеве «звіти» — це або «сам» (вкл), або «заборонено». */
export function scopeMode(perms: AiPermissions, scope: ActionScope | 'reports'): AiModeValue {
  if (scope === 'reports') return perms.reports ? 'AUTO' : 'OFF';
  return perms[scope];
}

/* Навмисно: make_report доступний і TRAINER/ACCOUNTANT, якщо власник відкрив їм `reports` —
   звіти лише читають, а колонки й типи звітів звужуються за правами ролі (reportFile.ts). */
/** Ролі, що руками керують бронями й турнірами; решта (бухгалтер, тренер) модель на дії не наставить. */
const OPERATING_ROLES = ['OWNER', 'ADMIN'];

/**
 * Інструмент-дію модель бачить лише коли режим права НЕ OFF (звіти — коли reports=true) і
 * роль у принципі може це робити. OFF = інструмента для моделі немає взагалі.
 */
export function actionToolAllowed(name: string, perms: EffectivePermissions, role: string): boolean {
  const scope = actionToolScope[name];
  if (!scope) return true;
  if (!perms.access || scopeMode(perms, scope) === 'OFF') return false;
  return scope === 'reports' || OPERATING_ROLES.includes(role);
}

export function toolAllowed(name: string, perms: EffectivePermissions): boolean {
  if (!perms.access) return false;
  if (!(name in toolScope)) return perms.readFinance && perms.readCustomers && perms.readStaff;
  const scope = toolScope[name];
  return scope === null || perms[scope];
}

export function filterTools<T extends { decl: { name: string } }>(tools: T[], perms: EffectivePermissions): T[] {
  return tools.filter((t) => toolAllowed(t.decl.name, perms));
}

/** Повні права власника-за-замовчуванням: для викликів без політики (тести, скрипти). */
export const FULL_ACCESS: EffectivePermissions = { ...DEFAULT_PERMISSIONS, access: true };

/** Тіло PUT /ai/policy. Права ролей зберігаються як є, а обрізаються при читанні:
    підняв власницький рівень назад — права ролі повернулись без повторного налаштування. */
const modeSchema = z.enum(AI_MODES);
const permissionsShape = {
  readFinance: z.boolean(),
  readCustomers: z.boolean(),
  readStaff: z.boolean(),
  reports: z.boolean(),
  bookings: modeSchema,
  groupSessions: modeSchema,
  tournaments: modeSchema,
  messaging: modeSchema,
};
const roleSchema = z.object({ enabled: z.boolean(), ...permissionsShape }).strict();

export const policyBodySchema = z.object({
  ...permissionsShape,
  roleAccess: z.object({
    ADMIN: roleSchema.optional(),
    TRAINER: roleSchema.optional(),
    ACCOUNTANT: roleSchema.optional(),
  }).strict().default({}),
}).strict();

export type PolicyBody = z.infer<typeof policyBodySchema>;

/** Які області закриті — для системного промпту, щоб модель не вигадувала цифри. */
export function closedAreas(perms: EffectivePermissions): string[] {
  const out: string[] = [];
  if (!perms.readFinance) out.push('фінанси й виручка (виручку, оплати, абонементні зобов\'язання не показуй і не оцінюй)');
  if (!perms.readCustomers) out.push('дані про клієнтів і їхній стан');
  if (!perms.readStaff) out.push('дані про персонал і тренерів');
  return out;
}
