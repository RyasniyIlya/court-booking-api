export type PlanFeatures = {
  /** Тренери: картки, ціни, прив'язка до броні */
  trainers: boolean;
  /** Групові заняття й продаж місць */
  groups: boolean;
  /** Поглиблена аналітика і картотека клієнтів */
  analytics: boolean;
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
    telegram: plan.tier === 3,
    /* Найвищий тариф, разом із Telegram: обидва — «розумний» шар поверх
       базових броней, і окремого прапорця в базі для нього не заводимо. */
    ai: plan.tier === 3,
  };
}

/**
 * Скільки платить конкретний клуб за період, копійки.
 *
 * Індивідуальна ціна б'є ціну плану — продаємо поштучно, і домовленості
 * різні. `0` — валідна ціна (безкоштовне впровадження, перший клуб у місті),
 * тому перевірка саме на null/undefined, а не на істинність.
 */
export function clubPrice(
  plan: { price: number } | null | undefined,
  override: number | null | undefined,
): number | null {
  if (override !== null && override !== undefined) return override;
  return plan?.price ?? null;
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
