import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword, signAccessToken, issueRefreshToken, consumeRefreshToken, requireAuth } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ displayName: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Enter your name and password.' });

    const user = await prisma.user.findFirst({
      where: { displayName: { equals: body.data.displayName, mode: 'insensitive' }, active: true },
    });
    // The same message either way, so the response cannot be used to discover
    // which names exist.
    const ok = user ? await verifyPassword(user.passwordHash, body.data.password) : false;
    if (!user || !ok) return reply.code(401).send({ error: 'BAD_CREDENTIALS', message: 'That name and password do not match.' });

    const accessToken = signAccessToken({ sub: user.id, role: user.role, name: user.displayName });
    const refreshToken = await issueRefreshToken(user.id);
    await audit({ actorId: user.id, action: 'USER_SIGNED_IN', summary: `${user.displayName} signed in` });

    return { accessToken, refreshToken, user: { id: user.id, displayName: user.displayName, role: user.role } };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = z.object({ refreshToken: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Missing refresh token.' });

    const userId = await consumeRefreshToken(body.data.refreshToken);
    if (!userId) return reply.code(401).send({ error: 'AUTH_INVALID', message: 'Please sign in again.' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      accessToken: signAccessToken({ sub: user.id, role: user.role, name: user.displayName }),
      refreshToken: await issueRefreshToken(user.id),
      user: { id: user.id, displayName: user.displayName, role: user.role },
    };
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req) => {
    await prisma.refreshToken.updateMany({ where: { userId: req.user!.sub, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
    return { id: user.id, displayName: user.displayName, role: user.role, email: user.email };
  });

  app.post('/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(10, 'Use at least 10 characters.') })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: body.error.issues[0]?.message ?? 'Check the form.' });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
    if (!(await verifyPassword(user.passwordHash, body.data.currentPassword))) {
      return reply.code(400).send({ error: 'BAD_CREDENTIALS', message: 'Your current password is not correct.' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.data.newPassword) } });
    await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ actorId: user.id, action: 'PASSWORD_CHANGED', summary: `${user.displayName} changed their password` });
    return { ok: true };
  });
}
