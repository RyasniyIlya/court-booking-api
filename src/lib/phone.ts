/**
 * Нормалізація телефону до E.164.
 * Один номер має мати рівно одне представлення в базі, інакше
 * "067 123 45 67" і "+380671234567" стануть двома різними клієнтами.
 *
 * Зберігаємо нормалізований вигляд у Customer.phone, а те, що ввела людина,
 * не зберігаємо взагалі — воно нікому не потрібне.
 */

export type NormalizedPhone = {
  /** +380671234567 — для пошуку та звірки */
  e164: string;
  /** 1234567 — останні 4+ цифри для швидкого пошуку на ресепшені */
  tail: string;
  /** 067 123 45 67 — для показу адміну */
  pretty: string;
};

/**
 * Приймає українські номери в будь-якому побутовому вигляді.
 * Іноземні номери (гравці-експати трапляються) проходять, якщо
 * починаються з + і мають 8–15 цифр.
 */
export function normalizePhone(raw: string): NormalizedPhone | null {
  if (!raw) return null;

  const hasPlus = raw.trim().startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // 00380... -> 380...
  if (digits.startsWith('00')) digits = digits.slice(2);

  let e164: string;

  if (digits.length === 9 && digits[0] !== '0') {
    // 671234567 — без нуля й коду країни
    e164 = `+380${digits}`;
  } else if (digits.length === 10 && digits.startsWith('0')) {
    // 0671234567
    e164 = `+380${digits.slice(1)}`;
  } else if (digits.length === 12 && digits.startsWith('380')) {
    // 380671234567
    e164 = `+${digits}`;
  } else if (hasPlus && digits.length >= 8 && digits.length <= 15) {
    // іноземний номер — приймаємо як є
    e164 = `+${digits}`;
  } else {
    return null;
  }

  const nat = e164.startsWith('+380') ? e164.slice(4) : e164.slice(1);

  return {
    e164,
    tail: nat.slice(-7),
    pretty: e164.startsWith('+380')
      ? `0${nat.slice(0, 2)} ${nat.slice(2, 5)} ${nat.slice(5, 7)} ${nat.slice(7)}`
      : e164,
  };
}

/** Пошук на ресепшені: адмін вводить 4+ останні цифри */
export function isSearchableTail(input: string): boolean {
  const d = input.replace(/\D/g, '');
  return d.length >= 4 && d.length <= 10;
}
