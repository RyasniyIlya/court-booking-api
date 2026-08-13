# Розгортання онлайн

Мета: сервіс працює постійно, посилання на демо відкривається з телефона на зустрічі з клубом.

Docker Desktop локально для цього не потрібен — база береться хмарна.

---

## Крок 1. База даних — Neon

1. neon.tech → зареєструватись через GitHub.
2. Create project: регіон **Europe (Frankfurt)** — найближчий до України, затримка ~30 мс.
3. Скопіювати connection string. Виглядає так:
   `postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`

Безкоштовного тарифу вистачає на демо і на перших клієнтів.
Neon присипляє базу без запитів — перший запит після паузи йде ~1 сек. Для віджета клубу це непомітно.

Локально теж працює: вставити цей рядок у `.env` як `DATABASE_URL` і запустити
`npx prisma migrate dev` зі свого ноутбука. Postgres на машині тоді не потрібен.

---

## Крок 2. Міграції

З локальної машини, один раз:

```bash
npx prisma migrate dev --name init --create-only
```

Далі дописати в створений `prisma/migrations/<дата>_init/migration.sql` вміст
`prisma/migrations/0002_no_double_booking/migration.sql` і видалити стару папку:

```bash
cat prisma/migrations/0002_no_double_booking/migration.sql >> prisma/migrations/*_init/migration.sql
rm -rf prisma/migrations/0002_no_double_booking
npx prisma migrate dev
npm run db:seed
```

Тепер захист від подвійної броні — частина історії міграцій, і на проді
застосується автоматично. Контейнер запускає `prisma migrate deploy` при старті.

---

## Крок 3. API — Render

1. Залити проект на GitHub (приватний репозиторій).
2. render.com → New → Blueprint → обрати репозиторій. Render підхопить `render.yaml`.
3. У змінних середовища вставити `DATABASE_URL` з Neon.
   `JWT_SECRET` Render згенерує сам.
4. Дочекатись деплою, перевірити: `https://<назва>.onrender.com/health` → `{"ok":true}`

**Тариф.** Безкоштовний план засинає після 15 хв без запитів, і перший запит
буде вантажитись ~50 сек. Для демо перед власником клубу це провал.
Starter ($7/міс) не засинає — беремо його. Це і є та собівартість,
яку ми закладаємо в 500 грн/міс за обслуговування.

---

## Альтернатива: власний VPS

Якщо береш VPS (Hetzner CX22 ~€4/міс), працює той самий `docker-compose.yml`
плюс сервіс API. База тоді своя, Neon не потрібен:

```bash
docker compose up -d db
docker build -t court-api .
docker run -d --name court-api --network host \
  -e DATABASE_URL="postgresql://postgres:postgres@localhost:5432/courts" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  court-api
```

Зверху Caddy або nginx для HTTPS. Дешевше за Render, але оновлення й бекапи —
твоя турбота. На етапі перших продажів я б це не брав: витрачений на адміністрування
день коштує дорожче за різницю в $3.

---

## Крок 4. Фронтенд

Віджет і адмінка — статика, вантажаться на Vercel або Netlify безкоштовно.
У збірці вказати адресу API:

```jsx
<CourtBookingWidget apiBase="https://court-booking-api.onrender.com" slug="squash-arena" />
```

Для демо конкретному клубу: створити для нього клуб з його назвою й кортами,
і дати посилання виду `demo.твійдомен/club/назва-клубу`. Персональне демо
з їхнім логотипом продає краще за будь-яку презентацію.

---

## Що перевірити перед показом клубу

- [ ] `/health` відповідає
- [ ] У віджеті видно сітку на сьогодні й на тиждень уперед
- [ ] Бронь створюється, приходить сповіщення в Telegram
- [ ] Тест гонки з README: один 201, решта 409
- [ ] Вхід в адмінку працює, бронь видно, скасування працює
- [ ] Відкрити віджет з телефона по мобільному інтернету, не з домашнього wifi
