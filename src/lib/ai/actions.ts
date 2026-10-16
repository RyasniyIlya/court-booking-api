import { Prisma, type UserRole } from '@prisma/client';

import { prisma } from '../db';
import { effectivePermissions, type ActionScope } from './policy';
import { loadPolicy } from './policyStore';

/**
 * Журнал дій ІІ-менеджера: пропозиція → рішення власника → виконання.
 *
 * Модель сама нічого не змінює в клубі. Вона пропонує дію (`proposeAction`),
 * а далі діє політика власника для ролі того, хто питав: OFF — відмова,
 * ASK — чекає кнопки «Підтвердити», AUTO — виконується одразу. Виконавець
 * (`registerExecutor`) — це звичайна доменна функція, та сама, що в людей;
 * прямого SQL від моделі тут нема.
 *
 * ── Повторна перевірка ───────────────────────────────────────────────────
 * Право перевіряється ще раз у момент виконання, а не лише при пропозиції:
 * між «ІІ запропонував» і «власник натиснув» політика могла змінитись, і
 * вимкнене зараз не має виконатись за вчорашнім дозволом.
 */

export type ActionExecutor = {
  scope: ActionScope;
  execute(clubId: string, payload: unknown): Promise<unknown>;
};

const executors = new Map<string, ActionExecutor>();

export function registerExecutor(kind: string, executor: ActionExecutor): void {
  executors.set(kind, executor);
}

/** Для тестів: чистий реєстр. */
export function resetExecutors(): void {
  executors.clear();
}

export type AiActionErrorCode =
  | 'AI_ACTION_FORBIDDEN'
  | 'AI_ACTION_UNKNOWN_KIND'
  | 'AI_ACTION_NOT_FOUND'
  | 'AI_ACTION_NOT_PENDING'
  | 'AI_ACTION_EXPIRED';

export class AiActionError extends Error {
  constructor(readonly code: AiActionErrorCode) {
    super(code);
    this.name = 'AiActionError';
  }
}

/** Скільки пропозиція чекає рішення: стара пропозиція про «завтра ввечері» вже не про те. */
export const ACTION_TTL_MS = 48 * 3600_000;

const SUMMARY_MAX = 500;
const ERROR_MAX = 500;

type Requester = { id: string | null; role: UserRole };

export async function proposeAction(opts: {
  clubId: string;
  kind: string;
  payload: unknown;
  summary: string;
  requester: Requester;
}) {
  const executor = executors.get(opts.kind);
  /* Без виконавця невідомо, якого права це стосується, — відмовляємо одразу. */
  if (!executor) throw new AiActionError('AI_ACTION_UNKNOWN_KIND');

  const policy = await loadPolicy(opts.clubId);
  const perms = effectivePermissions(policy, opts.requester.role);
  if (!perms.access || perms[executor.scope] === 'OFF') throw new AiActionError('AI_ACTION_FORBIDDEN');

  const row = await prisma.aiAction.create({
    data: {
      clubId: opts.clubId,
      kind: opts.kind,
      payload: opts.payload as Prisma.InputJsonValue,
      summary: opts.summary.slice(0, SUMMARY_MAX),
      requestedById: opts.requester.id,
      requestedRole: opts.requester.role,
      expiresAt: new Date(Date.now() + ACTION_TTL_MS),
    },
  });
  if (perms[executor.scope] !== 'AUTO') return row;

  /* AUTO: рішення прийняла політика, тому decidedById лишається порожнім. */
  const claimed = await claim(row.id, opts.clubId, null);
  return claimed ? runClaimed(row.id, opts.clubId) : row;
}

/** Атомарний перехід: рядок «забирає» лише один виклик, тому подвійний клік не виконає дію двічі. */
async function claim(id: string, clubId: string, decidedById: string | null): Promise<boolean> {
  const { count } = await prisma.aiAction.updateMany({
    where: { id, clubId, status: 'PENDING', decidedAt: null, expiresAt: { gt: new Date() } },
    data: { decidedAt: new Date(), decidedById },
  });
  return count === 1;
}

async function finish(id: string, data: Prisma.AiActionUncheckedUpdateInput) {
  return prisma.aiAction.update({ where: { id }, data });
}

/** Виконує вже «забрану» дію. Помилка виконавця — статус FAILED, а не виняток назовні. */
async function runClaimed(id: string, clubId: string) {
  const action = await prisma.aiAction.findFirstOrThrow({ where: { id, clubId } });
  const executor = executors.get(action.kind);
  const fail = (error: string) => finish(id, { status: 'FAILED', error: error.slice(0, ERROR_MAX) });

  if (!executor) return fail('AI_ACTION_UNKNOWN_KIND');

  const policy = await loadPolicy(action.clubId);
  const perms = effectivePermissions(policy, action.requestedRole);
  if (!perms.access || perms[executor.scope] === 'OFF') return fail('AI_ACTION_FORBIDDEN');

  try {
    const result = await executor.execute(action.clubId, action.payload);
    return await finish(id, {
      status: 'EXECUTED',
      executedAt: new Date(),
      result: (result ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'EXECUTION_FAILED');
  }
}

type Owner = { id: string; clubId: string };

/** Свою дію знаходимо тільки в межах клубу власника: id з іншого клубу = «не знайдено». */
async function loadOwn(id: string, owner: Owner) {
  const action = await prisma.aiAction.findFirst({ where: { id, clubId: owner.clubId } });
  if (!action) throw new AiActionError('AI_ACTION_NOT_FOUND');
  if (action.status !== 'PENDING') throw new AiActionError('AI_ACTION_NOT_PENDING');
  if (action.expiresAt.getTime() <= Date.now()) {
    await prisma.aiAction.updateMany({ where: { id, clubId: owner.clubId, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    throw new AiActionError('AI_ACTION_EXPIRED');
  }
  return action;
}

export async function approveAction(id: string, owner: Owner) {
  await loadOwn(id, owner);
  if (!(await claim(id, owner.clubId, owner.id))) throw new AiActionError('AI_ACTION_NOT_PENDING');
  return runClaimed(id, owner.clubId);
}

export async function rejectAction(id: string, owner: Owner) {
  await loadOwn(id, owner);
  const { count } = await prisma.aiAction.updateMany({
    where: { id, clubId: owner.clubId, status: 'PENDING', decidedAt: null },
    data: { status: 'REJECTED', decidedAt: new Date(), decidedById: owner.id },
  });
  if (count !== 1) throw new AiActionError('AI_ACTION_NOT_PENDING');
  return prisma.aiAction.findFirstOrThrow({ where: { id, clubId: owner.clubId } });
}

/** Прострочені PENDING → EXPIRED перед показом черги, щоб власник не бачив кнопок, які вже не спрацюють. */
export async function expireStaleActions(clubId: string): Promise<void> {
  await prisma.aiAction.updateMany({
    where: { clubId, status: 'PENDING', expiresAt: { lte: new Date() } },
    data: { status: 'EXPIRED' },
  });
}
