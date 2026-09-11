import { prisma } from './prisma.js';

/** Record an action that someone may later need to explain (spec §94). */
export async function audit(params: {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  detail?: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      summary: params.summary,
      detail: params.detail === undefined ? undefined : (params.detail as object),
    },
  });
}
