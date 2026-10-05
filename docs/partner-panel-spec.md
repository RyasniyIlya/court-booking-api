# Кабінет партнера (будівельники кортів) — специфікація

Дата: 03.10.2026. Канал продажів №1 — будівельники кортів
(`ПЛАН-ДО-ПЕРШОГО-ПРОДАЖУ.md`, етап 3Б). Умови — `docs/legal/12-ПАРТНЕРСЬКИЙ-ДОГОВІР.md`:
50% від оплат клубу перші 12 місяців від привʼязки, далі 20%.

## Що бачить партнер (і що НІ)

Бачить по **своїх** клубах: назва, місто, кількість активних кортів, статус
(лід / пробний / активний / борг / відключений), тариф, дата підключення,
оплачені нами рахунки клубу (дата, сума) і **свою винагороду** з кожного.
Бачить свої рекомендації (ліди) і їх етап.

**Не бачить ніколи:** броні, гравців, телефони гравців, виручку клубу, касу,
персонал, налаштування. Тільки поля з білого списку в select — без
`include: { club: true }`.

## Дані (міграція тільки аддитивна)

```prisma
model Partner {
  id             String   @id @default(uuid()) @db.Uuid
  name           String            // ПІБ контактної особи
  company        String?           // «ТОВ Падел Буд»
  email          String   @unique  // lower-case
  phone          String?
  passwordHash   String
  refCode        String   @unique  // 6–10 символів [a-z0-9], для ?ref=
  rateFirstYear  Int      @default(50)  // %
  rateAfter      Int      @default(20)  // %
  isActive       Boolean  @default(true)
  note           String?
  pinFails       Int      @default(0)
  pinLockedUntil DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  clubs   Club[]
  leads   Lead[]
  payouts PartnerPayout[]
}

model PartnerPayout {           // виплати партнеру, вносить оператор
  id        String   @id @default(uuid()) @db.Uuid
  partnerId String   @db.Uuid   // onDelete: Cascade
  amount    Int                 // копійки
  paidAt    DateTime
  note      String?
  createdAt DateTime @default(now())
  @@index([partnerId, paidAt])
}
```
`Club`: `partnerId String? @db.Uuid` (SetNull), `partnerAttachedAt DateTime?`, `@@index([partnerId])`.
`Lead`: `partnerId String? @db.Uuid` (SetNull), `@@index([partnerId])`.

## Винагорода — `src/lib/partnerCommission.ts` (чиста функція, тести)

Для кожного `ClubInvoice` зі `status = PAID` клубу партнера, у якого
`paidAt >= partnerAttachedAt`: ставка = `rateFirstYear`, якщо
`paidAt < partnerAttachedAt + 12 міс`, інакше `rateAfter`.
`commission = round(amount * rate / 100)` копійок. Підсумки: нараховано всього,
виплачено (сума PartnerPayout), до виплати = різниця.

## API

Авторизація `src/lib/partnerAuth.ts` — як `platformAuth.ts`: JWT зі
`scope: 'partner'`, `partnerId`, `credentialVersion` = HMAC(passwordHash), щоб
зміна пароля гасила старі токени. Неактивний партнер → 401. Клубний і
платформений токени партнерський роут не приймає, і навпаки. Ліміт на логін,
блокування після 5 невдалих спроб (`pinFails/pinLockedUntil`), як у User.

`/api/partner` (CORS як `/api/admin`):
- `POST /login` {email, password} → {token, partner}
- `GET /me` → профіль + `refLink` (`${WEB_URL}/register?ref=CODE`) + ставки
- `GET /clubs` → список своїх клубів (білий список полів) + винагорода по клубу
- `GET /commissions` → рядки по оплачених рахунках + підсумки + виплати
- `GET /leads`, `POST /leads` {name, city?, phone?, contactName?, courtsCount?, openingDate?(→ note), note?}
  → Lead із `source='partner'`, `partnerId`, `stage=NEW`. Дублікат за телефоном
  в іншого партнера — не розкривати чужого, просто 409 `LEAD_EXISTS`.
- `POST /password` {current, next}

Оператор, `/api/platform` (requirePlatformAuth):
- `GET/POST /partners`, `PATCH /partners/:id` (ставки, активність, примітка), `POST /partners/:id/password` → тимчасовий пароль один раз у відповіді
- `PATCH /clubs/:id/partner` {partnerId|null} → ставить/знімає привʼязку, `partnerAttachedAt = now()` при встановленні, запис у CrmActivity SYSTEM
- `GET /partners/:id/commissions` (та ж функція), `POST /partners/:id/payouts`

