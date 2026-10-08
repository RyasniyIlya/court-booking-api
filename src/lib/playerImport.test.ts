import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { readPlayerWorkbook, validateImportRows } from './playerImport';

describe('player import boundaries', () => {
  it('normalizes phones and flags duplicates with row numbers', () => {
    const r = validateImportRows([{ name: 'First', phone: '0671234567' }, { name: 'Second', phone: '+380671234567' }, { name: 'Bad', phone: '123' }]);
    expect(r.valid[0].phone).toBe('+380671234567');
    expect(r.errors).toEqual([{ row: 3, error: 'DUPLICATE_PHONE' }, { row: 4, error: 'INVALID_PHONE' }]);
  });
  it('rejects impossible birth dates and future dates', () => {
    expect(validateImportRows([{ name: 'Player', phone: '+380671234567', birthDate: '2025-02-30' }]).errors).toHaveLength(1);
    expect(validateImportRows([{ name: 'Player', phone: '+380671234567', birthDate: '2999-01-01' }]).errors).toHaveLength(1);
  });
  it('reads Ukrainian headings, dates and gender aliases', async () => {
    const w = new ExcelJS.Workbook(), s = w.addWorksheet('Players');
    s.addRow(["Ім'я", 'Телефон', 'Стать', 'Дата народження']);
    s.addRow(['Ірина', '0671234567', 'ж', new Date('2001-05-12T00:00:00Z')]);
    const r = await readPlayerWorkbook(Buffer.from(await w.xlsx.writeBuffer()));
    expect(r.errors).toEqual([]); expect(r.valid[0]).toMatchObject({ name: 'Ірина', gender: 'FEMALE', birthDate: '2001-05-12' });
  });
  it('rejects formulas and missing required columns', async () => {
    const w = new ExcelJS.Workbook(), s = w.addWorksheet('Players');
    s.addRow(['name', 'phone']); s.addRow([{ formula: '1+1', result: 2 }, '+380671234567']);
    await expect(readPlayerWorkbook(Buffer.from(await w.xlsx.writeBuffer()))).rejects.toThrow('FORMULAS_NOT_ALLOWED');
    s.getCell('A1').value = 'Unknown';
    await expect(readPlayerWorkbook(Buffer.from(await w.xlsx.writeBuffer()))).rejects.toThrow('NAME_PHONE_COLUMNS_REQUIRED');
  });
  it('rejects oversized or invalid files', async () => {
    await expect(readPlayerWorkbook(Buffer.alloc(2_000_001))).rejects.toThrow('IMPORT_TOO_LARGE');
    await expect(readPlayerWorkbook(Buffer.from('not a zip'))).rejects.toThrow('INVALID_WORKBOOK');
  });
  it('keeps Excel row numbers after empty rows', async () => {
    const w = new ExcelJS.Workbook(), s = w.addWorksheet('Players');
    s.addRow(['name', 'phone']); s.addRow([]);
    s.addRow(['First', '+380671234567']); s.addRow(['Duplicate', '+380671234567']);
    const r = await readPlayerWorkbook(Buffer.from(await w.xlsx.writeBuffer()));
    expect(r.valid[0].row).toBe(3);
    expect(r.errors).toEqual([{ row: 4, error: 'DUPLICATE_PHONE' }]);
  });
});
