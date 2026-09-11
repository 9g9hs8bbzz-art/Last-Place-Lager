/**
 * Historical spreadsheet import (spec §79-§84).
 *
 * The workbook is the source; the database becomes authoritative afterwards.
 * The canonical cleanup decisions in @fcp/shared are applied here and are never
 * rediscovered: the 2026 template sheet is ignored, the duplicated 2025 block
 * on "All Time" is excluded, Excel's date-mangled scores are restored, and any
 * APPROVED correction beats the raw cell every time (spec §83).
 */
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import {
  WORKBOOK_RULES,
  INITIAL_ROSTER,
  isDeclaredWeekOff,
  isConfirmedPlayed,
  isMangledScoreCell,
  restoreScoreFromMangledDate,
  parseAmerican,
  DECLARED_WEEKS_OFF,
} from '@fcp/shared';

export interface RawPickRow {
  seasonYear: number;
  weekNumber: number;
  bettorName: string;
  pickText: string;
  americanOdds: number | null;
  matchupText: string | null;
  outcomeText: string | null;
  result: 'WIN' | 'LOSS' | 'PUSH' | 'VOID' | 'PENDING';
  sourceSheet: string;
  sourceRow: number;
  sourceCol: number;
  /** True when the value came back from an Excel date-mangled score cell. */
  scoreRestored: boolean;
}

export interface ImportPreview {
  seasonsFound: number[];
  weeksFound: { season: number; week: number }[];
  uniquePicksFound: number;
  duplicatesExcluded: number;
  usersMatched: string[];
  usersUnmatched: string[];
  weekOffs: { season: number; week: number; declared: boolean; hasSourceData: boolean }[];
  overridesApplied: number;
  scoresRestored: number;
  needsReview: RawPickRow[];
  conflicts: { scope: string; season?: number; week?: number; bettor?: string; field?: string; rawValue?: string | null; acceptedValue?: string | null; resolution: string; detail: string }[];
  rows: RawPickRow[];
}

const LABEL_OFFSETS = { pick: 'Pick', odds: 'Odds', matchup: 'Matchup', outcome: 'Outcome', wl: 'W/L' } as const;

/**
 * Read every pick out of the workbook, applying the structural cleanup rules
 * but NOT yet the record-level corrections.
 */
export async function readWorkbook(filePath: string): Promise<{ rows: RawPickRow[]; duplicatesExcluded: number; scoresRestored: number }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const rows: RawPickRow[] = [];
  let duplicatesExcluded = 0;
  let scoresRestored = 0;

  for (const sheet of wb.worksheets) {
    // The 2026 sheet is a formatting template with no real picks (spec §80).
    if ((WORKBOOK_RULES.ignoredSheets as readonly string[]).includes(sheet.name)) continue;

    const isAllTime = sheet.name === WORKBOOK_RULES.allTimeSheet;
    const blocks = findWeekBlocks(sheet);

    // On "All Time" the 2024 records run until the week numbering restarts;
    // everything after that restart is the duplicated 2025 block (spec §80).
    let duplicateBoundary = blocks.length;
    if (isAllTime) {
      for (let i = 1; i < blocks.length; i++) {
        if (blocks[i].weekNumber < blocks[i - 1].weekNumber && blocks[i].weekNumber === 1) {
          duplicateBoundary = i;
          break;
        }
      }
    }

    for (const [index, block] of blocks.entries()) {
      const seasonYear = isAllTime ? 2024 : Number(sheet.name);
      if (!Number.isFinite(seasonYear)) continue;

      if (isAllTime && index >= duplicateBoundary) {
        // A duplicate copy of the dedicated 2025 sheet. Counted, not imported.
        duplicatesExcluded += countPicksInBlock(sheet, block);
        continue;
      }

      const labelRows = locateLabelRows(sheet, block.headerRow);
      if (!labelRows) continue;

      for (let col = 3; col <= 12; col++) {
        const bettorName = cellText(sheet, block.headerRow, col);
        const pickText = cellText(sheet, labelRows.pick, col);
        if (!bettorName || !pickText) continue;

        const oddsCell = sheet.getCell(labelRows.odds, col).value;
        const americanOdds = parseAmerican(typeof oddsCell === 'number' ? oddsCell : String(oddsCell ?? ''));

        const outcomeRaw = sheet.getCell(labelRows.outcome, col).value;
        let outcomeText: string | null;
        let scoreRestored = false;
        if (isMangledScoreCell(outcomeRaw)) {
          // Excel turned a score like "21-6" into a date. Restore it (spec §82).
          outcomeText = restoreScoreFromMangledDate(outcomeRaw);
          scoreRestored = true;
          scoresRestored += 1;
        } else {
          outcomeText = cellText(sheet, labelRows.outcome, col) || null;
        }

        const wl = cellText(sheet, labelRows.wl, col).toUpperCase();
        const result = wl === 'W' ? 'WIN' : wl === 'L' ? 'LOSS' : wl === 'P' ? 'PUSH' : 'PENDING';

        rows.push({
          seasonYear,
          weekNumber: block.weekNumber,
          bettorName,
          pickText,
          americanOdds,
          matchupText: cellText(sheet, labelRows.matchup, col) || null,
          outcomeText,
          result,
          sourceSheet: sheet.name,
          sourceRow: labelRows.pick,
          sourceCol: col,
          scoreRestored,
        });
      }
    }
  }

  return { rows, duplicatesExcluded, scoresRestored };
}

