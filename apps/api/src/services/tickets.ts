/**
 * The official Sports Bet Montana ticket (spec §54-§58).
 *
 * The uploaded ticket — not anybody's locked pick — is the authoritative record
 * of what was actually wagered. Verification compares the two and insists on a
 * human decision whenever they disagree about WHAT was bet. A change in PRICE
 * alone is normal and accepted automatically.
 */
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { notify } from './notifications.js';
import { recomputeWeekStatus } from './weeks.js';
import { combineParlayOdds, formatAmerican } from '@fcp/shared';
import type { ExtractedTicket, TicketOcrProvider } from '../providers/types.js';
import { isDataUnavailable } from '@fcp/shared';

export class TicketError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 400) {
    super(message);
  }
}

/** Below this, extraction is never accepted without a human reading it (spec §55). */
export const OCR_REVIEW_THRESHOLD = 0.85;

export async function uploadTicket(params: {
  nflWeekId: string;
  imagePath: string;
  mimeType: string;
  uploadedById: string;
}) {
  const week = await prisma.nFLWeek.findUniqueOrThrow({ where: { id: params.nflWeekId } });
  if (week.status === 'WEEK_OFF') {
    throw new TicketError('WEEK_OFF', 'This is a Week Off — there is no parlay to upload a ticket for.', 409);
  }

  const existing = await prisma.officialTicket.findUnique({ where: { nflWeekId: params.nflWeekId } });
  if (existing?.status === 'CONFIRMED') {
    throw new TicketError('ALREADY_CONFIRMED', 'This week\'s official parlay is already confirmed.', 409);
  }

  const ticket = existing
    ? await prisma.officialTicket.update({
        where: { id: existing.id },
        data: { imagePath: params.imagePath, imageMimeType: params.mimeType, status: 'UPLOADED', uploadedById: params.uploadedById, uploadedAt: new Date() },
      })
    : await prisma.officialTicket.create({
        data: {
          nflWeekId: params.nflWeekId,
          imagePath: params.imagePath,
          imageMimeType: params.mimeType,
          uploadedById: params.uploadedById,
          status: 'UPLOADED',
        },
      });

  await audit({ actorId: params.uploadedById, action: 'TICKET_UPLOADED', entityType: 'OfficialTicket', entityId: ticket.id, summary: `Official ticket uploaded for week ${week.weekNumber}` });
  await recomputeWeekStatus(params.nflWeekId);
  return ticket;
}

/**
 * Run OCR over the uploaded image. Low confidence does not block the workflow —
 * it routes the ticket to NEEDS_REVIEW so a person confirms every value.
 */
export async function extractTicket(ticketId: string, ocr: TicketOcrProvider) {
  const ticket = await prisma.officialTicket.findUniqueOrThrow({ where: { id: ticketId } });

  if (!ocr.isConfigured()) {
    // No OCR provider: the administrator types the legs in by hand. The app
    // says so plainly rather than pretending to have read the ticket (spec §95).
    await prisma.officialTicket.update({
      where: { id: ticketId },
      data: { status: 'NEEDS_REVIEW', extractionNotes: 'No ticket-reading service is configured. Enter the ten legs by hand.' },
    });
    return { extracted: false as const, reason: 'OCR_NOT_CONFIGURED' };
  }

  await prisma.officialTicket.update({ where: { id: ticketId }, data: { status: 'EXTRACTING' } });
  const result = await ocr.extract(ticket.imagePath, ticket.imageMimeType ?? 'image/jpeg');

  if (isDataUnavailable(result)) {
    await prisma.officialTicket.update({
      where: { id: ticketId },
      data: { status: 'NEEDS_REVIEW', extractionNotes: `Ticket reading unavailable: ${result.reason}. Enter the legs by hand.` },
    });
    return { extracted: false as const, reason: result.reason };
  }

  const data: ExtractedTicket = result.data;
  await prisma.$transaction(async (tx) => {
    await tx.officialTicketLeg.deleteMany({ where: { ticketId, pickId: null } });
    for (const leg of data.legs) {
      await tx.officialTicketLeg.upsert({
        where: { ticketId_legIndex: { ticketId, legIndex: leg.legIndex } },
        create: {
          ticketId, legIndex: leg.legIndex, descriptionText: leg.descriptionText,
          marketKey: leg.marketKey, subjectLabel: leg.subjectLabel, selectionLabel: leg.selectionLabel,
          line: leg.line, americanOdds: leg.americanOdds,
        },
        update: {
          descriptionText: leg.descriptionText, marketKey: leg.marketKey, subjectLabel: leg.subjectLabel,
          selectionLabel: leg.selectionLabel, line: leg.line, americanOdds: leg.americanOdds,
        },
      });
    }
    await tx.officialTicket.update({
      where: { id: ticketId },
      data: {
        status: data.confidence >= OCR_REVIEW_THRESHOLD ? 'NEEDS_REVIEW' : 'NEEDS_REVIEW',
        combinedAmericanOdds: data.combinedAmericanOdds,
        wagerAmount: data.wagerAmount,
        potentialPayout: data.potentialPayout,
        ticketReference: data.ticketReference,
        ticketPlacedAt: data.ticketPlacedAt,
        ocrProvider: result.provider,
        ocrConfidence: data.confidence,
        ocrRawText: data.rawText,
        extractionNotes:
          data.confidence < OCR_REVIEW_THRESHOLD
            ? `Ticket read with low confidence (${Math.round(data.confidence * 100)}%). Check every leg before confirming.`
            : 'Ticket read successfully. Confirm each leg against the image before confirming the parlay.',
      },
    });
  });

  return { extracted: true as const, confidence: data.confidence, legs: data.legs.length };
}

