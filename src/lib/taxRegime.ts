import { DateTime } from 'luxon';
import { FOP3_LIMIT, FOP3_RATES } from './cashbook';

/**
 * Податок клубу — за обраним режимом, а не завжди ФОП 3 групи.
 *
 * Раніше касова книга (lib/cashbook.ts: taxEstimate/limitUsage/FOP3_LIMIT/
 * FOP3_RATES) рахувала ФОП 3 групи для всіх клубів. Ці функції лишились на
 * місці незмінними — clubs.taxRegime за замовчуванням FOP_3, і цей файл
 * для FOP_3 бере ті самі ставки й ліміт звідти (FOP3_RATES, FOP3_LIMIT), а
 * не дублює числа. Усе, чого там нема, — інші п'ять режимів — живе тут,
 * ОДНИМ місцем, щоб бек (routes/finance.ts) і майбутні звіти рахували
 * однаково.
 *
 * Це оцінка, а не декларація, як і раніше: остаточну суму рахує бухгалтер.
 */

export type TaxRegime =
  | 'FOP_1'
  | 'FOP_2'
  | 'FOP_3'
  | 'FOP_GENERAL'
  | 'TOV_SINGLE_3'
  | 'TOV_GENERAL';

export const TAX_REGIMES: TaxRegime[] = [
  'FOP_1', 'FOP_2', 'FOP_3', 'FOP_GENERAL', 'TOV_SINGLE_3', 'TOV_GENERAL',
];

export const TAX_REGIME_LABEL: Record<TaxRegime, string> = {
  FOP_1: 'ФОП · 1 група',
  FOP_2: 'ФОП · 2 група',
  FOP_3: 'ФОП · 3 група',
  FOP_GENERAL: 'ФОП · загальна система',
  TOV_SINGLE_3: 'ТОВ · єдиний податок 3 група',
  TOV_GENERAL: 'ТОВ · загальна система',
};

/** Юридична форма для угруповання в селекті («ФОП» / «ТОВ»). */
export const TAX_REGIME_ENTITY: Record<TaxRegime, 'FOP' | 'TOV'> = {
  FOP_1: 'FOP', FOP_2: 'FOP', FOP_3: 'FOP', FOP_GENERAL: 'FOP',
  TOV_SINGLE_3: 'TOV', TOV_GENERAL: 'TOV',
};

/** Чи має сенс «платник ПДВ» для цього режиму. */
export function vatApplicable(regime: TaxRegime): boolean {
  return regime === 'FOP_3' || regime === 'TOV_SINGLE_3' || regime === 'TOV_GENERAL';
}

/** Чи можна перекрити типову фіксовану ставку єдиного податку своєю (рада). */
export function fixedTaxApplicable(regime: TaxRegime): boolean {
  return regime === 'FOP_1' || regime === 'FOP_2';
}

type YearRates = {
  /** Мінімальна зарплата на 1 січня, копійки. */
  minWage: number;
  /** Прожитковий мінімум для працездатних на 1 січня, копійки. */
  livingWage: number;
};

/**
 * Показники року. ОНОВЛЮВАТИ ЩОРОКУ В СІЧНІ — та сама політика, що й у
 * FOP3_LIMIT (cashbook.ts): рік, якого тут нема, лишає фіксовані суми й
 * ліміт непорахованими, а не бере минулорічні цифри (застаріле — гірше за
 * відсутнє).
 *
 * 2026: мінімальна зарплата 8 647 грн, прожитковий мінімум для
 * працездатних 3 328 грн (з 1 січня 2026). Ті самі 8 647, з яких зібраний
 * FOP3_LIMIT[2026] у cashbook.ts — 1167 × 864700 = 1_009_104_900. Якщо
 * міняєте minWage тут, звірте FOP3_LIMIT там (є тест на це в
 * taxRegime.test.ts).
 */
export const TAX_YEAR_RATES: Record<number, YearRates> = {
  2026: { minWage: 864_700, livingWage: 332_800 },
};

