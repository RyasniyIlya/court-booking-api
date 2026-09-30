import { DateTime } from 'luxon';

/**
 * Автоматичний журнал оператора: кожна дія, що міняє гроші, план чи доступ
 * клубу, лишає рядок CrmActivity(kind: SYSTEM). Через пів року на питання
 * «хто й коли це виправив» має бути що відповісти, а памʼять оператора на
 * трьохстах клубах — не відповідь.
 */

/** Копійки -> «3 450 грн». Копійки показуємо лише коли вони є. */
export function fmtUah(kopecks: number): string {
  const grn = kopecks / 100;
  const text = Number.isInteger(grn) ? String(grn) : grn.toFixed(2);
  const [int, frac] = text.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${frac ? `${grouped}.${frac}` : grouped} грн`;
}

/** Дата для тексту журналу: 12.12.2026, за київським часом — так її бачить оператор */
export function fmtDate(date: Date): string {
  return DateTime.fromJSDate(date).setZone('Europe/Kyiv').toFormat('dd.LL.yyyy');
}

/** Рядок для prisma.crmActivity.create — одне місце, де зібрано форму запису */
export function systemNote(clubId: string, text: string, author: string | null | undefined) {
  return {
    data: {
      clubId,
      kind: 'SYSTEM' as const,
      text,
      author: author ?? 'system',
    },
  };
}
