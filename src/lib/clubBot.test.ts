import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';

import {
  DEFAULT_WELCOME,
  DEFAULT_WINBACK,
  botSettingsSchema,
  defaultBotSettings,
  describeKeyboard,
  fillTemplate,
  normalizeBotSettings,
  promoSummary,
  renderClubHome,
  renderWinback,
  trainersOnShift,
  type TrainerShiftInput,
} from './clubBot';

const ENV = { PUBLIC_WEB_URL: 'https://club.example' } as NodeJS.ProcessEnv;
const club = { name: 'Squash <Arena>', slug: 'squash', address: 'вул. Київська, 1', phone: '+380671112233' };
const UUID = '11111111-1111-4111-8111-111111111111';

describe('normalizeBotSettings', () => {
  it.each([undefined, null, 'текст', 42, [], {}])('%j → типові налаштування', (raw) => {
    expect(normalizeBotSettings(raw)).toEqual(defaultBotSettings());
  });

  it('типові значення відповідають специфікації', () => {
    const d = defaultBotSettings();
    expect(d.welcome).toBe(DEFAULT_WELCOME);
    expect(d.winback).toEqual({
      enabled: false, afterDays: 30, everyDays: 7, maxMessages: 3, text: DEFAULT_WINBACK, promoId: null,
    });
    expect(d).toMatchObject({ displayName: null, showAddress: true, showPhone: true, showPromos: true, promoIds: null, showTrainers: true, trainerIds: null });
  });

  it('зіпсоване поле падає в типове, решта зберігається', () => {
    const s = normalizeBotSettings({
      displayName: 123,
      welcome: 'Привіт, {name}!',
      showAddress: 'так',
      showPhone: false,
      winback: { enabled: true, afterDays: 17, everyDays: 14, maxMessages: 99, text: 5, promoId: 7 },
    });
    expect(s.displayName).toBeNull();
    expect(s.welcome).toBe('Привіт, {name}!');
    expect(s.showAddress).toBe(true);
    expect(s.showPhone).toBe(false);
    expect(s.winback).toMatchObject({ enabled: true, afterDays: 30, everyDays: 14, maxMessages: 3, text: DEFAULT_WINBACK, promoId: null });
  });

  it('обрізає довгі тексти й порожню назву/привітання замінює типовими', () => {
    const s = normalizeBotSettings({ displayName: `  ${'а'.repeat(80)}  `, welcome: '   ' });
    expect(s.displayName).toHaveLength(48);
    expect(s.welcome).toBe(DEFAULT_WELCOME);
    expect(normalizeBotSettings({ welcome: 'x'.repeat(900) }).welcome).toHaveLength(600);
    expect(normalizeBotSettings({ displayName: '   ' }).displayName).toBeNull();
  });

  it('списки акцій: null лишається null, дублі й не-рядки відкидаються, стеля 10', () => {
    expect(normalizeBotSettings({ promoIds: null }).promoIds).toBeNull();
    expect(normalizeBotSettings({ promoIds: 'x' }).promoIds).toBeNull();
    expect(normalizeBotSettings({ promoIds: ['a', 'a', 5, '', 'b'] }).promoIds).toEqual(['a', 'b']);
    const many = Array.from({ length: 15 }, (_, i) => `p${i}`);
    expect(normalizeBotSettings({ promoIds: many }).promoIds).toHaveLength(10);
  });

  it('ідемпотентна: повторна нормалізація нічого не міняє', () => {
    const once = normalizeBotSettings({ displayName: 'Клуб', promoIds: ['a'], winback: { enabled: true, afterDays: 45 } });
    expect(normalizeBotSettings(once)).toEqual(once);
  });
});

describe('botSettingsSchema (PUT)', () => {
  it('приймає повний коректний обʼєкт', () => {
    expect(botSettingsSchema.safeParse(defaultBotSettings()).success).toBe(true);
  });

  it('strict: зайве поле — помилка', () => {
    expect(botSettingsSchema.safeParse({ ...defaultBotSettings(), extra: 1 }).success).toBe(false);
    const d = defaultBotSettings();
    expect(botSettingsSchema.safeParse({ ...d, winback: { ...d.winback, extra: 1 } }).success).toBe(false);
  });

  it.each([
    ['afterDays поза списком', (d: any) => { d.winback.afterDays = 15; }],
    ['everyDays поза списком', (d: any) => { d.winback.everyDays = 3; }],
    ['maxMessages 6', (d: any) => { d.winback.maxMessages = 6; }],
    ['назва 49 символів', (d: any) => { d.displayName = 'а'.repeat(49); }],
    ['привітання 601 символ', (d: any) => { d.welcome = 'а'.repeat(601); }],
    ['promoIds не uuid', (d: any) => { d.promoIds = ['abc']; }],
    ['promoIds понад 10', (d: any) => { d.promoIds = Array.from({ length: 11 }, () => UUID); }],
    ['promoId не uuid', (d: any) => { d.winback.promoId = 'abc'; }],
  ])('відхиляє: %s', (_name, mutate) => {
    const d: any = structuredClone(defaultBotSettings());
    mutate(d);
    expect(botSettingsSchema.safeParse(d).success).toBe(false);
  });
});

