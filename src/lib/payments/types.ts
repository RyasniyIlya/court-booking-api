/**
 * Договір з платіжним провайдером.
 *
 * Сенс шару: підключення другого провайдера — це один новий файл поруч
 * з mono.ts і один рядок у index.ts. Ні роути, ні віджет не знають,
 * хто саме приймає гроші.
 *
 * Гроші йдуть на рахунок КЛУБУ, не наш: у кожного клубу власний
 * мерчант-акаунт і власний токен. Ми не посередник у розрахунках —
 * посередник зобовʼязаний бути фінустановою.
 */

export type CreateInvoiceInput = {
  /** Копійки */
  amountKop: number;
  /** Наш ідентифікатор броні — повертається у вебхуку */
  reference: string;
  /** Що бачить гравець у банку: «Корт 1, 15.08 19:00–20:00» */
  destination: string;
  /** Куди повернути гравця після оплати */
  redirectUrl: string;
  /** Куди провайдер стукає про зміну статусу */
  webHookUrl: string;
  /** Скільки секунд живий рахунок */
  ttlSeconds: number;
};

export type Invoice = {
  /** invoiceId провайдера */
  providerRef: string;
  /** Сторінка оплати */
  pageUrl: string;
};

/** Нормалізований статус — те, що нас цікавить із зоопарку статусів провайдерів */
export type PayEventStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export type WebhookEvent = {
  providerRef: string;
  status: PayEventStatus;
  amountKop?: number;
  /** Час зміни на боці провайдера. Порядок доставки не гарантований,
   *  тому старіша подія не має перетирати новіший стан. */
  at?: Date;
  failReason?: string;
};

export interface PayProvider {
  readonly name: string;
  testConnection?(): Promise<void>;
  createInvoice(input: CreateInvoiceInput): Promise<Invoice>;
  /**
   * Перевіряє підпис і розбирає тіло. Отримує СИРЕ тіло: підпис рахується
   * від байтів, а не від переспареного JSON.
   * Кидає помилку, якщо підпис не збігся.
   */
  parseWebhook(rawBody: Buffer, headers: NodeJS.Dict<string | string[]>): Promise<WebhookEvent>;
  /** Повернення грошей за оплаченою бронню */
  refund(providerRef: string, amountKop: number): Promise<void>;
  /** Погасити невикористаний рахунок, щоб не висів у клуба в кабінеті банку */
  cancelUnpaid(providerRef: string): Promise<void>;
}

export class PaymentError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PaymentError';
  }
}
