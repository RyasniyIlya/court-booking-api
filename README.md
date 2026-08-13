# Court Booking API — етапи 1–2 (БД + бекенд)

Мультиарендний бекенд віджета бронювання кортів. Node + TypeScript + Express + Prisma + PostgreSQL + Zod.

## Запуск

```bash
cp .env.example .env          # прописати DATABASE_URL і JWT_SECRET
npm install
npx prisma migrate dev --name init
psql "$DATABASE_URL" -f prisma/migrations/0002_no_double_booking/migration.sql
npm run db:seed
npm run dev                   # http://localhost:3000
```

`prisma generate` виконується автоматично на `migrate dev`.

## Що вирішено і як

**Подвійна бронь.** Не перевіркою в коді, а обмеженням `EXCLUDE USING gist` у Postgres
(`prisma/migrations/0002_no_double_booking/migration.sql`). Два одночасні запити на 19:00
фізично не можуть обидва записатись: другий отримує помилку `23P01`, API повертає `409 SLOT_TAKEN`.
Скасовані броні виведені з-під обмеження через `WHERE (status <> 'CANCELLED')` — час звільняється.

**Сітка слотів.** Порожні слоти в БД не зберігаються. `src/lib/slots.ts` будує масив
із розкладу дня, кроку та зайнятих інтервалів. Логіка чиста й тестована — `now` передається параметром.

**Таймзони.** У БД усе в `timestamptz`, тобто UTC. Робочі години зберігаються як хвилини від
опівночі за локальним часом клубу, конвертація — через Luxon від `Club.timezone`.
Перехід на зимовий час опрацьовано: 25.10.2026 у Києві о 03:00 два різні слоти з різним UTC.

**Ізоляція тенантів.** `clubId` є в `Booking` і `Block`; усі адмінські запити фільтруються
по `clubId` з JWT, а не з тіла запиту.

**Захист від довільних інтервалів.** `isAlignedToGrid` не дасть створити бронь на 20:37 чи
поза робочими годинами, навіть якщо запит іде повз віджет.

## Ендпоїнти

Публічні (CORS відкритий, віджет живе на чужому домені):
- `GET  /api/public/clubs/:slug`
- `GET  /api/public/clubs/:slug/availability?date=YYYY-MM-DD[&courtId=]`
- `POST /api/public/clubs/:slug/bookings`
- `POST /api/public/bookings/:id/cancel`

Адмінські (`Authorization: Bearer <token>`):
- `POST  /api/admin/login`
- `GET   /api/admin/bookings?from=&to=`
- `PATCH /api/admin/bookings/:id`
- `POST  /api/admin/blocks`
- `POST  /api/admin/courts`
- `PUT   /api/admin/hours`

## Тест гонки (етап 4 з плану)

```bash
BODY='{"courtId":"<UUID>","start":"2026-08-20T16:00:00Z","end":"2026-08-20T17:00:00Z","customerName":"Тест","customerPhone":"+380671112233"}'
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    -H 'Content-Type: application/json' -d "$BODY" \
    http://localhost:3000/api/public/clubs/squash-arena/bookings &
done; wait
```

Очікуваний результат: один `201`, решта `409`.

## Абонементи та картки клієнтів

Реєстрації для клієнта немає. Ідентифікатор — телефон: при броні номер
нормалізується до E.164 (`src/lib/phone.ts`), система знаходить або створює
`Customer` і привʼязує бронь. Форма віджета не змінилась.

- `Customer` — телефон унікальний у межах клубу, не глобально.
- `Pass` — PACKAGE (пакет занять) або UNLIMITED (безліміт на період).
- `PassUsage` — кожне списання окремим записом, з можливістю відкату.
  Лічильник `usedSessions` і історія оновлюються однією транзакцією.

Якщо активних абонементів кілька — береться той, що згорає раніше.

**Автосписання свідомо вимкнене.** Правило згорання (за скільки годин до
заняття скасування вже не рятує) різне в кожному клубі — визначається на
обдзвоні. Поки списання ручне: `POST /api/admin/bookings/:id/use-pass`.

Нові ендпоїнти:
- `GET    /api/admin/customers?q=` — пошук за 4+ останніми цифрами або імʼям
- `POST   /api/admin/customers/:id/passes` — продати абонемент
- `POST   /api/admin/bookings/:id/use-pass` — списати заняття
- `DELETE /api/admin/bookings/:id/use-pass` — повернути списане

`GET /api/admin/bookings` тепер віддає `pass` (залишок) і `reminderReachable`
(чи дійде нагадування в Telegram).

## Фронтенд

- `widget/CourtBookingWidget.jsx` — віджет для сайту клубу.
- `widget/AdminPanel.jsx` — кабінет клубу: день, скасування, закриття часу.

Стилі скоповані (`all: initial` + префікси `cb-` / `ap-`), без Tailwind
і UI-бібліотек — віджет ставиться на будь-який сайт.

## Що свідомо не в MVP

Telegram-бот (привʼязка номера, нагадування за добу, залишок абонемента),
автосписання занять, передоплата, SMS, кілька локацій на одного власника,
експорт у Google Calendar, штат співробітників і ролі.

Повна CRM (зарплати тренерів, склад, каса) свідомо не будується: там уже
працюють Appointer, Altegio і YCLIENTS з командами, і соло-розробник туди не
заходить. Наша частина — бронювання, абонементи й нагадування.