function findWeekBlocks(sheet: ExcelJS.Worksheet) {
  const blocks: { headerRow: number; weekNumber: number }[] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const label = cellText(sheet, r, 1);
    const match = /^week\s+(\d+)/i.exec(label);
    if (match) blocks.push({ headerRow: r, weekNumber: Number(match[1]) });
  }
  return blocks;
}

function locateLabelRows(sheet: ExcelJS.Worksheet, headerRow: number) {
  const found: Record<string, number> = {};
  for (let r = headerRow + 1; r <= Math.min(headerRow + 8, sheet.rowCount); r++) {
    const label = cellText(sheet, r, 1);
    for (const [key, expected] of Object.entries(LABEL_OFFSETS)) {
      if (label.toLowerCase() === expected.toLowerCase() && found[key] === undefined) found[key] = r;
    }
  }
  if (found.pick === undefined || found.odds === undefined || found.wl === undefined) return null;
  return {
    pick: found.pick,
    odds: found.odds,
    matchup: found.matchup ?? found.pick + 2,
    outcome: found.outcome ?? found.pick + 3,
    wl: found.wl,
  };
}

function countPicksInBlock(sheet: ExcelJS.Worksheet, block: { headerRow: number }) {
  const labels = locateLabelRows(sheet, block.headerRow);
  if (!labels) return 0;
  let n = 0;
  for (let col = 3; col <= 12; col++) if (cellText(sheet, labels.pick, col)) n += 1;
  return n;
}

function cellText(sheet: ExcelJS.Worksheet, row: number, col: number): string {
  const v = sheet.getCell(row, col).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in v) {
    return (v.richText as { text: string }[]).map((t) => t.text).join('').trim();
  }
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text).trim();
  if (typeof v === 'object' && 'result' in v) return String((v as { result: unknown }).result ?? '').trim();
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/**
 * Build the preview shown to the administrator before anything is written
 * (spec §84), with every approved correction already applied.
 */
