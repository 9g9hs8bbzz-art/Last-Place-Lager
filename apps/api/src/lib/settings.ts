import { prisma } from './prisma.js';
import { DEFAULT_GUIDELINE, type OddsGuideline } from '@fcp/shared';
import { env } from './env.js';

/** Runtime settings an administrator can change without a redeploy (spec §30, §20). */
export interface ReaderSettings {
  enabled: boolean;
  requestBudgetPerRun: number;
  minDelayMs: number;
  maxDelayMs: number;
  /** Confirmed-absent reads required before a market is called unavailable (spec §33). */
  removalConfirmations: number;
}

const KEY_GUIDELINE = 'odds.guideline';
const KEY_READER = 'reader.sbm';

export async function getGuideline(): Promise<OddsGuideline> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_GUIDELINE } });
  return { ...DEFAULT_GUIDELINE, ...((row?.value as Partial<OddsGuideline>) ?? {}) };
}

export async function setGuideline(value: OddsGuideline, updatedById?: string): Promise<OddsGuideline> {
  await prisma.appSetting.upsert({
    where: { key: KEY_GUIDELINE },
    create: { key: KEY_GUIDELINE, value: { ...value }, updatedById },
    update: { value: { ...value }, updatedById },
  });
  return value;
}

export async function getReaderSettings(): Promise<ReaderSettings> {
  const defaults: ReaderSettings = {
    enabled: env.sbm.enabled,
    requestBudgetPerRun: env.sbm.requestBudgetPerRun,
    minDelayMs: env.sbm.minDelayMs,
    maxDelayMs: env.sbm.maxDelayMs,
    removalConfirmations: 2,
  };
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_READER } });
  return { ...defaults, ...((row?.value as Partial<ReaderSettings>) ?? {}) };
}

export async function setReaderSettings(patch: Partial<ReaderSettings>, updatedById?: string): Promise<ReaderSettings> {
  const next = { ...(await getReaderSettings()), ...patch };
  await prisma.appSetting.upsert({
    where: { key: KEY_READER },
    create: { key: KEY_READER, value: { ...next }, updatedById },
    update: { value: { ...next }, updatedById },
  });
  return next;
}
