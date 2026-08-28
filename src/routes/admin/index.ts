import { Router } from 'express';

import { authRouter } from './auth';
import { bookingsRouter } from './bookings';
import { refundsRouter } from './refunds';
import { trainersRouter } from './trainers';
import { courtsRouter } from './courts';
import { hoursRouter } from './hours';
import { clubRouter } from './club';
import { logoRouter } from './logo';
import { telegramRouter } from './telegram';
import { billingRouter } from './billing';
import { blocksRouter } from './blocks';
import { customersRouter } from './customers';
import { staffRouter } from './staff';

/**
 * /api/admin — кабінет клубу, розрізаний по доменах замість одного
 * монолітного admin.ts на 3500+ рядків. Шляхи й поведінка не змінились,
 * тільки розкладка по файлах: auth (register/login/elevate/me/pins),
 * bookings (+ series), trainers, courts, hours, club, billing, blocks,
 * customers (+ passes), staff, refunds.
 */
export const adminRouter = Router();

adminRouter.use(authRouter);
adminRouter.use(bookingsRouter);
adminRouter.use(refundsRouter);
adminRouter.use(trainersRouter);
adminRouter.use(courtsRouter);
adminRouter.use(hoursRouter);
adminRouter.use(clubRouter);
/* Перед clubRouter не можна, після — можна: логотип іде сирим тілом
   (express.raw), а решта клубних роутів чекає JSON. Роутер тримає свій
   парсер на власному шляху, тож глобальний express.json його не чіпає. */
adminRouter.use(logoRouter);
adminRouter.use(telegramRouter);
adminRouter.use(billingRouter);
adminRouter.use(blocksRouter);
adminRouter.use(customersRouter);
adminRouter.use(staffRouter);

// analytics.ts монтується окремо в index.ts (src/index.ts), але захищає
// свої роути тим самим requireAuth/requireRole, що й кабінет.
export { requireAuth, requireRole, requireFeature } from './shared';
