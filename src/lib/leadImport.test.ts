import { describe, expect, it } from 'vitest';

import {
  buildFillPatch,
  cleanEdrpou,
  deriveName,
  firstPhone,
  guessSport,
  mapImportRow,
  titleCase,
} from './leadImport';

// Справжній рядок із court-booking-web/clean_leads.json (.clean[0])
const YC_ROW = {
  'Компанія': 'ТОВ "ФУТБОЛЬНИЙ КЛУБ "МЕТАЛІСТ"',
  'Код': 43285931,
  'Статус': 'Не перебуває в процесі припинення',
  'КВЕД': 'Діяльність спортивних клубів',
  'Сфера': 'Спортивні організації',
  'Телефон': '+380671330011',
  'Email': 'HANTER083@GMAIL.COM',
  'Веб-сайт': null,
  'Директор': 'ЄМАНОВ ВЛАДИСЛАВ ВІКТОРОВИЧ',
  'Регіон': 'Харківський район',
  'Місто': 'Харків',
  'Адреса': 'УКРАЇНА, 61001, ХАРКІВСЬКА ОБЛ., МІСТО ХАРКІВ, ВУЛ.ТАРАСЕНКА ГЕОРГІЯ, БУДИНОК 65',
  'ОПФ': 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ',
  'MarketScore': 'A',
  'FinScore': 'C',
  'Дохід 2025, грн': 89170200,
  'Причина': 'готовий до контакту',
  'Пріоритет': 'A',
};

describe('deriveName', () => {
  it('прибирає форму власності та лапки, робить Title Case', () => {
    expect(deriveName('ТОВ "ФІТНЕС ЦЕНТР "БЛОКБАСТЕР"')).toBe('Фітнес Центр Блокбастер');
    expect(deriveName('ТОВ «ПАДЕЛ ПАРТНЕР»')).toBe('Падел Партнер');
  });

  it('прибирає повну форму в кінці назви', () => {
    expect(
      deriveName('СПОРТИВНИЙ КЛУБ "АКВА-СПОРТ"-ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ'),
    ).toBe('Спортивний Клуб Аква-Спорт');
  });

  it('прибирає повну форму на початку', () => {
    expect(deriveName('ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ТЕНІС ПЛЮС"')).toBe('Теніс Плюс');
  });

  it('прибирає ФОП/ПП/ГО, але не чіпає слова на «го…»', () => {
    expect(deriveName('ФОП ІВАНЕНКО ІВАН')).toBe('Іваненко Іван');
    expect(deriveName('ПП "КОРТ"')).toBe('Корт');
    expect(deriveName('ГО "СПОРТ ДЛЯ ВСІХ"')).toBe('Спорт Для Всіх');
    expect(deriveName('ГОРИЗОНТ СПОРТ')).toBe('Горизонт Спорт');
  });

  it('лишає ФК/СК капсом і не чіпає змішаний регістр', () => {
    expect(deriveName('ТОВ «ФК КУДРІВКА-1»')).toBe('ФК Кудрівка-1');
    expect(deriveName('ТОВ "Padel Club Kyiv"')).toBe('Padel Club Kyiv');
  });

  it("зберігає апостроф", () => {
    expect(titleCase("МАР'ЯН ПЕТРЕНКО")).toBe("Мар'ян Петренко");
  });

  it('якщо після чистки порожньо — повертає юрназву', () => {
    expect(deriveName('ТОВ ""')).toBe('ТОВ ""');
  });
});

describe('firstPhone / cleanEdrpou / guessSport', () => {
  it('бере перший номер зі списку й нормалізує', () => {
    expect(firstPhone('+380312641111, +380503716551')).toBe('+380312641111');
    expect(firstPhone('067 133 00 11')).toBe('+380671330011');
    expect(firstPhone('нема')).toBeNull();
  });

  it('пропускає непридатний перший номер', () => {
    expect(firstPhone('12345, 0671330011')).toBe('+380671330011');
  });

  it('доповнює числовий код до 8 знаків, рядковий не чіпає', () => {
    expect(cleanEdrpou(1234567)).toBe('01234567');
    expect(cleanEdrpou('43285931')).toBe('43285931');
    expect(cleanEdrpou('abc')).toBeNull();
  });

  it('вгадує вид спорту з назви та КВЕД', () => {
    expect(guessSport('Падел Партнер')).toBe('падел');
    expect(guessSport('Київська Академія Тенісу')).toBe('теніс');
    expect(guessSport('Squash & Badminton hall')).toBe('мульти');
    expect(guessSport('ФК Металіст', 'Діяльність спортивних клубів')).toBeNull();
  });
});

