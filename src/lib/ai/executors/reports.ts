import { ActionInvalidError, registerExecutor } from '../actions';
import { REPORT_LABELS, reportParamsSchema } from '../reportFile';
import { parsePayload } from './common';

/**
 * `report.xlsx`: звіт-файл на запит. Тільки читає, тому право `reports` — булеве
 * «вкл/викл», а виконується звіт одразу, без підтвердження (див. modeOf у actions.ts).
 *
 * Сам файл тут не будується й не зберігається: результат — лише параметри.
 * Книгу збирає GET /api/admin/ai/actions/:id/file під поточними правами того,
 * хто качає (reportFile.ts).
 */
registerExecutor('report.xlsx', {
  scope: 'reports',
  readOnly: true,
  async prepare(_clubId, raw) {
    const p = parsePayload(reportParamsSchema, raw, 'Звіт');
    if (!REPORT_LABELS[p.type]) throw new ActionInvalidError('Невідомий тип звіту.');
    return { payload: p, summary: `Звіт «${REPORT_LABELS[p.type]}»: ${p.from} — ${p.to}` };
  },
  async execute(_clubId, raw) {
    const p = parsePayload(reportParamsSchema, raw, 'Звіт');
    return { type: p.type, from: p.from, to: p.to };
  },
});
