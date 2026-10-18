/**
 * Реєстр виконавців ІІ-менеджера. Імпортується один раз на старті сервера
 * (src/index.ts), щоб у проді виконавці існували, а не лише в тестах: без
 * реєстрації proposeAction відповів би AI_ACTION_UNKNOWN_KIND.
 */
import './bookings';
import './groupSessions';
import './tournaments';
import './reports';
import './winback';

export const EXECUTOR_KINDS = [
  'booking.create', 'booking.cancel', 'booking.reschedule',
  'groupSession.create', 'groupSession.cancel',
  'tournament.buildBracket',
  'report.xlsx',
  'winback.campaign',
] as const;
