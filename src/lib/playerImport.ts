import ExcelJS from 'exceljs';
import { z } from 'zod';
import { normalizePhone } from './phone';

const optional = z.string().trim().max(80).optional();
export const importPlayerSchema = z.object({
  name: z.string().trim().min(1).max(80), phone: z.string().min(1).max(40),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(), ageCategory: optional,
  skillLevel: optional, group: optional, category: optional,
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
    const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s && d <= new Date();
  }, 'Invalid birth date').optional(),
});
export type ImportPlayer = z.infer<typeof importPlayerSchema>;
const aliases: Record<string, string> = {
  name: 'name', 'имя': 'name', "ім'я": 'name', 'піб': 'name', 'фио': 'name',
  phone: 'phone', 'телефон': 'phone', gender: 'gender', 'пол': 'gender', 'стать': 'gender',
  birthdate: 'birthDate', 'дата рождения': 'birthDate', 'дата народження': 'birthDate',
  agecategory: 'ageCategory', 'возрастная категория': 'ageCategory', 'вікова категорія': 'ageCategory',
  skilllevel: 'skillLevel', 'уровень': 'skillLevel', 'рівень': 'skillLevel',
  group: 'group', 'группа': 'group', 'група': 'group', category: 'category', 'категория': 'category', 'категорія': 'category',
};
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('FORMULAS_NOT_ALLOWED');
    if ('richText' in value) return value.richText.map(r => r.text).join('');
    if ('text' in value) return String(value.text);
    throw new Error('UNSUPPORTED_CELL');
  }
  return String(value).trim();
}
export function validateImportRows(rows: unknown[], rowNumbers?: number[]) {
  if (rows.length > 1000) throw new Error('IMPORT_TOO_LARGE');
  const valid: Array<ImportPlayer & { row: number }> = [], errors: Array<{ row: number; error: string }> = [];
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const row = rowNumbers?.[i] ?? i + 2;
    const r = importPlayerSchema.safeParse(raw);
    if (!r.success) { errors.push({ row, error: r.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ') }); return; }
    const phone = normalizePhone(r.data.phone);
    if (!phone) { errors.push({ row, error: 'INVALID_PHONE' }); return; }
    if (seen.has(phone.e164)) { errors.push({ row, error: 'DUPLICATE_PHONE' }); return; }
    seen.add(phone.e164);
    valid.push({ ...r.data, phone: phone.e164, row });
  });
  return { valid, errors };
}
export async function readPlayerWorkbook(bytes: Buffer) {
  // Bound ZIP expansion before handing data to the workbook parser.
  if (!bytes.length || bytes.length > 2_000_000) throw new Error('IMPORT_TOO_LARGE');
  let expanded = 0, files = 0;
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (bytes.readUInt32LE(i) !== 0x02014b50) continue;
    expanded += bytes.readUInt32LE(i + 24); files++;
    if (expanded > 20_000_000 || files > 100) throw new Error('IMPORT_TOO_LARGE');
    i += 45 + bytes.readUInt16LE(i + 28) + bytes.readUInt16LE(i + 30) + bytes.readUInt16LE(i + 32);
  }
  if (!files) throw new Error('INVALID_WORKBOOK');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount > 1001 || sheet.columnCount > 30) throw new Error('IMPORT_TOO_LARGE');
  const columns = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, c) => {
    const key = aliases[cellText(cell.value).toLowerCase().replace(/[_-]/g, '')];
    if (key) {
      if ([...columns.values()].includes(key)) throw new Error('DUPLICATE_COLUMN');
      columns.set(c, key);
    }
  });
  if (![...columns.values()].includes('name') || ![...columns.values()].includes('phone')) throw new Error('NAME_PHONE_COLUMNS_REQUIRED');
  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    if (r % 100 === 0) await new Promise<void>(resolve => setImmediate(resolve)); // let other requests run
    const row: Record<string, string> = {};
    for (const [c, key] of columns) { const value = cellText(sheet.getCell(r, c).value); if (value) row[key] = value; }
    if (!Object.keys(row).length) continue;
    if (row.gender) row.gender = ({ 'м': 'MALE', 'ч': 'MALE', 'ж': 'FEMALE', 'male': 'MALE', 'female': 'FEMALE' } as Record<string, string>)[row.gender.toLowerCase()] ?? row.gender.toUpperCase();
    rows.push(row);
    rowNumbers.push(r);
  }
  if (!rows.length) throw new Error('EMPTY_IMPORT');
  return validateImportRows(rows, rowNumbers);
}
export async function playerImportTemplate() {
  const w = new ExcelJS.Workbook(), s = w.addWorksheet('Players');
  s.columns = ['name', 'phone', 'gender', 'birthDate', 'ageCategory', 'skillLevel', 'group', 'category'].map(key => ({ header: key, key, width: 24 }));
  s.addRow({ name: 'Демо гравець', phone: '+380000001001', gender: 'MALE', birthDate: '1998-05-12', ageCategory: 'Adults', skillLevel: 'B', group: 'Основна', category: 'Amateur' });
  s.getRow(1).font = { bold: true };
  return w.xlsx.writeBuffer();
}
