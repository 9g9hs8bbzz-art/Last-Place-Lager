// Loads apps/api/.env before the client reads DATABASE_URL, whatever order the
// rest of the module graph happens to import things in.
import './env.js';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/** Postgres unique-violation code, used to detect a lost reservation race. */
export const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(error: unknown, target?: string): boolean {
  const e = error as { code?: string; meta?: { target?: string[] | string } };
  if (e?.code !== UNIQUE_VIOLATION) return false;
  if (!target) return true;
  const t = e.meta?.target;
  const list = Array.isArray(t) ? t : typeof t === 'string' ? [t] : [];
  return list.some((x) => x.includes(target));
}