export async function buildPreview(filePath: string, fileName: string): Promise<ImportPreview> {
  const { rows, duplicatesExcluded, scoresRestored } = await readWorkbook(filePath);

  const corrections = await prisma.historicalCorrection.findMany({
    where: { entityType: 'HistoricalPick', status: 'APPROVED' },
  });

  const conflicts: ImportPreview['conflicts'] = [];
  let overridesApplied = 0;

  for (const row of rows) {
    const applicable = corrections.filter(
      (c) =>
        c.seasonYear === row.seasonYear &&
        c.weekNumber === row.weekNumber &&
        c.bettorName?.toLowerCase() === row.bettorName.toLowerCase(),
    );
    for (const c of applicable) {
      const rawValue = c.field === 'matchup' ? row.matchupText : c.field === 'outcome' ? row.outcomeText : row.result;

      // An approved correction always wins over the raw source, and any
      // disagreement is flagged for audit rather than resolved silently (spec §82).
      if (String(rawValue ?? '') !== c.correctedValue) {
        conflicts.push({
          scope: 'CORRECTION_APPLIED',
          season: row.seasonYear,
          week: row.weekNumber,
          bettor: row.bettorName,
          field: c.field,
          rawValue: rawValue === null || rawValue === undefined ? null : String(rawValue),
          acceptedValue: c.correctedValue,
          resolution: 'ACCEPTED_CORRECTION_WINS',
          detail: c.reason,
        });
      }

      if (c.field === 'matchup') row.matchupText = c.correctedValue;
      else if (c.field === 'outcome') row.outcomeText = c.correctedValue;
      else if (c.field === 'result') row.result = c.correctedValue as RawPickRow['result'];
      overridesApplied += 1;
    }
  }

  const seasons = [...new Set(rows.map((r) => r.seasonYear))].sort();
  const weekKeys = [...new Set(rows.map((r) => `${r.seasonYear}:${r.weekNumber}`))];
  const weeksFound = weekKeys.map((k) => ({ season: Number(k.split(':')[0]), week: Number(k.split(':')[1]) }));

  const dbUsers = await prisma.user.findMany();
  const bettorNames = [...new Set(rows.map((r) => r.bettorName))];
  const usersMatched = bettorNames.filter((n) => dbUsers.some((u) => matchesUser(u, n)));
  const usersUnmatched = bettorNames.filter((n) => !usersMatched.includes(n));

  // Week Off reconciliation.
  const weekOffs: ImportPreview['weekOffs'] = [];
  for (const declared of DECLARED_WEEKS_OFF) {
    const hasSourceData = rows.some((r) => r.seasonYear === declared.season && r.weekNumber === declared.week);
    weekOffs.push({ season: declared.season, week: declared.week, declared: true, hasSourceData });

    if (hasSourceData) {
      // The declared Week Off list and the workbook disagree. Neither is
      // discarded: the picks import and the discrepancy is raised once for the
      // administrator to settle (spec §82, §84).
      conflicts.push({
        scope: 'WEEK_OFF_HAS_DATA',
        season: declared.season,
        week: declared.week,
        resolution: 'IMPORT_PICKS_AND_FLAG',
        detail:
          `${declared.season} Week ${declared.week} is on the accepted Week Off list, but the workbook contains ` +
          `${rows.filter((r) => r.seasonYear === declared.season && r.weekNumber === declared.week).length} picks for it. ` +
          `The picks have been imported and the week is marked as played so the historical totals stay correct. ` +
          `An administrator should confirm whether this week really was a Week Off.`,
      });
    }
  }

  // Weeks that are simply absent from a season's run are treated as Week Offs.
  for (const season of seasons) {
    const seasonWeeks = weeksFound.filter((w) => w.season === season).map((w) => w.week).sort((a, b) => a - b);
    if (seasonWeeks.length === 0) continue;
    for (let w = seasonWeeks[0]; w <= seasonWeeks[seasonWeeks.length - 1]; w++) {
      if (seasonWeeks.includes(w)) continue;
      if (weekOffs.some((x) => x.season === season && x.week === w)) continue;
      weekOffs.push({ season, week: w, declared: isDeclaredWeekOff(season, w), hasSourceData: false });
    }
  }

  const needsReview = rows.filter((r) => r.americanOdds === null || r.result === 'PENDING');

  return {
    seasonsFound: seasons,
    weeksFound,
    uniquePicksFound: rows.length,
    duplicatesExcluded,
    usersMatched,
    usersUnmatched,
    weekOffs,
    overridesApplied,
    scoresRestored,
    needsReview,
    conflicts,
    rows,
  };
}

function matchesUser(user: { displayName: string; legacyName: string | null }, name: string) {
  const n = name.trim().toLowerCase();
  return user.displayName.toLowerCase() === n || (user.legacyName ?? '').toLowerCase() === n;
}

