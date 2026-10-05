# Партнери: реквізити, публічний договір, квартальні акти, контроль оплат

Дата: 03.10.2026. Продовження `docs/partner-panel-spec.md`. Мета — закрити всю
формальну частину: хто кому платить, на який рахунок, на підставі якого
документа, і щоб оператор бачив це чітко.

## Рішення власника

- Оператор сам вносить **свої** реквізити отримувача: ФОП, ТОВ або фізособа.
  Профілів може бути кілька (зараз ФОП, потім спільне ТОВ), один — основний.
  Гроші клубів ідуть на рахунок обраного профілю.
- Партнер-ФОП приєднується до **публічного партнерського договору** галочкою.
- Партнер-ТОВ зазвичай укладає **індивідуальний договір** (складає сам). Оператор
  відмічає в платформі «індивідуальний договір № … від …». Тоді галочка оферти
  не потрібна.
- Фізособа без ФОП як партнер не допускається (ми стали б податковим агентом).

## Дані (міграція тільки аддитивна)

```prisma
enum SellerKind { FOP TOV INDIVIDUAL }

/// Наші реквізити отримувача (оператор). Кілька профілів, один isDefault.
model SellerProfile {
  id          String     @id @default(uuid()) @db.Uuid
  kind        SellerKind
  label       String              // «ФОП Іваненко, Моно» — для вибору
  legalName   String              // ФОП ПІБ / ТОВ «…» / ПІБ
  code        String              // РНОКПП або ЄДРПОУ
  taxInfo     String?             // «платник ЄП 3 група, неплатник ПДВ»
  iban        String              // UA + 27 цифр, валідувати
  bankName    String?
  address     String?
  signerName  String?
  signerBasis String?             // «виписки з ЄДР» / «Статуту»
  email       String?
  phone       String?
  isDefault   Boolean  @default(false)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  invoices    ClubInvoice[]
}

enum PartnerKind { FOP TOV }
enum PartnerContractMode { PUBLIC_OFFER INDIVIDUAL }
enum PartnerActStatus { DRAFT ISSUED SIGNED PAID VOID }

// Partner — нові поля (усі nullable або з default):
  kind             PartnerKind?
  legalName        String?
  legalCode        String?          // РНОКПП / ЄДРПОУ
  taxInfo          String?
  vatPayer         Boolean @default(false)
  iban             String?
  bankName         String?
  legalAddress     String?
  signerName       String?
  signerBasis      String?
  docsEmail        String?
  kvedConfirmed    Boolean @default(false)
  requisitesAt     DateTime?
  contractMode     PartnerContractMode?
  offerAcceptedAt  DateTime?
  offerVersion     String?
  offerIp          String?
  offerSnapshot    Json?            // реквізити обох сторін і версія на момент акцепту
  contractNo       String?          // для INDIVIDUAL
  contractDate     DateTime?
  acts             PartnerAct[]

// ClubInvoice — нове поле:
  sellerId String? @db.Uuid  // на який наш профіль/рахунок виставлено (SetNull)

model PartnerAct {
  id          String   @id @default(uuid()) @db.Uuid
  partnerId   String   @db.Uuid           // Cascade
  number      String   @unique            // «А-2026-Q3-0001»
  periodFrom  DateTime
  periodTo    DateTime                    // [from, to)
  amount      Int                         // копійки, винагорода за період
  lines       Json                        // клуб, рахунок, дата оплати, сума, ставка, винагорода
  sellerSnapshot  Json                    // наші реквізити (isDefault профіль на момент створення)
  partnerSnapshot Json                    // реквізити партнера на момент створення
  status      PartnerActStatus @default(DRAFT)
  issuedAt    DateTime?
  signedAt    DateTime?
  paidAt      DateTime?
  payoutId    String?  @unique @db.Uuid   // PartnerPayout, створений при «Оплачено» (SetNull)
  note        String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([partnerId, periodFrom])
  @@index([status])
}
```

## Правила

- **Готовність партнера** (`ready`): заповнені kind, legalName, legalCode, iban
  (валідний UA IBAN з контрольною сумою mod-97), signerName, docsEmail,
  kvedConfirmed=true **і** (offerAcceptedAt при PUBLIC_OFFER **або**
  contractNo+contractDate при INDIVIDUAL). Поки не `ready`: `/me` повертає
  `refLink: null` і `missing: [...]`; реєстрація з його ref **все одно**
  привʼязує клуб (не губимо клієнта), але акт не формується.
- Акцепт оферти пише `offerAcceptedAt`, `offerVersion` (константа
  `PARTNER_OFFER_VERSION` у `lib/partnerOffer.ts`), `offerIp`, `offerSnapshot`
  ({seller, partner, version, acceptedAt}), `contractMode = PUBLIC_OFFER`.
  Зміна реквізитів після акцепту оферту не скидає; новий акцепт — лише при
  новій версії. Немає основного SellerProfile → 409 `SELLER_NOT_CONFIGURED`.
- Квартальний акт: період — календарний квартал (Europe/Kyiv). Сума = Σ
  винагород `calcCommissions` з paidAt у кварталі, рядки — ті самі. 0 → не
  створюється. Номер `А-{рік}-Q{n}-{порядковий 4 цифри}`. Сума < 1 000 грн —
  створюється, але в відповіді й UI `belowMinimum: true` («переноситься» за
  договором). Повтор того ж кварталу — 409, якщо попередній не VOID.
