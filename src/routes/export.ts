import { Router } from 'express';
import { requireAuth, requireRole } from './admin/shared';
import { customersExportHandler, bookingsExportHandler } from './analytics';

/**
 * /api/admin/export — вивантаження бази клубу (броні й клієнти) БЕЗ вартового
 * плану, на відміну від тих самих даних на старому шляху
 * (/api/admin/analytics/{customers,bookings}/export, під requireFeature('analytics')).
 *
 * ── Чому окремий роутер, а не зняти requireFeature з analyticsRouter ────────
 *
 * Уся решта analyticsRouter — це саме аналітика (виручка, завантаження,
 * прогноз) і лишається можливістю тарифу «Аналітика». Вивантаження — інше:
 * це чесна відповідь клубу на «а що, якщо ви зникнете», і вона не може
 * залежати від того, за який пакет клуб платить — інакше обіцянка
 * «підеш із системи з повною базою» стає рекламною, а не справжньою.
 * Тому вартовий тут інший: requireRole('OWNER'), без requireFeature.
 *
 * Обробники (`customersExportHandler`, `bookingsExportHandler`) лишаються в
 * analytics.ts і використовуються тут напряму — той самий код, дві адреси.
 * Старий шлях лишається робочим (уже розгорнуті інтеграції й закладки не
 * ламаються), новий — для владельца на будь-якому тарифі.
 *
 * Стан підписки (пробний/протермінований) тут навмисно не перевіряється:
 * lib/billing.ts вимикає лише онлайн-запис клубу, кабінет — і вивантаження
 * разом із ним — лишається доступним, доки власник не заблокований вручну
 * (isActive === false, те саме, що й для решти кабінету).
 */
export const exportRouter = Router();

exportRouter.use(requireAuth, requireRole('OWNER'));

exportRouter.get('/customers', customersExportHandler);
exportRouter.get('/bookings', bookingsExportHandler);
