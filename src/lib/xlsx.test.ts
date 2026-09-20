import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { buildWorkbook, columnName, crc32, excelSerial, safeSheetName } from './xlsx';

/**
 * Розпакувати наш же zip.
 *
 * Читаємо через центральний каталог, а не послідовно по локальних
 * заголовках: саме так робить Excel, тому тест ловить зсув у зміщеннях —
 * ту єдину помилку, від якої файл відкривається в одному розпакувальнику
 * і не відкривається в іншому.
 */
function unzip(buf: Buffer): Map<string, string> {
  const endSignature = 0x06054b50;
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== endSignature) end -= 1;
  expect(end).toBeGreaterThanOrEqual(0);

  const count = buf.readUInt16LE(end + 10);
  let cursor = buf.readUInt32LE(end + 16);
  const files = new Map<string, string>();

  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = buf.readUInt16LE(cursor + 10);
    const sum = buf.readUInt32LE(cursor + 16);
    const packed = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localAt = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    const localNameLength = buf.readUInt16LE(localAt + 26);
    const localExtraLength = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const payload = buf.subarray(dataAt, dataAt + packed);
    const data = method === 0 ? payload : inflateRawSync(payload);

    expect(crc32(data)).toBe(sum);
    files.set(name, data.toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const sheet = (rows: (string | number | Date | null)[][]) => ({
  name: 'Клієнти',
  headers: ['Імʼя', 'Телефон', 'Візитів'],
  rows,
});

describe('columnName', () => {
  it('нумерує колонки як Excel', () => {
    expect(columnName(1)).toBe('A');
    expect(columnName(26)).toBe('Z');
    expect(columnName(27)).toBe('AA');
    expect(columnName(52)).toBe('AZ');
    expect(columnName(703)).toBe('AAA');
  });
});

describe('excelSerial', () => {
  /* Опорні числа взяті з самого Excel: 1900-01-01 = 2 через неіснуюче
     29 лютого 1900 у його календарі. Якщо колись «виправити» зсув на
     «логічніший», дати в усіх вивантаженнях поїдуть на два дні. */
  it('рахує дні від 1899-12-30', () => {
    expect(excelSerial(new Date('1900-01-01T00:00:00Z'))).toBe(2);
    expect(excelSerial(new Date('2026-09-19T00:00:00Z'))).toBe(46284);
  });

  it('тримає час як дробову частину доби', () => {
    expect(excelSerial(new Date('2026-09-19T12:00:00Z'))).toBeCloseTo(46284.5, 5);
  });
});

describe('safeSheetName', () => {
  it('прибирає символи, через які Excel не відкриває книгу', () => {
    expect(safeSheetName('Клієнти/2026:[всі]', 'x')).toBe('Клієнти 2026  всі');
  });

  it('обрізає до 31 символу', () => {
    expect(safeSheetName('я'.repeat(40), 'x')).toHaveLength(31);
  });

  it('порожню назву замінює запасною', () => {
    expect(safeSheetName('   ', 'Аркуш 1')).toBe('Аркуш 1');
    expect(safeSheetName('///', 'Аркуш 1')).toBe('Аркуш 1');
  });
});

describe('buildWorkbook', () => {
  it('збирає книгу з обовʼязковими частинами', () => {
    const files = unzip(buildWorkbook([sheet([['Іван', '+380671234567', 12]])]));
    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]) {
      expect(files.has(part)).toBe(true);
    }
  });

  it('пише рядок текстом, а число числом', () => {
    const xml = unzip(buildWorkbook([sheet([['Іван', '+380671234567', 12]])]))
      .get('xl/worksheets/sheet1.xml')!;
    /* Телефон мусить лишитись рядком: у CSV те саме значення Excel
       перетворював на формулу, і клуб бачив #NAME? замість номера. */
    expect(xml).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">+380671234567</t></is></c>');
    expect(xml).toContain('<c r="C2"><v>12</v></c>');
  });

  it('дату пише серійним числом зі стилем дати', () => {
    const xml = unzip(buildWorkbook([sheet([[null, null, new Date('2026-09-19T00:00:00Z')]])]))
      .get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('<c r="C2" s="2"><v>46284</v></c>');
  });

  it('порожні значення лишає порожніми комірками', () => {
    const xml = unzip(buildWorkbook([sheet([[null, '', undefined as never]])]))
      .get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('<c r="A2"/>');
    expect(xml).toContain('<c r="B2"/>');
  });

  it('не ламається на NaN і Infinity', () => {
    const xml = unzip(buildWorkbook([sheet([['Іван', null, Number.NaN]])]))
      .get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('<c r="C2"/>');
    expect(xml).not.toContain('NaN');
  });

  it('екранує розмітку та викидає контрольні символи з імен', () => {
    const xml = unzip(buildWorkbook([sheet([['<b>Іван</b> & Ко\u0000', null, 1]])]))
      .get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('&lt;b&gt;Іван&lt;/b&gt; &amp; Ко');
    expect(xml).not.toContain('\u0000');
  });

  it('закріплює шапку й ставить автофільтр на весь діапазон', () => {
    const xml = unzip(buildWorkbook([sheet([['Іван', '+380', 1], ['Марія', '+380', 2]])]))
      .get('xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<autoFilter ref="A1:C3"/>');
  });

  it('кладе кілька аркушів і чистить їхні назви', () => {
    const files = unzip(buildWorkbook([
      { name: 'Картотека', headers: ['A'], rows: [['1']] },
      { name: 'Сегменти: LOST', headers: ['B'], rows: [] },
    ]));
    expect(files.has('xl/worksheets/sheet2.xml')).toBe(true);
    expect(files.get('xl/workbook.xml')).toContain('name="Сегменти  LOST"');
  });

  it('книга без аркушів — помилка, а не порожній файл', () => {
    expect(() => buildWorkbook([])).toThrow();
  });

  it('однакові дані дають побайтово однаковий файл', () => {
    const once = buildWorkbook([sheet([['Іван', '+380', 1]])]);
    const twice = buildWorkbook([sheet([['Іван', '+380', 1]])]);
    expect(once.equals(twice)).toBe(true);
  });
});