describe('fillTemplate', () => {
  it('підставляє {name} {club} {days}', () => {
    expect(fillTemplate('{name}, вже {days} днів у {club}', { name: 'Олена', club: 'Арена', days: '30' }))
      .toBe('Олена, вже 30 днів у Арена');
  });

  it('екранує html і в тексті власника, і в значеннях', () => {
    expect(fillTemplate('<b>Привіт</b> {name} & {club}', { name: '<i>Х</i>', club: 'A&B' }))
      .toBe('&lt;b&gt;Привіт&lt;/b&gt; &lt;i&gt;Х&lt;/i&gt; &amp; A&amp;B');
  });

  it('значення з плейсхолдером усередині не розкривається вдруге', () => {
    expect(fillTemplate('{name} у {club}', { name: '{club}', club: 'Арена' })).toBe('{club} у Арена');
  });

  it('невідомий плейсхолдер лишається як є', () => {
    expect(fillTemplate('{foo} {name}', { name: 'О' })).toBe('{foo} О');
    expect(fillTemplate('{constructor}', {})).toBe('{constructor}');
  });
});

describe('promoSummary', () => {
  const base = { kind: 'WEEKLY' as const, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 720, discountType: 'PERCENT' as const, discountValue: 20 };

  it('відсоток, будні, вікно часу', () => {
    expect(promoSummary(base)).toBe('−20% · пн–пт · 07:00–12:00');
  });

  it('фіксована ціна, дати без вікна часу', () => {
    expect(promoSummary({
      kind: 'DATES', dateFrom: new Date('2026-10-01T00:00:00Z'), dateTo: new Date('2026-10-15T00:00:00Z'),
      startMinute: 0, endMinute: 1440, discountType: 'PRICE', discountValue: 25000,
    })).toBe('250 грн/год · 01.10–15.10');
  });

  it('копійки в ціні й одна дата', () => {
    expect(promoSummary({
      kind: 'DATES', dateFrom: '2026-12-31', dateTo: '2026-12-31',
      startMinute: 0, endMinute: 1440, discountType: 'PRICE', discountValue: 25050,
    })).toBe('250,50 грн/год · 31.12');
  });

  it('день народження', () => {
    expect(promoSummary({ kind: 'BIRTHDAY', startMinute: 0, endMinute: 1440, discountType: 'PERCENT', discountValue: 15 }))
      .toBe('−15% · до дня народження');
  });

  it('дні тижня: щодня, розриви, серія з двох, вікно до півночі', () => {
    expect(promoSummary({ ...base, weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 })).toBe('−20% · щодня');
    expect(promoSummary({ ...base, weekdays: [1, 3, 6], startMinute: 0, endMinute: 1440 })).toBe('−20% · пн, ср, сб');
    expect(promoSummary({ ...base, weekdays: [1, 2], startMinute: 0, endMinute: 1440 })).toBe('−20% · пн, вт');
    /* Неділя в базі — 0, але в підписі тиждень закінчується нею: сб–нд. */
    expect(promoSummary({ ...base, weekdays: [5, 6, 0], startMinute: 0, endMinute: 1440 })).toBe('−20% · пт–нд');
    expect(promoSummary({ ...base, weekdays: [6, 0], startMinute: 1080, endMinute: 1440 })).toBe('−20% · сб, нд · 18:00–24:00');
  });
});