/** Write the previewed import to the database. */
export async function applyImport(filePath: string, fileName: string, actorId: string | null) {
  const preview = await buildPreview(filePath, fileName);

  const record = await prisma.historicalImport.create({
    data: {
      fileName,
      status: 'PREVIEW',
      seasonsFound: preview.seasonsFound.length,
      weeksFound: preview.weeksFound.length,
      uniquePicksFound: preview.uniquePicksFound,
      duplicatesExcluded: preview.duplicatesExcluded,
      usersMatched: preview.usersMatched.length,
      weekOffsFound: preview.weekOffs.length,
      overridesApplied: preview.overridesApplied,
      needsReviewCount: preview.needsReview.length,
      previewJson: {
        seasonsFound: preview.seasonsFound,
        weeksFound: preview.weeksFound,
        uniquePicksFound: preview.uniquePicksFound,
        duplicatesExcluded: preview.duplicatesExcluded,
        usersMatched: preview.usersMatched,
        usersUnmatched: preview.usersUnmatched,
        weekOffs: preview.weekOffs,
        overridesApplied: preview.overridesApplied,
        scoresRestored: preview.scoresRestored,
        conflicts: preview.conflicts,
      },
    },
  });

  const users = await prisma.user.findMany();

  // Seasons and weeks.
  for (const season of preview.seasonsFound) {
    await prisma.season.upsert({
      where: { year: season },
      create: { year: season, label: `${season} Season` },
      update: {},
    });
  }

  const weekIds = new Map<string, string>();
  const allWeeks = [
    ...preview.weeksFound,
    ...preview.weekOffs.filter((w) => !w.hasSourceData).map((w) => ({ season: w.season, week: w.week })),
  ];
  for (const { season, week } of allWeeks) {
    const seasonRow = await prisma.season.findUniqueOrThrow({ where: { year: season } });
    const hasPicks = preview.rows.some((r) => r.seasonYear === season && r.weekNumber === week);
    const declaredOff = isDeclaredWeekOff(season, week);

    // A week with real picks is a played week even if it appears on the Week
    // Off list; the discrepancy has already been raised as a conflict.
    // A week the group has explicitly reviewed and confirmed was played can
    // never be turned back into a Week Off, whatever the source looks like
    // (spec §83) — 2024 Week 6 is the settled case.
    const isWeekOff = !hasPicks && !isConfirmedPlayed(season, week);

    const row = await prisma.nFLWeek.upsert({
      where: { seasonId_weekNumber: { seasonId: seasonRow.id, weekNumber: week } },
      create: {
        seasonId: seasonRow.id,
        weekNumber: week,
        status: isWeekOff ? 'WEEK_OFF' : 'SETTLED',
        weekOffReason: isWeekOff
          ? declaredOff
            ? 'Intentionally skipped — recorded as a Week Off in the group history.'
            : 'No parlay recorded for this week.'
          : null,
        weekOffSetAt: isWeekOff ? new Date() : null,
      },
      update: {
        status: isWeekOff ? 'WEEK_OFF' : 'SETTLED',
        weekOffReason: isWeekOff
          ? declaredOff
            ? 'Intentionally skipped — recorded as a Week Off in the group history.'
            : 'No parlay recorded for this week.'
          : null,
      },
    });
    weekIds.set(`${season}:${week}`, row.id);
  }

  // Picks.
  for (const row of preview.rows) {
    const user = users.find((u) => matchesUser(u, row.bettorName));
    await prisma.historicalPick.upsert({
      where: {
        seasonYear_weekNumber_bettorName: {
          seasonYear: row.seasonYear,
          weekNumber: row.weekNumber,
          bettorName: row.bettorName,
        },
      },
      create: {
        seasonYear: row.seasonYear,
        weekNumber: row.weekNumber,
        nflWeekId: weekIds.get(`${row.seasonYear}:${row.weekNumber}`) ?? null,
        userId: user?.id ?? null,
        bettorName: row.bettorName,
        pickText: row.pickText,
        americanOdds: row.americanOdds ?? 0,
        matchupText: row.matchupText,
        outcomeText: row.outcomeText,
        result: row.result,
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        sourceCol: row.sourceCol,
        importId: record.id,
        corrected: row.scoreRestored,
        needsReview: row.americanOdds === null,
        reviewNote: row.americanOdds === null ? 'Odds could not be read from the workbook.' : null,
      },
      update: {
        pickText: row.pickText,
        americanOdds: row.americanOdds ?? 0,
        matchupText: row.matchupText,
        outcomeText: row.outcomeText,
        result: row.result,
        importId: record.id,
        corrected: row.scoreRestored,
        nflWeekId: weekIds.get(`${row.seasonYear}:${row.weekNumber}`) ?? null,
        userId: user?.id ?? null,
      },
    });
  }

  for (const c of preview.conflicts) {
    await prisma.importConflict.create({
      data: {
        importId: record.id,
        scope: c.scope,
        seasonYear: c.season,
        weekNumber: c.week,
        bettorName: c.bettor,
        field: c.field,
        rawValue: c.rawValue,
        acceptedValue: c.acceptedValue,
        resolution: c.resolution,
        detail: c.detail,
      },
    });
  }

  // Record each restored score as a persistent correction so a future re-import
  // of the uncorrected workbook cannot undo it (spec §83).
  for (const row of preview.rows.filter((r) => r.scoreRestored)) {
    await prisma.historicalCorrection.upsert({
      where: {
        entityType_seasonYear_weekNumber_bettorName_field: {
          entityType: 'HistoricalPick',
          seasonYear: row.seasonYear,
          weekNumber: row.weekNumber,
          bettorName: row.bettorName,
          field: 'outcome',
        },
      },
      create: {
        entityType: 'HistoricalPick',
        seasonYear: row.seasonYear,
        weekNumber: row.weekNumber,
        bettorName: row.bettorName,
        field: 'outcome',
        originalValue: null,
        correctedValue: row.outcomeText ?? '',
        reason: 'Score restored from a cell Excel had reinterpreted as a date. Reviewed and accepted.',
        status: 'APPROVED',
        canonical: true,
        createdById: actorId,
      },
      update: {},
    });
  }

  const finished = await prisma.historicalImport.update({
    where: { id: record.id },
    data: { status: 'APPLIED', finishedAt: new Date() },
  });

  await audit({
    actorId,
    action: 'HISTORICAL_IMPORT_APPLIED',
    entityType: 'HistoricalImport',
    entityId: record.id,
    summary: `Imported ${preview.uniquePicksFound} historical picks from ${fileName} (${preview.duplicatesExcluded} duplicates excluded)`,
    detail: { seasons: preview.seasonsFound, conflicts: preview.conflicts.length },
  });

  return { import: finished, preview };
}

