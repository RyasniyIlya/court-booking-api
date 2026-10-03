/**
 * Версія юридичних документів (docs/legal). Формат РРРР-ММ, порівнюється
 * як рядок. Змінюється, коли виходить нова редакція Угоди, Правил, Політики
 * чи Оферти.
 */
export const LEGAL_VERSION = '2026-09';

type ConsentState = {
  termsAcceptedAt?: Date | null;
  termsVersion?: string | null;
  marketingConsentAt?: Date | null;
};

/**
 * Що дописати в картку гравця за галочками форми. null — нічого міняти.
 *
 * Дата й версія оновлюються, лише коли були порожні або версія старіша
 * за поточну; маркетинг-згоду ставимо один раз і не знімаємо тут.
 */
export function consentUpdate(
  customer: ConsentState,
  input: { acceptedTerms?: boolean; marketingConsent?: boolean },
  now: Date = new Date(),
): { termsAcceptedAt?: Date; termsVersion?: string; marketingConsentAt?: Date } | null {
  const data: { termsAcceptedAt?: Date; termsVersion?: string; marketingConsentAt?: Date } = {};
  if (
    input.acceptedTerms === true &&
    (!customer.termsAcceptedAt || !customer.termsVersion || customer.termsVersion < LEGAL_VERSION)
  ) {
    data.termsAcceptedAt = now;
    data.termsVersion = LEGAL_VERSION;
  }
  if (input.marketingConsent === true && !customer.marketingConsentAt) {
    data.marketingConsentAt = now;
  }
  return Object.keys(data).length ? data : null;
}