describe('trainersOnShift', () => {
  // Середа, 30.09.2026; weekday % 7 = 3
  const date = DateTime.fromISO('2026-09-30T12:00:00', { zone: 'Europe/Kyiv' });
  const wed = { weekday: 3, openMinute: 600, closeMinute: 1080, isClosed: false };
  const ex = (over: Partial<TrainerShiftInput['exceptions'][number]>): TrainerShiftInput['exceptions'][number] => ({
    date: new Date('2026-09-30T00:00:00Z'), isClosed: false, kind: 'WORKING', intervals: [], ...over,
  });
  const trainer = (name: string, hours: TrainerShiftInput['hours'], exceptions: TrainerShiftInput['exceptions'] = []): TrainerShiftInput =>
    ({ id: `id-${name}`, name, hours, exceptions });

  it('тижневий графік на сьогодні, сортування за початком', () => {
    const list = trainersOnShift([
      trainer('Ігор', [{ ...wed, openMinute: 780, closeMinute: 1200 }]),
      trainer('Анна', [wed]),
    ], date);
    expect(list).toEqual([
      { id: 'id-Анна', name: 'Анна', from: '10:00', to: '18:00' },
      { id: 'id-Ігор', name: 'Ігор', from: '13:00', to: '20:00' },
    ]);
  });

  it('вихідний у тижневому графіку, інший день тижня й порожній графік — не показуємо', () => {
    expect(trainersOnShift([
      trainer('Закритий', [{ ...wed, isClosed: true }]),
      trainer('Інший день', [{ ...wed, weekday: 4 }]),
      trainer('Без графіка', []),
    ], date)).toEqual([]);
  });

  it('DAY_OFF / VACATION / isClosed перекривають тижневий графік', () => {
    expect(trainersOnShift([
      trainer('А', [wed], [ex({ kind: 'DAY_OFF', isClosed: true })]),
      trainer('Б', [wed], [ex({ kind: 'VACATION', isClosed: true })]),
      trainer('В', [wed], [ex({ kind: 'WORKING', isClosed: true, intervals: [{ startMinute: 600, endMinute: 700 }] })]),
    ], date)).toEqual([]);
  });

  it('WORKING: години з винятку замість тижневих, навіть коли тижневий день закритий', () => {
    const list = trainersOnShift([
      trainer('Замінює', [{ ...wed, isClosed: true }], [ex({ intervals: [{ startMinute: 480, endMinute: 720 }, { startMinute: 840, endMinute: 960 }] })]),
    ], date);
    expect(list).toEqual([{ id: 'id-Замінює', name: 'Замінює', from: '08:00', to: '16:00' }]);
  });

  it('WORKING без жодного проміжку — немає на зміні', () => {
    expect(trainersOnShift([trainer('Х', [wed], [ex({ intervals: [] })])], date)).toEqual([]);
  });

  it('UNAVAILABLE: від тижневих годин віднімаються недоступні проміжки', () => {
    const list = trainersOnShift([
      trainer('Частково', [wed], [ex({ kind: 'UNAVAILABLE', intervals: [{ startMinute: 600, endMinute: 720 }] })]),
      trainer('Посередині', [wed], [ex({ kind: 'UNAVAILABLE', intervals: [{ startMinute: 720, endMinute: 780 }] })]),
    ], date);
    expect(list).toEqual([
      /* Проміжок посередині дня згортається в «від першого до останнього». */
      { id: 'id-Посередині', name: 'Посередині', from: '10:00', to: '18:00' },
      { id: 'id-Частково', name: 'Частково', from: '12:00', to: '18:00' },
    ]);
  });

  it('UNAVAILABLE на весь робочий день — прибирає тренера', () => {
    expect(trainersOnShift([
      trainer('Весь день', [wed], [ex({ kind: 'UNAVAILABLE', intervals: [{ startMinute: 0, endMinute: 1440 }] })]),
    ], date)).toEqual([]);
  });

  it('виняток на іншу дату не діє', () => {
    const list = trainersOnShift([
      trainer('А', [wed], [ex({ kind: 'DAY_OFF', isClosed: true, date: new Date('2026-10-01T00:00:00Z') })]),
    ], date);
    expect(list).toHaveLength(1);
  });

  it('зміна після півночі показується за добу', () => {
    const list = trainersOnShift([trainer('Нічний', [{ ...wed, openMinute: 1200, closeMinute: 1560 }])], date);
    expect(list).toEqual([{ id: 'id-Нічний', name: 'Нічний', from: '20:00', to: '02:00' }]);
  });
});