/** Record an administrator's correction so it outlives every future re-import. */
export async function recordCorrection(params: {
  seasonYear: number;
  weekNumber: number;
  bettorName: string;
  field: string;
  correctedValue: string;
  reason: string;
  actorId: string;
}) {
  const existing = await prisma.historicalPick.findUnique({
    where: {
      seasonYear_weekNumber_bettorName: {
        seasonYear: params.seasonYear,
        weekNumber: params.weekNumber,
        bettorName: params.bettorName,
      },
    },
  });

  const originalValue =
    existing === null
      ? null
      : params.field === 'matchup'
        ? existing.matchupText
        : params.field === 'outcome'
          ? existing.outcomeText
          : params.field === 'result'
            ? existing.result
            : null;

  const correction = await prisma.historicalCorrection.upsert({
    where: {
      entityType_seasonYear_weekNumber_bettorName_field: {
        entityType: 'HistoricalPick',
        seasonYear: params.seasonYear,
        weekNumber: params.weekNumber,
        bettorName: params.bettorName,
        field: params.field,
      },
    },
    create: {
      entityType: 'HistoricalPick',
      seasonYear: params.seasonYear,
      weekNumber: params.weekNumber,
      bettorName: params.bettorName,
      field: params.field,
      originalValue: originalValue === null ? null : String(originalValue),
      correctedValue: params.correctedValue,
      reason: params.reason,
      status: 'APPROVED',
      createdById: params.actorId,
    },
    update: { correctedValue: params.correctedValue, reason: params.reason, status: 'APPROVED', removedAt: null },
  });

  if (existing) {
    await prisma.historicalPick.update({
      where: { id: existing.id },
      data: {
        matchupText: params.field === 'matchup' ? params.correctedValue : existing.matchupText,
        outcomeText: params.field === 'outcome' ? params.correctedValue : existing.outcomeText,
        result: params.field === 'result' ? (params.correctedValue as never) : existing.result,
        corrected: true,
      },
    });
  }

  await audit({
    actorId: params.actorId,
    action: 'HISTORICAL_CORRECTION_RECORDED',
    entityType: 'HistoricalCorrection',
    entityId: correction.id,
    summary: `Correction: ${params.seasonYear} W${params.weekNumber} ${params.bettorName} ${params.field} -> ${params.correctedValue}`,
    detail: { reason: params.reason },
  });

  return correction;
}