/** Річний ліміт доходу — множник на мінімальну зарплату року. Немає — без ліміту. */
const LIMIT_MULTIPLIER: Partial<Record<TaxRegime, number>> = {
  FOP_1: 167,
  FOP_2: 834,
  FOP_3: 1167,
  TOV_SINGLE_3: 1167,
};

/** Копійки, або null — режим без ліміту чи рік без внесених показників. */
export function taxLimit(regime: TaxRegime, year: number): number | null {
  const mult = LIMIT_MULTIPLIER[regime];
  if (!mult) return null;
  const rates = TAX_YEAR_RATES[year];
  if (!rates) return null;
  return mult * rates.minWage;
}

export type LimitUsage = { year: number; limit: number; used: number; pct: number };

/** Той самий формат, що й cashbook.limitUsage, але для будь-якого режиму. */
export function regimeLimitUsage(regime: TaxRegime, yearIncome: number, year: number): LimitUsage | null {
  const limit = taxLimit(regime, year);
  if (!limit) return null;
  const used = Math.max(0, yearIncome);
  return { year, limit, used, pct: Math.round((used / limit) * 1000) / 10 };
}

/**
 * Скільки календарних місяців (у таймзоні клубу) захоплює період — для
 * фіксованих режимів (FOP_1/FOP_2): місяць зачепило хоч одним днем —
 * рахується цілим, як і сама фіксована сума, яка не ділиться на дні.
 */
export function monthsOverlapped(from: Date, to: Date, tz: string): number {
  const start = DateTime.fromJSDate(from).setZone(tz).startOf('month');
  const end = DateTime.fromJSDate(to).setZone(tz).startOf('month');
  return Math.max(1, Math.round(end.diff(start, 'months').months) + 1);
}

export type TaxLine = { key: string; label: string; rate?: string; amount: number };

export type TaxEstimateResult = {
  regime: TaxRegime;
  regimeLabel: string;
  vatPayer: boolean;
  /** База розрахунку, копійки: дохід (мінус ПДВ, де застосовно) або прибуток. */
  base: number;
  lines: TaxLine[];
  total: number;
  notes: string[];
};

/** Мінімум, потрібний від ClubExpense для оцінки прибутку. */
export type TaxExpenseLike = { category: string; amount: number };

export type TaxEstimateInput = {
  regime: TaxRegime;
  /** Прапорець клубу. Для режимів, де ПДВ не застосовний, ігнорується. */
  vatPayer: boolean;
  /** Копійки. Перекриває типову фіксовану ставку для FOP_1/FOP_2. */
  taxFixedMonthly: number | null;
  /** Копійки. Дохід періоду — summary.net каси (без бонусів). */
  income: number;
  /**
   * Витрати клубу за період — усі, як є в базі. Категорію TAX (єдиний
   * податок, військовий збір, ЄСВ) виключаємо тут, в одному місці: інакше
   * податок на прибуток зменшував би сам себе, а лишити фільтр на боці
   * роута означало б другий шанс забути про нього.
   */
  expenses: TaxExpenseLike[];
  from: Date;
  to: Date;
  tz: string;
};

/** 3% — ставка єдиного податку 3 групи (ФОП і ТОВ) для платника ПДВ. */
const SINGLE_TAX_VAT_RATE = 0.03;
const PDFO_RATE = 0.18;
const PDFO_MILITARY_RATE = 0.05;
const PROFIT_TAX_RATE = 0.18;

const pct = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

/** Дохід без ПДВ: сума прийшла з ПДВ усередині, база — ×100/120. */
const withoutVat = (income: number) => Math.round((income * 100) / 120);

