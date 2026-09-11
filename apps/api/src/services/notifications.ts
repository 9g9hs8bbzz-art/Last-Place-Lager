import { prisma } from '../lib/prisma.js';

/**
 * Create a notification, collapsing repeats of the same thing (spec §89).
 * `dedupeKey` is unique per user, so re-running a detector never produces a
 * second copy of an alert the member has already seen.
 */
export async function notify(params: {
  userId: string;
  kind: string;
  title: string;
  body: string;
  link?: string;
  dedupeKey?: string;
}): Promise<void> {
  const { userId, kind, title, body, link, dedupeKey } = params;
  if (dedupeKey) {
    await prisma.notification.upsert({
      where: { userId_dedupeKey: { userId, dedupeKey } },
      create: { userId, kind, title, body, link, dedupeKey },
      // An existing unread alert is refreshed in place rather than duplicated.
      update: { title, body, link },
    });
    return;
  }
  await prisma.notification.create({ data: { userId, kind, title, body, link } });
}

export async function listNotifications(userId: string, limit = 50) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function markRead(userId: string, ids: string[]) {
  await prisma.notification.updateMany({
    where: { userId, id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });
}
