/**
 * Як назвати бронь у повідомленні клубу.
 *
 * У приватної броні є імʼя клієнта, у групового заняття — назва, і одного
 * поля на обидва випадки в схемі немає навмисно (див. ГРУПОВІ-ЗАНЯТТЯ.md).
 * Тому кожне місце, яке друкує «хто це», має вибрати саме тут — інакше
 * група підписалась би «Без імені».
 *
 * Дзеркало web/src/lib/booking.js: одна й та сама бронь має називатись
 * однаково в кабінеті й у Telegram.
 */
export function bookingLabel(b: {
  title?: string | null;
  customerName?: string | null;
  capacity?: number | null;
}): string {
  if (b.capacity != null) return b.title || 'Групове заняття';
  return b.customerName || 'Без імені';
}

/** Рядок «хто» для повідомлення: імʼя й телефон, якщо вони є. */
export function bookingWho(b: {
  title?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  capacity?: number | null;
}): string {
  const label = bookingLabel(b);
  return b.customerPhone ? `${label}, ${b.customerPhone}` : label;
}