export type VerificationOutcome =
  | 'MATCH'
  | 'MATCH_ODDS_CHANGED'
  | 'SELECTION_MISMATCH'
  | 'MISSING_FROM_TICKET'
  | 'EXTRA_ON_TICKET';

/**
 * Compare each locked pick with the ticket (spec §56).
 *
 *   same selection, same number, different price  -> MATCH_ODDS_CHANGED (fine)
 *   different threshold or different subject      -> SELECTION_MISMATCH (admin must decide)
 *
 * A mismatch is never auto-resolved, because doing so would rewrite a member's
 * historical record without anybody noticing.
 */
export async function verifyTicket(ticketId: string) {
  const ticket = await prisma.officialTicket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { legs: { orderBy: { legIndex: 'asc' } }, week: true },
  });

  const picks = await prisma.pick.findMany({
    where: { nflWeekId: ticket.nflWeekId, state: 'LOCKED' },
    include: { market: true, user: true, nflGame: { include: { homeTeam: true, awayTeam: true } } },
  });

  const unmatchedPicks = new Set(picks.map((p) => p.id));
  const results: { legIndex: number; outcome: VerificationOutcome; note: string; userId: string | null }[] = [];

  for (const leg of ticket.legs) {
    const candidate = picks.find((p) => unmatchedPicks.has(p.id) && describesSamePick(leg, p));

    if (!candidate) {
      // Try a looser match on subject only, to distinguish "wrong threshold"
      // from "a leg nobody locked".
      const sameSubject = picks.find(
        (p) => unmatchedPicks.has(p.id) && subjectOf(leg) !== null && subjectOf(leg) === normalize(p.market.subjectLabel),
      );
      if (sameSubject) {
        unmatchedPicks.delete(sameSubject.id);
        const note =
          `Locked: ${sameSubject.lockedSelectionText ?? sameSubject.market.selectionLabel}` +
          ` (line ${sameSubject.lockedLine ?? '—'}) — Ticket: ${leg.descriptionText} (line ${leg.line ?? '—'}). Admin review required.`;
        await prisma.officialTicketLeg.update({
          where: { id: leg.id },
          data: { userId: sameSubject.userId, pickId: sameSubject.id, verification: 'SELECTION_MISMATCH', verificationNote: note },
        });
        results.push({ legIndex: leg.legIndex, outcome: 'SELECTION_MISMATCH', note, userId: sameSubject.userId });
        continue;
      }

      await prisma.officialTicketLeg.update({
        where: { id: leg.id },
        data: { verification: 'EXTRA_ON_TICKET', verificationNote: 'This leg does not correspond to any locked pick.' },
      });
      results.push({ legIndex: leg.legIndex, outcome: 'EXTRA_ON_TICKET', note: 'No matching locked pick.', userId: null });
      continue;
    }

    unmatchedPicks.delete(candidate.id);
    const oddsChanged = leg.americanOdds !== null && leg.americanOdds !== candidate.lockedAmericanOdds;
    const outcome: VerificationOutcome = oddsChanged ? 'MATCH_ODDS_CHANGED' : 'MATCH';
    const note = oddsChanged
      ? `MATCH — ODDS CHANGED. Locked ${formatAmerican(candidate.lockedAmericanOdds)}, ticket ${formatAmerican(leg.americanOdds)}. The ticket price is the official one.`
      : 'MATCH.';

    await prisma.officialTicketLeg.update({
      where: { id: leg.id },
      data: { userId: candidate.userId, pickId: candidate.id, verification: outcome, verificationNote: note },
    });
    results.push({ legIndex: leg.legIndex, outcome, note, userId: candidate.userId });
  }

  // Locked picks that never appeared on the ticket.
  for (const pickId of unmatchedPicks) {
    const pick = picks.find((p) => p.id === pickId)!;
    results.push({
      legIndex: -1,
      outcome: 'MISSING_FROM_TICKET',
      note: `${pick.user.displayName} locked ${pick.lockedSelectionText ?? pick.market.selectionLabel} but no matching leg appears on the ticket.`,
      userId: pick.userId,
    });
  }

  const needsReview = results.some((r) => r.outcome !== 'MATCH' && r.outcome !== 'MATCH_ODDS_CHANGED');
  await prisma.officialTicket.update({
    where: { id: ticketId },
    data: { status: needsReview ? 'NEEDS_REVIEW' : 'VERIFIED' },
  });

  return { status: needsReview ? ('NEEDS_REVIEW' as const) : ('VERIFIED' as const), results };
}

