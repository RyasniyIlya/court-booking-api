import { prisma } from '../db';
import { normalizePolicy, type AiPolicy, type PolicyBody } from './policy';

/** Політика клубу. Немає рядка — типові права; зіпсований рядок нормалізується, а не кидає. */
export async function loadPolicy(clubId: string): Promise<AiPolicy> {
  const row = await prisma.aiAgentPolicy.findUnique({ where: { clubId } });
  return normalizePolicy(row as Record<string, unknown> | null);
}

/** Єдине місце запису: викликається тільки з OWNER-роута. */
export async function savePolicy(clubId: string, body: PolicyBody, userId: string): Promise<{ policy: AiPolicy; updatedAt: Date }> {
  const { roleAccess, ...own } = body;
  const data = { ...own, roleAccess, updatedById: userId };
  const row = await prisma.aiAgentPolicy.upsert({
    where: { clubId },
    create: { clubId, ...data },
    update: data,
  });
  return { policy: normalizePolicy(row as Record<string, unknown>), updatedAt: row.updatedAt };
}