- Статуси: DRAFT → ISSUED (бачить партнер) → SIGNED (партнер «Підписую» або
  оператор) → PAID (оператор: дата; створюється PartnerPayout з note «Акт №…»).
  VOID — тільки з DRAFT/ISSUED. Інші переходи — 409 `BAD_STATUS`.
- Рахунок клубу: при створенні `ClubInvoice` без sellerId ставиться isDefault
  профіль (у місці, де зараз створюються рахунки в platform.ts). Оператор може змінити.

## Текст публічного договору

`docs/legal/13-ПУБЛІЧНИЙ-ПАРТНЕРСЬКИЙ-ДОГОВІР.md` — на основі шаблону 12,
переробити на договір приєднання (ст. 634, 641–642 ЦКУ; Закон «Про електронну
комерцію»): акцепт — галочка в кабінеті; сторони — з реквізитів; пункт про
пріоритет індивідуального договору, якщо він укладений. Позначка «чернетка для
перевірки юристом». Код: `lib/partnerOffer.ts` → `renderPartnerOffer(seller, partner)`
(текст вбудований у TS як шаблон з плейсхолдерами `{{seller.legalName}}` тощо,
усі значення HTML-екрануються).

## API

Оператор `/api/platform` (requirePlatformAuth):
- `GET/POST /sellers`, `PATCH /sellers/:id`, `POST /sellers/:id/default`
- `PATCH /partners/:id/contract` {contractMode, contractNo?, contractDate?}
- `PATCH /partners/:id/requisites` (оператор може виправити за партнера)
- `GET /partners` — додати `ready`, `missing`, `contractMode`, `offerAcceptedAt`, `contractNo`
- `GET /partner-acts?status&partnerId&quarter=2026-Q3`
- `POST /partner-acts/generate` {quarter:'2026-Q3', partnerId?} → DRAFT для всіх ready партнерів із сумою > 0; {created:[act], skipped:[{partnerId, name, reason}]}
- `POST /partner-acts/:id/issue|sign|void`, `POST /partner-acts/:id/pay` {paidAt?}
- `GET /partner-acts/:id/html` — друкована форма акта (`text/html`, для «Друк → PDF»)
- `PATCH /invoices/:id/seller` {sellerId}
- Звіт `/partners/report` + xlsx: у рахунку `seller: {id,label}|null`, у totals `bySeller: [{sellerId, label, iban, received}]`.

Акт у відповідях: `{id, number, partnerId, partnerName, periodFrom, periodTo, quarter, amount, belowMinimum, status, issuedAt, signedAt, paidAt, lines}`.

Партнер `/api/partner`:
- `GET /me` — + `requisites{kind, legalName, legalCode, taxInfo, vatPayer, iban, bankName, legalAddress, signerName, signerBasis, docsEmail, kvedConfirmed}`, `contract{mode, offerAcceptedAt, offerVersion, contractNo, contractDate}`, `ready`, `missing[]`, `refLink` (null до ready)
- `PUT /requisites` (zod: IBAN UA mod-97, ЄДРПОУ 8 цифр / РНОКПП 10)
- `GET /offer` → {version, html, accepted}; `POST /offer/accept` {version}
- `GET /acts` (тільки свої ISSUED/SIGNED/PAID), `GET /acts/:id/html`, `POST /acts/:id/sign`

## Веб

Кабінет партнера (`/partner`):
- Якщо не `ready` — банер «Заповніть реквізити й прийміть договір» з `missing` людською мовою.
- Вкладка **«Реквізити»**: форма (ФОП/ТОВ, поля, галочка про КВЕД з підказкою 73.11 / 82.99 / 70.22 / 46.19).
- Вкладка **«Договір»**: текст оферти, галочка «Ознайомився й приймаю» → кнопка. Для INDIVIDUAL — «Діє індивідуальний договір № … від …».
- Вкладка **«Акти»**: список, відкрити для друку (нове вікно з HTML через fetch з токеном → blob URL), «Підписую».
- «Посилання» показує лінк тільки при `ready`.

Панель оператора:
- Нова вкладка **«Реквізити»**: профілі отримувача (ФОП / ТОВ / фізособа), основний, IBAN. Для «фізособа» — попередження: «Отримувати оплату підписки на фізособу без ФОП — ризик незареєстрованої підприємницької діяльності. Рекомендуємо ФОП.»
- «Партнери»: статус готовності, режим договору (оферта / індивідуальний № дата, з формою для INDIVIDUAL), реквізити партнера.
- Підвкладка **«Акти»**: квартал → «Сформувати», таблиця зі статусами й діями (видати, підписано, оплачено, анулювати, друк), підсумки.
- «Звіт»: блок «Надійшло по рахунках» (bySeller).
- Де показуються рахунки клубу в операторці — показ і зміна профілю отримувача.

## Готово, коли

Тести API: валідація IBAN/кодів; ready/missing; refLink null до ready;
акцепт пише snapshot і відхиляє стару версію; генерація акта кварталу
(сума = Σ commissions у кварталі, 0 → skip, не-ready → skip, дубль → 409);
переходи статусів і заборонені переходи; pay створює PartnerPayout і due
зменшується; партнер не бачить DRAFT і чужі акти; HTML акта й оферти екранує
дані; bySeller сходиться з received. Міграція аддитивна. tsc + vitest зелені.
Веб: тести на форми, банер, акти; vitest + build зелені.
