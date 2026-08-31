/**
 * Текстові стовпчики для Telegram.
 *
 * Чому не картинка: справжній графік у месенджері означає canvas у
 * Docker-образі — системні шрифти, cairo і десяток мегабайтів у збірці
 * заради семи стовпчиків. Символьний рядок читається з телефона так само
 * добре, малюється миттєво і не додає жодної залежності.
 *
 * Модуль навмисно нічого не знає ні про броні, ні про гроші: на вхід
 * підписи й числа, на виході рядки. Тому його видно в тестах повністю.
 */

/** Восьмі частини блока — щоб різниця в 5% не зникала у ширині стовпчика */
const PARTS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const FULL = '█';

export type Bar = { label: string; value: number };

export type ChartOptions = {
  /** Скільки символів у найдовшого стовпчика. 10 — межа читабельності на телефоні */
  width?: number;
  /** Як показати число праворуч від стовпчика */
  format?: (value: number) => string;
};

/**
 * Один стовпчик у символах.
 *
 * Ненульове, але дуже мале значення отримує хоча б одну восьму: нуль і
 * «майже нуль» мають виглядати по-різному, інакше день із однією бронню
 * не відрізнити від порожнього.
 */
function bar(value: number, max: number, width: number): string {
  if (value <= 0 || max <= 0) return '';

  const eighths = Math.round((value / max) * width * 8);
  const safe = Math.max(eighths, 1);

  return FULL.repeat(Math.floor(safe / 8)) + PARTS[safe % 8];
}

/**
 * Рядки графіка: підпис, стовпчик, число.
 *
 * Підписи вирівнюються пробілами до однакової довжини — у Telegram текст
 * має стояти в <pre>, інакше пропорційний шрифт з'їсть вирівнювання і
 * стовпчики поїдуть сходинкою.
 */
export function barChart(rows: Bar[], options: ChartOptions = {}): string {
  if (rows.length === 0) return '';

  const width = options.width ?? 10;
  const format = options.format ?? ((v: number) => String(v));

  const max = Math.max(...rows.map((r) => r.value), 0);
  const pad = Math.max(...rows.map((r) => r.label.length));

  const values = rows.map((r) => format(r.value));
  /* Числа вирівнюємо ПО ПРАВОМУ краю: у стовпчику сум це єдиний спосіб
     порівнювати їх поглядом — розряди стоять під розрядами. Ліве
     вирівнювання дало б «890» і «8 900», що починаються однаково. */
  const numPad = Math.max(...values.map((v) => v.length));

  return rows
    .map((r, i) => {
      const label = r.label.padEnd(pad, ' ');
      const filled = bar(r.value, max, width);
      /* Стовпчик добиваємо пробілами до повної ширини, щоб числа праворуч
         стояли одне під одним, а не рвались за довжиною стовпчика. */
      const cell = filled.padEnd(width, ' ');
      return `${label} ${cell} ${values[i].padStart(numPad, ' ')}`;
    })
    .join('\n');
}

/**
 * Злити дрібні стовпчики у більші.
 *
 * Тридцять днів окремими рядками — це стіна тексту, яку в месенджері
 * гортають, а не читають. Згорнуті в тижні, ті самі дані показують те, за
 * чим на них дивляться: місяць росте чи падає.
 *
 * Ділимо з кінця, щоб останній (сьогоднішній) відрізок був повним: якщо
 * ділити з початку, неповним виявиться саме той тиждень, у якому клуб
 * зараз живе, і він виглядатиме провалом.
 */
export function groupBars<T extends { label: string; value: number }>(
  rows: T[],
  size: number,
  label: (chunk: T[]) => string,
): Bar[] {
  if (size < 2 || rows.length <= size) {
    return rows.map((r) => ({ label: r.label, value: r.value }));
  }

  const out: Bar[] = [];

  for (let end = rows.length; end > 0; end -= size) {
    const chunk = rows.slice(Math.max(end - size, 0), end);
    out.unshift({ label: label(chunk), value: chunk.reduce((s, r) => s + r.value, 0) });
  }

  return out;
}
