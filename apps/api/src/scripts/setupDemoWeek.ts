/**
 * DEVELOPMENT ONLY. Creates a week, its games, and a handful of sportsbook
 * markets so the interface can be exercised end to end.
 *
 * This refuses to run unless FCP_DEMO_DATA=true, because fabricated markets
 * must never reach a production screen (spec §95). Everything it creates is
 * labelled as sample data.
 */
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { selectionKeyOf, normalizeKey, type MarketCategory } from '@fcp/shared';

async function main() {
  if (!env.demoDataEnabled) {
    console.error(
      'Refusing to create sample data.\n' +
        'This script only runs in an explicitly marked development environment.\n' +
        'Set FCP_DEMO_DATA=true to allow it.',
    );
    process.exit(1);
  }

  const season = await prisma.season.upsert({
    where: { year: 2026 },
    create: { year: 2026, label: '2026 Season', isCurrent: true },
    update: { isCurrent: true },
  });

  const week = await prisma.nFLWeek.upsert({
    where: { seasonId_weekNumber: { seasonId: season.id, weekNumber: 1 } },
    create: { seasonId: season.id, weekNumber: 1, status: 'IN_PROGRESS' },
    update: { status: 'IN_PROGRESS' },
  });

  // [away, home, days after Sunday]. The last entry is a Thursday game, which
  // is deliberately outside the eligible Sunday/Monday slate.
  const fixtures: [string, string, number][] = [
    ['BUF', 'MIA', 0],
    ['KC', 'DEN', 0],
    ['PHI', 'DAL', 0],
    ['SF', 'SEA', 0],
    ['BAL', 'CIN', 0],
    ['DET', 'GB', 0],
    ['HOU', 'IND', 0],
    ['NYJ', 'NE', 0],
    ['LAC', 'LV', 0],
    ['MIN', 'CHI', 1],
    ['TB', 'NO', 4],
  ];

  const sunday = new Date();
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));
  sunday.setUTCHours(18, 0, 0, 0);

  for (const [away, home, dayOffset] of fixtures) {
    const [a, h] = await Promise.all([
      prisma.team.findUniqueOrThrow({ where: { abbreviation: away } }),
      prisma.team.findUniqueOrThrow({ where: { abbreviation: home } }),
    ]);
    const kickoffAt = new Date(sunday.getTime() + dayOffset * 86_400_000);
    const providerGameId = `DEMO-${away}-${home}`;

    const game = await prisma.nFLGame.upsert({
      where: { nflWeekId_providerGameId: { nflWeekId: week.id, providerGameId } },
      create: {
        nflWeekId: week.id,
        providerGameId,
        awayTeamId: a.id,
        homeTeamId: h.id,
        kickoffAt,
        // Sunday and Monday only; anything else is visible for research but
        // not selectable (spec §6).
        eligible: dayOffset <= 1,
        eligibilityNote: dayOffset <= 1 ? null : "NOT ELIGIBLE FOR THIS WEEK'S PARLAY",
      },
      update: { kickoffAt },
    });

    const sourceEventId = `DEMO-SBM-${away}-${home}`;
    const event = await prisma.sportsbookEvent.upsert({
      where: { sourceEventId },
      create: {
        sourceEventId,
        nflGameId: game.id,
        homeTeamName: h.nickname,
        awayTeamName: a.nickname,
        scheduledAt: kickoffAt,
        lastSuccessfulReadAt: new Date(),
      },
      update: { nflGameId: game.id, lastSuccessfulReadAt: new Date() },
    });

    const selections: {
      category: MarketCategory;
      marketLabel: string;
      selectionLabel: string;
      subject: string | null;
      line: number | null;
      odds: number;
    }[] = [
      { category: 'GAME_LINE', marketLabel: 'Point Spread', selectionLabel: `${h.nickname} -3.5`, subject: h.nickname, line: -3.5, odds: -110 },
      { category: 'GAME_LINE', marketLabel: 'Moneyline', selectionLabel: `${h.nickname} Moneyline`, subject: h.nickname, line: null, odds: -165 },
      { category: 'GAME_PROP', marketLabel: 'Game Total', selectionLabel: 'Over 45.5 Points', subject: null, line: 45.5, odds: -108 },
      { category: 'PLAYER_PROP', marketLabel: 'Rushing Yards', selectionLabel: '25+ Rushing Yards', subject: `${a.nickname} QB`, line: 25, odds: -175 },
      { category: 'PLAYER_PROP', marketLabel: 'Rushing Yards', selectionLabel: '30+ Rushing Yards', subject: `${a.nickname} QB`, line: 30, odds: -130 },
      { category: 'TOUCHDOWN_SCORER', marketLabel: 'Anytime Touchdown', selectionLabel: 'Anytime Touchdown', subject: `${h.nickname} RB`, line: null, odds: 135 },
    ];

    for (const s of selections) {
      const identity = selectionKeyOf({
        sourceEventId,
        category: s.category,
        marketKey: normalizeKey(s.marketLabel),
        subjectKey: s.subject,
        selectionKey: normalizeKey(s.selectionLabel),
        line: s.line,
      });
      await prisma.market.upsert({
        where: { selectionIdentity: identity },
        create: {
          eventId: event.id,
          category: s.category,
          marketKey: normalizeKey(s.marketLabel),
          marketLabel: s.marketLabel,
          subjectKey: s.subject ? normalizeKey(s.subject) : null,
          subjectLabel: s.subject,
          selectionKey: normalizeKey(s.selectionLabel),
          selectionLabel: s.selectionLabel,
          line: s.line,
          selectionIdentity: identity,
          americanOdds: s.odds,
          available: true,
          source: 'ADMIN_MANUAL',
          manualNote: 'DEVELOPMENT SAMPLE DATA — not a real Sports Bet Montana price.',
        },
        update: {},
      });
    }
  }

  console.log(`Development week ready: 2026 Week 1 with ${fixtures.length} games.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