describe('renderClubHome', () => {
  const settings = defaultBotSettings();
  const input = {
    club, settings, playerName: 'Олена', otherClubs: 0, env: ENV,
    promos: [{ id: 'p1', title: 'Щасливі <години>', summary: '−20% · пн–пт' }],
    trainers: [{ id: 't1', name: 'Анна', from: '10:00', to: '18:00' }],
  };
  const labels = (v: { keyboard: { text: string }[][] }) => v.keyboard.flat().map((b) => b.text);

  it('повний текст головної, html екранований', () => {
    const { text } = renderClubHome(input);
    expect(text).toBe([
      '🎾 <b>Squash &lt;Arena&gt;</b>',
      '',
      'Вітаємо, Олена! Це бот клубу Squash &lt;Arena&gt;: бронюйте корт, дивіться свої записи й отримуйте нагадування.',
      '',
      '📍 вул. Київська, 1',
      '☎️ +380671112233',
      '',
      '🔥 <b>Акції</b>',
      '• Щасливі &lt;години&gt; — −20% · пн–пт',
      '',
      '🧑‍🏫 <b>Сьогодні на зміні</b>',
      '• Анна · 10:00–18:00',
    ].join('\n'));
  });

  it('displayName перекриває назву клубу і в заголовку, і в {club}', () => {
    const { text } = renderClubHome({ ...input, settings: { ...settings, displayName: 'Арена' } });
    expect(text.startsWith('🎾 <b>Арена</b>')).toBe(true);
    expect(text).toContain('бот клубу Арена:');
  });

  it('кнопки: бронь, записи, профіль; «Інший клуб» тільки коли є інші', () => {
    const one = renderClubHome(input);
    expect(labels(one)).toEqual(['🎾 Забронювати', '📋 Мої записи', '👤 Мій профіль']);
    expect(one.keyboard[0][0].web_app?.url).toContain('https://club.example/c/squash');
    expect(one.keyboard[1][0].callback_data).toBe('home:my');

    const many = renderClubHome({ ...input, otherClubs: 2 });
    expect(labels(many)).toContain('🔁 Інший клуб');
    expect(many.keyboard.flat().find((b) => b.text === '🔁 Інший клуб')?.callback_data).toBe('home:clubs');
  });

  it('гість (без імені): немає «Мій профіль», звернення нейтральне', () => {
    const v = renderClubHome({ ...input, playerName: null });
    expect(labels(v)).toEqual(['🎾 Забронювати', '📋 Мої записи']);
    expect(v.text).toContain('Вітаємо, гостю!');
  });

  it('без адреси публічного сайту кнопок із посиланнями немає', () => {
    const v = renderClubHome({ ...input, env: {} as NodeJS.ProcessEnv });
    expect(labels(v)).toEqual(['📋 Мої записи']);
  });

  it('http-адреса (розробка) — звичайне посилання, не web_app', () => {
    const v = renderClubHome({ ...input, env: { PUBLIC_WEB_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv });
    expect(v.keyboard[0][0].url).toContain('http://localhost:5173/c/squash');
    expect(v.keyboard[0][0].web_app).toBeUndefined();
  });

  it('налаштування ховають адресу, телефон, акції й тренерів', () => {
    const { text } = renderClubHome({
      ...input, settings: { ...settings, showAddress: false, showPhone: false, showPromos: false, showTrainers: false },
    });
    expect(text).not.toMatch(/📍|☎️|Акції|на зміні/);
  });

  it('порожні акції й тренери — без заголовків', () => {
    const { text } = renderClubHome({ ...input, promos: [], trainers: [] });
    expect(text).not.toMatch(/Акції|на зміні/);
  });

  it('клуб без адреси й телефону — без порожніх рядків контактів', () => {
    const { text } = renderClubHome({ ...input, club: { ...club, address: null, phone: null } });
    expect(text).not.toMatch(/📍|☎️/);
  });

  it('акції: максимум 3 рядки і «…ще N»', () => {
    const promos = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, title: `A${i}`, summary: 's' }));
    const { text } = renderClubHome({ ...input, promos });
    expect(text.match(/^• A/gm)).toHaveLength(3);
    expect(text).toContain('…ще 2');
  });

  it('promoIds: лише вибрані, чужі й неактивні (яких немає в списку) відкидаються', () => {
    const promos = [{ id: 'a', title: 'Перша', summary: 's' }, { id: 'b', title: 'Друга', summary: 's' }];
    const { text } = renderClubHome({ ...input, promos, settings: { ...settings, promoIds: ['b', 'чужа'] } });
    expect(text).toContain('Друга');
    expect(text).not.toContain('Перша');
    expect(renderClubHome({ ...input, promos, settings: { ...settings, promoIds: [] } }).text).not.toContain('Акції');
  });

  it('trainerIds: лише вибрані', () => {
    const trainers = [{ id: 'a', name: 'Анна', from: '10:00', to: '12:00' }, { id: 'b', name: 'Богдан', from: '10:00', to: '12:00' }];
    const { text } = renderClubHome({ ...input, trainers, settings: { ...settings, trainerIds: ['b'] } });
    expect(text).toContain('Богдан');
    expect(text).not.toContain('Анна');
  });

  it('html у привітанні власника екранований', () => {
    const { text } = renderClubHome({ ...input, settings: { ...settings, welcome: '<script>x</script> {name}' } });
    expect(text).toContain('&lt;script&gt;x&lt;/script&gt; Олена');
  });
});

