import { courtPrice } from './courtPricing';

export type PlanFeatures = {
  /** Тренери: картки, ціни, прив'язка до броні */
  trainers: boolean;
  /** Групові заняття й продаж місць */
  groups: boolean;
  /** Поглиблена аналітика і картотека клієнтів */
  analytics: boolean;
  /** Telegram-бот і Mini App: доступні на будь-якому призначеному тарифі */
  telegram: boolean;
  /** Нейронний менеджер для гравців і нейроаналітик для власника */
  ai: boolean;
};

/** Без призначеного плану платні можливості закриті. */
export const BASE_FEATURES: PlanFeatures = {
  trainers: false,
  groups: false,
  analytics: false,
  telegram: false,
  ai: false,
};

type PlanLike = {
  tier?: number;
  featTrainers: boolean;
  featGroups: boolean;
  featAnalytics: boolean;
} | null | undefined;

/**
 * Права клубу за планом.
 *
 * Приймає сам план, а не клуб: так функцію видно з тестів і з консолі, і
 * вона не тягне за собою форму запиту до бази.
 */
export function planFeatures(plan: PlanLike): PlanFeatures {
  if (!plan) return BASE_FEATURES;

  return {
    trainers: plan.featTrainers,
    groups: plan.featGroups,
    analytics: plan.featAnalytics,
    /* Telegram-бот — із найнижчого тарифу: будь-який призначений план його
       відкриває (боти, нагадування, «приду», Mini App, лист очікування).
       Без плану лишається BASE_FEATURES, тобто закрито. Прапорця в базі
       не заводимо — рахуємо від наявності плану. */
    telegram: Boolean(plan),
    /* ШІ — лише найвищий тариф («Аналітика»). Аналітичні виводи в Telegram
       (зведення, /analytics, win-back) додатково вимагають `analytics`. */
    ai: plan.tier === 3,
  };
}

/**
 * Аналітичні виводи в Telegram (щоденне зведення, /analytics, win-back):
 * бот на тарифі є, а Pro-аналітика — лише на «Аналітика».
 */
export function telegramAnalytics(plan: PlanLike): boolean {
  const f = planFeatures(plan);
  return f.telegram && f.analytics;
}

/**
 * Скільки платить конкретний клуб за період, копійки.
 *
 * Індивідуальна ціна б'є ціну плану — продаємо поштучно, і домовленості
 * різні. `0` — валідна ціна (безкоштовне впровадження, перший клуб у місті),
 * тому перевірка саме на null/undefined, а не на істинність.
 *
 * `courts` — кількість АКТИВНИХ кортів. Ціна плану множиться параболою від
 * кортів (lib/courtPricing.ts), а індивідуальна — ні: це домовленість про
 * весь клуб, а не ставка за корт. Без `courts` поведінка та сама, що була
 * до появи цінника за корти, — старі виклики не зсуваються ні на копійку.
 */
export function clubPrice(
  plan: { price: number } | null | undefined,
  override: number | null | undefined,
  courts?: number | null,
): number | null {
  if (override !== null && override !== undefined) return override;
  if (!plan) return null;
  return courtPrice(plan.price, courts);
}

/** Що вибрати в запиті до бази, щоб порахувати права. Щоб не розходилось. */
export const PLAN_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  price: true,
  period: true,
  tier: true,
  featTrainers: true,
  featGroups: true,
  featAnalytics: true,
} as const;