export function estimateTax(input: TaxEstimateInput): TaxEstimateResult {
  const { regime, taxFixedMonthly, from, to, tz } = input;
  /* Мінус не дає відʼємного податку: місяць пішов у повернення більше, ніж
     надійшло, — база нуль, а не «податок на клуб». */
  const income = Math.max(0, input.income);
  const nonTaxExpenses = input.expenses.filter((e) => e.category !== 'TAX');
  const expenses = nonTaxExpenses.reduce((s, e) => s + e.amount, 0);
  const hasExpenses = nonTaxExpenses.length > 0;
  const vatPayer = vatApplicable(regime) && input.vatPayer;
  const notes: string[] = [];
  /* ПДВ саму суму ми не рахуємо ніде: платник дізнається її від бухгалтера,
     тут лише позначка, що вона є і не входить у цифри нижче. */
  if (vatPayer) notes.push('ПДВ не оцінюється — його рахує бухгалтер.');

  const year = DateTime.fromJSDate(to).setZone(tz).year;
  const rates = TAX_YEAR_RATES[year];
  const lines: TaxLine[] = [];
  let base = income;

  if (regime === 'FOP_1' || regime === 'FOP_2') {
    const months = monthsOverlapped(from, to, tz);
    const defaultSingle = regime === 'FOP_1'
      ? (rates ? Math.round(rates.livingWage * 0.10) : null)
      : (rates ? Math.round(rates.minWage * 0.20) : null);
    const fixedSingle = taxFixedMonthly ?? defaultSingle;

    if (fixedSingle != null) {
      lines.push({ key: 'single', label: 'Єдиний податок (фіксовано)', amount: fixedSingle * months });
    } else {
      notes.push(`Ставка єдиного податку на ${year} рік не задана — вкажіть суму в налаштуваннях клубу.`);
    }

    if (rates) {
      const fixedMilitary = Math.round(rates.minWage * 0.10);
      lines.push({ key: 'military', label: 'Військовий збір (фіксовано)', amount: fixedMilitary * months });
    } else {
      notes.push(`Показники на ${year} рік ще не внесено в систему — військовий збір не пораховано.`);
    }

    /* Фіксовані режими не рахуються «від доходу» — базу показувати нема
       чим, нуль тут означає «дивись рядки», а не «дохід нульовий». */
    base = 0;
  } else if (regime === 'FOP_3' || regime === 'TOV_SINGLE_3') {
    const rate = vatPayer ? SINGLE_TAX_VAT_RATE : FOP3_RATES.singleTax;
    base = vatPayer ? withoutVat(income) : income;
    lines.push({ key: 'single', label: 'Єдиний податок', rate: pct(rate), amount: Math.round(base * rate) });

    if (regime === 'FOP_3') {
      /* Та сама база, що й у єдиного податку: платнику ПДВ обидва рахунки
         йдуть без ПДВ, окремої «повної» бази для збору нема. */
      lines.push({
        key: 'military', label: 'Військовий збір', rate: pct(FOP3_RATES.military),
        amount: Math.round(base * FOP3_RATES.military),
      });
    } else {
      notes.push('Юридична особа — військовий збір не сплачується.');
    }
  } else {
    /* FOP_GENERAL / TOV_GENERAL — від прибутку: дохід мінус витрати клубу
       за період, БЕЗ категорії TAX (інакше податок зменшував би сам себе). */
    const profit = Math.max(0, income - expenses);
    base = profit;
    if (!hasExpenses) {
      notes.push('За період не внесено жодної витрати клубу — база може бути завищена.');
    }
    if (regime === 'FOP_GENERAL') {
      lines.push({ key: 'pdfo', label: 'ПДФО', rate: pct(PDFO_RATE), amount: Math.round(profit * PDFO_RATE) });
      lines.push({
        key: 'military', label: 'Військовий збір', rate: pct(PDFO_MILITARY_RATE),
        amount: Math.round(profit * PDFO_MILITARY_RATE),
      });
    } else {
      lines.push({ key: 'profit', label: 'Податок на прибуток', rate: pct(PROFIT_TAX_RATE), amount: Math.round(profit * PROFIT_TAX_RATE) });
      notes.push('Юридична особа — військовий збір не сплачується.');
    }
  }

  return {
    regime,
    regimeLabel: TAX_REGIME_LABEL[regime],
    vatPayer,
    base,
    lines,
    total: lines.reduce((s, l) => s + l.amount, 0),
    notes,
  };
}