describe('renderWinback', () => {
  const settings = defaultBotSettings();
  const input = {
    club, settings, playerName: 'Олена', days: 34, promo: null, customerId: UUID, env: ENV,
  };

  it('текст із плейсхолдерами й кнопки «Обрати час» та «Не надсилати таке»', () => {
    const v = renderWinback(input);
    expect(v.text).toContain('Олена, давно вас не бачили — вже 34 днів!');
    expect(v.text.startsWith('🎾 <b>Squash &lt;Arena&gt;</b>')).toBe(true);
    expect(v.keyboard.flat().map((b) => b.text)).toEqual(['🎾 Обрати час', '🔕 Не надсилати таке']);
    expect(v.keyboard[1][0].callback_data).toBe(`wb:off:${UUID}`);
    expect(v.keyboard[0][0].web_app?.url).toContain('/c/squash');
  });

  it('акція додається в кінець тексту й екранується', () => {
    const v = renderWinback({ ...input, promo: { title: 'Ранок <дешевше>', summary: '−30% · пн–пт' } });
    expect(v.text.endsWith('\n\n🔥 Ранок &lt;дешевше&gt; — −30% · пн–пт')).toBe(true);
  });

  it('відписка є навіть без адреси сайту', () => {
    const v = renderWinback({ ...input, env: {} as NodeJS.ProcessEnv });
    expect(v.keyboard).toEqual([[{ text: '🔕 Не надсилати таке', callback_data: `wb:off:${UUID}` }]]);
  });

  it('свій текст власника', () => {
    const v = renderWinback({ ...input, settings: { ...settings, winback: { ...settings.winback, text: 'Гей, {name} з <{club}>' } } });
    expect(v.text).toContain('Гей, Олена з &lt;Squash &lt;Arena&gt;&gt;');
  });
});

describe('describeKeyboard', () => {
  it('web_app → webapp, url → url, решта → callback', () => {
    expect(describeKeyboard([
      [{ text: 'a', web_app: { url: 'https://x' } }, { text: 'b', url: 'http://x' }],
      [{ text: 'c', callback_data: 'x' }],
    ])).toEqual([
      [{ text: 'a', kind: 'webapp' }, { text: 'b', kind: 'url' }],
      [{ text: 'c', kind: 'callback' }],
    ]);
  });
});

describe('ІІ-налаштування (етап 3)', () => {
  it('типово: сводка вимкнена о 8:00, сповіщення про пропозиції ввімкнені', () => {
    expect(normalizeBotSettings({})).toMatchObject({ morningBrief: { enabled: false, hour: 8 }, actionAlerts: true });
  });

  it('година поза 5..12 і сміття повертаються до типових; службова briefSentOn відкидається', () => {
    const s = normalizeBotSettings({ morningBrief: { enabled: true, hour: 3 }, actionAlerts: 'так', briefSentOn: '2026-10-18' });
    expect(s.morningBrief).toEqual({ enabled: true, hour: 8 });
    expect(s.actionAlerts).toBe(true);
    expect(s).not.toHaveProperty('briefSentOn');
    expect(normalizeBotSettings({ morningBrief: { enabled: true, hour: 11 }, actionAlerts: false })).toMatchObject({ morningBrief: { hour: 11 }, actionAlerts: false });
  });

  it('PUT: поля необовʼязкові (старий кабінет), година лише 5..12, зайвого немає', () => {
    const { morningBrief: _m, actionAlerts: _a, ...legacy } = defaultBotSettings();
    expect(botSettingsSchema.safeParse(legacy).success).toBe(true);
    expect(botSettingsSchema.safeParse({ ...legacy, morningBrief: { enabled: true, hour: 12 } }).success).toBe(true);
    expect(botSettingsSchema.safeParse({ ...legacy, morningBrief: { enabled: true, hour: 13 } }).success).toBe(false);
    expect(botSettingsSchema.safeParse({ ...legacy, morningBrief: { enabled: true, hour: 8, x: 1 } }).success).toBe(false);
  });
});