function normalize(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function subjectOf(leg: { subjectLabel: string | null; descriptionText: string }): string | null {
  return normalize(leg.subjectLabel);
}

/** Same wager means same subject AND same number. Price is explicitly excluded. */
function describesSamePick(
  leg: { subjectLabel: string | null; line: unknown; descriptionText: string },
  pick: { market: { subjectLabel: string | null }; lockedLine: unknown },
): boolean {
  const legSubject = normalize(leg.subjectLabel);
  const pickSubject = normalize(pick.market.subjectLabel);
  if (legSubject && pickSubject && legSubject !== pickSubject) return false;
  if (!legSubject && !pickSubject) {
    // Fall back to text containment when neither side named a subject.
    if (!normalize(leg.descriptionText)) return false;
  }

  const legLine = leg.line === null || leg.line === undefined ? null : Number(leg.line);
  const pickLine = pick.lockedLine === null || pick.lockedLine === undefined ? null : Number(pick.lockedLine);
  return legLine === pickLine;
}

/** An administrator resolves a disputed leg explicitly, and it is recorded. */
export async function resolveLeg(params: {
  legId: string;
  actorId: string;
  userId: string | null;
  pickId: string | null;
  note: string;
}) {
  const leg = await prisma.officialTicketLeg.update({
    where: { id: params.legId },
    data: {
      userId: params.userId,
      pickId: params.pickId,
      verification: 'ADMIN_RESOLVED',
      verificationNote: params.note,
    },
  });
  await audit({
    actorId: params.actorId,
    action: 'TICKET_LEG_RESOLVED',
    entityType: 'OfficialTicketLeg',
    entityId: leg.id,
    summary: `Leg ${leg.legIndex} resolved by administrator: ${params.note}`,
  });
  return leg;
}

/**
 * CONFIRM OFFICIAL PARLAY (spec §57).
 * Freezes member editing, fixes the official legs and starts live tracking.
 */
export async function confirmOfficialParlay(ticketId: string, actorId: string) {
  const ticket = await prisma.officialTicket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { legs: true, week: true },
  });

  const unresolved = ticket.legs.filter(
    (l) => l.verification === 'SELECTION_MISMATCH' || l.verification === 'EXTRA_ON_TICKET',
  );
  if (unresolved.length > 0) {
    throw new TicketError(
      'UNRESOLVED_LEGS',
      `${unresolved.length} leg(s) still need review before the parlay can be confirmed.`,
      409,
    );
  }
  if (ticket.legs.length === 0) {
    throw new TicketError('NO_LEGS', 'This ticket has no legs recorded yet.', 409);
  }

  const legOdds = ticket.legs.map((l) => l.americanOdds).filter((o): o is number => o !== null);
  const combined = ticket.combinedAmericanOdds ?? (legOdds.length === ticket.legs.length ? combineParlayOdds(legOdds) : null);

  const confirmed = await prisma.$transaction(async (tx) => {
    const t = await tx.officialTicket.update({
      where: { id: ticketId },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedById: actorId, combinedAmericanOdds: combined ? Math.round(combined) : null },
    });

    // Normal member editing ends here (spec §13, §57).
    await tx.nFLWeek.update({ where: { id: ticket.nflWeekId }, data: { frozenAt: new Date(), status: 'OFFICIAL' } });

    await tx.parlay.upsert({
      where: { nflWeekId: ticket.nflWeekId },
      create: {
        nflWeekId: ticket.nflWeekId,
        combinedAmericanOdds: combined ? Math.round(combined) : null,
        wagerAmount: ticket.wagerAmount,
        potentialPayout: ticket.potentialPayout,
      },
      update: {
        combinedAmericanOdds: combined ? Math.round(combined) : null,
        wagerAmount: ticket.wagerAmount,
        potentialPayout: ticket.potentialPayout,
      },
    });
    return t;
  });

  await audit({
    actorId,
    action: 'PARLAY_CONFIRMED',
    entityType: 'OfficialTicket',
    entityId: ticketId,
    summary: `Official parlay confirmed for week ${ticket.week.weekNumber} with ${ticket.legs.length} legs`,
    detail: { combinedAmericanOdds: combined },
  });

  const members = await prisma.user.findMany({ where: { active: true } });
  for (const m of members) {
    await notify({
      userId: m.id,
      kind: 'OFFICIAL',
      title: 'OFFICIAL',
      body: `The Week ${ticket.week.weekNumber} parlay ticket has been confirmed. Picks are now locked in.`,
      dedupeKey: `official:${ticket.nflWeekId}`,
    });
  }

  return confirmed;
}
