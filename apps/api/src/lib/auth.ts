import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.js';
import { prisma } from './prisma.js';

export interface AccessClaims {
  sub: string;
  role: 'MEMBER' | 'ADMIN';
  name: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.jwtAccessSecret, { expiresIn: env.accessTokenTtl } as jwt.SignOptions);
}

/**
 * Refresh tokens are random opaque strings. Only their hash is stored, so a
 * database leak does not hand an attacker working sessions.
 */
export async function issueRefreshToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(48).toString('base64url');
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + env.refreshTokenDays * 86_400_000);
  await prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
  return raw;
}

export async function consumeRefreshToken(raw: string): Promise<string | null> {
  const tokenHash = sha256(raw);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row || row.revokedAt || row.expiresAt < new Date()) return null;
  // Rotate: a refresh token is single-use.
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  return row.userId;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessClaims;
  }
}

/**
 * Authentication is a plain bearer token rather than a browser cookie, so the
 * same API serves the web client and any future iOS/Android client unchanged
 * (spec §92).
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'AUTH_REQUIRED', message: 'Please sign in.' });
  }
  try {
    req.user = jwt.verify(header.slice(7), env.jwtAccessSecret) as AccessClaims;
  } catch {
    return reply.code(401).send({ error: 'AUTH_INVALID', message: 'Your session has expired. Please sign in again.' });
  }
}

/** Server-side permission check. The UI hiding a button is never the control (spec §93). */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user?.role !== 'ADMIN') {
    return reply.code(403).send({ error: 'FORBIDDEN', message: 'This action is limited to the parlay manager.' });
  }
}