Реєстрація клубу (`routes/admin/auth.ts`): необовʼязковий `ref` → якщо є активний
партнер з таким `refCode`, клуб отримує `partnerId` і `partnerAttachedAt`.
Невідомий код ігнорується мовчки (реєстрація не падає).

## Веб

- `/partner` — `PartnerPanel.jsx`, префікс стилів `pp-`, мова інтерфейсу українська.
  Вхід → вкладки: **Клуби** (таблиця + статус-бейджі), **Винагорода**
  (підсумки «нараховано / виплачено / до виплати» + рядки), **Рекомендувати клуб**
  (форма + список своїх лідів з етапом), **Посилання** (реф-лінк з кнопкою копіювати).
  Токен у sessionStorage під своїм ключем. Мобільна верстка (будівельник на обʼєкті з телефона).
- `RegisterPage` читає `?ref=` з URL, передає в API, показує «Вас рекомендував партнер».
- `PlatformAdmin`: вкладка «Партнери» — список, створення, тимчасовий пароль,
  ставки, привʼязка клубу, внесення виплати.

## Готово, коли

1. Міграція тільки `CREATE TABLE` / `ADD COLUMN` / індекси / FK.
2. Тести: комісія (межа 12 міс, неоплачені й VOID не рахуються, оплата до привʼязки не рахується);
   ізоляція (партнер A не бачить клубів/лідів B; у відповіді `/clubs` немає броней, гравців, виручки);
   токени не взаємозамінні; реєстрація з ref і з невідомим ref.
3. `npx tsc --noEmit` і `npx vitest run` зелені в обох репо.

---

## Звітність оператора по партнерах (додано 03.10.2026)

Мета: власник платформи в будь-який момент бачить **повну й чітку** картину:
який клуб у якого партнера, на якому тарифі, скільки коштує, коли й скільки
грошей прийшло, скільки з цього винагорода партнера, скільки виплачено і
скільки лишається нам.

### API (`/api/platform`, requirePlatformAuth)

`GET /partners/report?from=YYYY-MM-DD&to=YYYY-MM-DD[&partnerId=uuid]`
(період за `paidAt` рахунку; без дат — весь час). Відповідь, гроші в копійках:

```
{
  period: {from, to},
  totals: { received, commission, net, payoutsPaid, due, clubs, activeClubs },
  partners: [{
    id, name, company, rateFirstYear, rateAfter,
    totals: { received, commission, net, payoutsPaid, due },
    clubs: [{
      id, name, city, status, attachedAt,
      plan: { code, name } | null,
      priceMonthly,            // поточна ціна за місяць (clubListPrice / planPrice)
      billingPeriod, paidUntil, // до коли оплачено
      received, commission, net,
      invoices: [{ id, issuedAt, periodFrom, periodTo, amount, status, paidAt, method, rate, commission, net }]
    }],
    payouts: [{ id, amount, paidAt, note }]
  }],
  months: [{ month: 'YYYY-MM', received, commission, net, payoutsPaid }]   // помісячна динаміка
}
```
- `invoices` — усі рахунки клубу в періоді (ISSUED, PAID, VOID), щоб було видно і
  неоплачені; `commission/net` рахуються тільки для PAID (для інших = 0).
- `net = amount − commission`.
- `due` = накопичена винагорода за весь час − усі виплати (не залежить від фільтра періоду).
- Реюзати `calcCommissions` з `lib/partnerCommission.ts` (одне джерело правди).

`GET /partners/report.xlsx?…` — те саме в Excel через `lib/xlsx.ts`, аркуші:
«Зведення» (по партнерах), «Клуби», «Платежі» (кожен рахунок рядком: партнер,
клуб, тариф, період, сума, статус, дата оплати, спосіб, ставка %, винагорода, нам),
«Виплати», «По місяцях». Запис у журнал не потрібен (оператор).

### Веб (`PartnersSection.jsx` → підвкладка «Звіт»)

- Фільтр періоду (цей місяць / минулий / рік / весь час / довільний) і партнера.
- Плитки: Надійшло · Винагорода партнерам · Лишилось нам · Виплачено · До виплати.
- Таблиця по партнерах → розгортається в клуби → розгортається в рахунки
  (дата оплати, сума, статус-бейдж, ставка, винагорода, нам).
- Таблиця по місяцях.
- Кнопка «Excel».
- Гроші — `uah` з копійок, дати — дд.мм.рррр.

### Готово, коли

Тести API: суми сходяться (received = Σ PAID; commission + net = received),
фільтр періоду, фільтр партнера, неоплачені рахунки видно з commission 0,
due не залежить від періоду, xlsx віддається з правильним content-type,
без авторизації — 401. Веб: тест на рендер звіту з моком і на кнопку Excel.
