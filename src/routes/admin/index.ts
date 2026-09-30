import { Router } from 'express';

import { authRouter } from './auth';
import { bookingsRouter } from './bookings';
import { attendanceRouter } from './attendance';
import { bookingSearchRouter } from './bookingSearch';
import { shiftRouter } from './shift';
import { refundsRouter } from './refunds';
import { settlementsRouter } from './settlements';
import { trainersRouter } from './trainers';
import { courtsRouter } from './courts';
import { orderingRouter } from './ordering';
import { hoursRouter } from './hours';
import { clubRouter } from './club';
import { logoRouter } from './logo';
import { telegramRouter } from './telegram';
import { botSettingsRouter } from './botSettings';
import { billingRouter } from './billing';
import { blocksRouter } from './blocks';
import { customersRouter } from './customers';
import { passesRouter } from './passes';
import { staffRouter } from './staff';
import { staffShiftsRouter } from './staff-shifts';
import { promosRouter } from './promos';
import { inventoryRouter } from './inventory';
import { rentalsRouter } from './rentals';
import { aiRouter } from './ai';
import { requireAuth, blockAccountant } from './shared';

/**
 * /api/admin — кабінет клубу, розрізаний по доменах замість одного
 * монолітного admin.ts на 3500+ рядків. Шляхи й поведінка не змінились,
 * тільки розкладка по файлах: auth (register/login/elevate/me/pins),
 * bookings (+ series), trainers, courts, hours, club, billing, blocks,
 * customers (+ видача абонементів), passes (тарифи, історія, зняття),
 * staff, refunds.
 */
export const adminRouter = Router();

adminRouter.use(authRouter);
/*
 * Бухгалтер (ACCOUNTANT) далі не проходить — усе нижче це бронювання,
 * клієнти, персонал і клуб, а йому належать лише фінанси
 * (окремий роутер, /api/admin/finance, монтується в src/index.ts).
 * authRouter вище лишається доступним: /register, /login — публічні,
 * /me й /password — самообслуговування, потрібне будь-якій ролі.
 */
adminRouter.use(requireAuth, blockAccountant);
/* Пошук перед bookingsRouter: /bookings/search не має впасти в /bookings/:id. */
adminRouter.use(bookingSearchRouter);
adminRouter.use(bookingsRouter);
adminRouter.use(attendanceRouter);
adminRouter.use(refundsRouter);
adminRouter.use(settlementsRouter);
adminRouter.use(shiftRouter);
adminRouter.use(orderingRouter);
adminRouter.use(trainersRouter);
adminRouter.use(courtsRouter);
adminRouter.use(hoursRouter);
adminRouter.use(clubRouter);
/* Перед clubRouter не можна, після — можна: логотип іде сирим тілом
   (express.raw), а решта клубних роутів чекає JSON. Роутер тримає свій
   парсер на власному шляху, тож глобальний express.json його не чіпає. */
adminRouter.use(logoRouter);
adminRouter.use(telegramRouter);
adminRouter.use(botSettingsRouter);
adminRouter.use(billingRouter);
adminRouter.use(blocksRouter);
adminRouter.use(customersRouter);
adminRouter.use(passesRouter);
/* Перед staffRouter: /staff/:id/shifts не має впасти в /staff/:id. */
adminRouter.use(staffShiftsRouter);
adminRouter.use(staffRouter);
adminRouter.use(promosRouter);
/* Перед clubRouter не можна — фото їде сирим тілом, як і логотип: роутер
   тримає свій express.raw на власному шляху. */
adminRouter.use(inventoryRouter);
adminRouter.use(rentalsRouter);
adminRouter.use(aiRouter);

// analytics.ts монтується окремо в index.ts (src/index.ts), але захищає
// свої роути тим самим requireAuth/requireRole, що й кабінет.
export { requireAuth, requireRole, requireFeature } from './shared';