describe('mapImportRow', () => {
  it('мапить справжній рядок YouControl', () => {
    const r = mapImportRow(YC_ROW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      name: 'Футбольний Клуб Металіст',
      legalName: 'ТОВ "ФУТБОЛЬНИЙ КЛУБ "МЕТАЛІСТ"',
      edrpou: '43285931',
      phone: '+380671330011',
      email: 'hanter083@gmail.com',
      website: null,
      contactName: 'Єманов Владислав Вікторович',
      contactRole: 'директор',
      region: 'Харківський район',
      city: 'Харків',
      marketScore: 'A',
      finScore: 'C',
      revenueYear: 89170200n,
      priority: 'A',
      note: 'готовий до контакту',
      sport: null,
      source: 'youcontrol',
    });
    expect(r.data.tags).toEqual(['спортклуб']);
  });

  it('приймає власні назви полів і має пріоритет над YouControl', () => {
    const r = mapImportRow({
      name: 'Padel Club Kyiv', edrpou: '12345678', phone: '0671234567',
      email: 'Info@Club.UA', priority: 'c', tags: ['VIP', 'vip', 'нове'], courtsCount: 6,
      source: 'referral', 'Компанія': 'ТОВ "ІНШЕ"',
    });
    expect(r.ok && r.data).toMatchObject({
      name: 'Padel Club Kyiv', edrpou: '12345678', phone: '+380671234567',
      email: 'info@club.ua', priority: 'C', courtsCount: 6, source: 'referral', sport: 'падел',
    });
    expect(r.ok && r.data.tags).toEqual(['VIP', 'нове']);
  });

  it('невідомий пріоритет -> null (для нового ліда стане B)', () => {
    const r = mapImportRow({ ...YC_ROW, 'Пріоритет': 'Z' });
    expect(r.ok && r.data.priority).toBeNull();
  });

  it('відкидає рядок без назви або без ключа дедуплікації', () => {
    expect(mapImportRow({ 'Код': 1 })).toEqual({ ok: false, error: 'NAME_REQUIRED' });
    expect(mapImportRow({ name: 'X' })).toEqual({ ok: false, error: 'NO_DEDUPE_KEY' });
    expect(mapImportRow('str')).toEqual({ ok: false, error: 'NOT_AN_OBJECT' });
  });
});

describe('buildFillPatch', () => {
  const incoming = (() => {
    const r = mapImportRow(YC_ROW);
    if (!r.ok) throw new Error('bad fixture');
    return r.data;
  })();

  it('заповнює лише порожні поля і не чіпає операторські', () => {
    const patch = buildFillPatch(
      { tags: ['мій-тег'], city: 'Київ', email: null, note: 'дзвонив, не підняв', phone: '', courtsCount: 4 },
      incoming,
    );
    expect(patch.city).toBeUndefined();
    expect(patch.note).toBeUndefined();
    expect(patch.courtsCount).toBeUndefined();
    expect(patch.email).toBe('hanter083@gmail.com');
    expect(patch.phone).toBe('+380671330011');
    expect(patch.tags).toEqual(['мій-тег', 'спортклуб']);
    // етап, пріоритет, джерело імпорт не пропонує взагалі
    expect(patch).not.toHaveProperty('stage');
    expect(patch).not.toHaveProperty('priority');
    expect(patch).not.toHaveProperty('source');
    expect(patch).not.toHaveProperty('nextAction');
  });

  it('порожній патч, якщо нічого нового', () => {
    const full = { ...incoming, tags: ['спортклуб', 'СПОРТ'] } as never;
    expect(buildFillPatch(full, incoming)).toEqual({});
  });
});
