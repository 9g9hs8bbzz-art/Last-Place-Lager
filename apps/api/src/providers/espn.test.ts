/**
 * ESPN's endpoints are undocumented, so the parsers are tested against
 * recorded payloads shaped the way ESPN actually responds — including the
 * awkward parts: "21/33" combined columns, overtime periods, postponed games,
 * and the abbreviations where ESPN and the app disagree.
 *
 * The point of these tests is not that ESPN is correct today; it is that when
 * ESPN changes, the app degrades into DATA CURRENTLY UNAVAILABLE rather than
 * into wrong numbers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseScoreboard,
  parseLiveStates,
  parseBoxScore,
  mapGameStatus,
  normalizeAbbrev,
} from './espn.js';

function event(over: Record<string, unknown> = {}) {
  return {
    id: '401671789',
    date: '2025-10-12T17:00Z',
    shortName: 'BUF @ MIA',
    competitions: [
      {
        venue: { fullName: 'Hard Rock Stadium', indoor: false },
        competitors: [
          { homeAway: 'home', team: { abbreviation: 'MIA' }, score: '20' },
          { homeAway: 'away', team: { abbreviation: 'BUF' }, score: '31' },
        ],
        status: {
          period: 4,
          displayClock: '0:00',
          type: { state: 'post', name: 'STATUS_FINAL', completed: true },
        },
      },
    ],
    ...over,
  };
}

describe('reading the schedule', () => {
  it('reads a normal game', () => {
    const [game] = parseScoreboard({ events: [event()] });
    expect(game.providerGameId).toBe('401671789');
    expect(game.awayTeamAbbrev).toBe('BUF');
    expect(game.homeTeamAbbrev).toBe('MIA');
    expect(game.kickoffAt.toISOString()).toBe('2025-10-12T17:00:00.000Z');
    expect(game.venue).toBe('Hard Rock Stadium');
    expect(game.indoor).toBe(false);
  });

  it('marks a domed stadium as indoor, which suppresses weather research', () => {
    const domed = event({
      competitions: [
        {
          venue: { fullName: 'Ford Field', indoor: true },
          competitors: [
            { homeAway: 'home', team: { abbreviation: 'DET' } },
            { homeAway: 'away', team: { abbreviation: 'GB' } },
          ],
        },
      ],
    });
    expect(parseScoreboard({ events: [domed] })[0].indoor).toBe(true);
  });

  it('skips a game it cannot read rather than inventing one', () => {
    const broken = [
      event({ id: undefined }),
      event({ date: 'not a date' }),
      event({ competitions: [{ competitors: [{ homeAway: 'home', team: {} }] }] }),
      event({ competitions: [] }),
    ];
    expect(parseScoreboard({ events: broken })).toHaveLength(0);
  });

  it('returns nothing for a payload shaped differently than expected', () => {
    expect(parseScoreboard(null)).toHaveLength(0);
    expect(parseScoreboard({})).toHaveLength(0);
    expect(parseScoreboard({ events: 'surprise' })).toHaveLength(0);
    expect(parseScoreboard({ events: [42, null] })).toHaveLength(0);
  });
});

describe('team abbreviations where ESPN and the app disagree', () => {
  it.each([
    ['WSH', 'WAS'],
    ['JAC', 'JAX'],
    ['LA', 'LAR'],
    ['OAK', 'LV'],
    ['SD', 'LAC'],
    ['STL', 'LAR'],
  ])('maps %s to %s', (espn, ours) => {
    expect(normalizeAbbrev(espn)).toBe(ours);
  });

  it('leaves the ones that already agree alone', () => {
    for (const a of ['BUF', 'MIA', 'KC', 'GB', 'NE', 'NO', 'NYG', 'NYJ', 'SF', 'TB']) {
      expect(normalizeAbbrev(a)).toBe(a);
    }
  });

  it('is not confused by whitespace or case', () => {
    expect(normalizeAbbrev(' wsh ')).toBe('WAS');
  });
});

describe('game status', () => {
  it.each([
    ['pre', 'STATUS_SCHEDULED', 'SCHEDULED'],
    ['in', 'STATUS_IN_PROGRESS', 'IN_PROGRESS'],
    ['in', 'STATUS_HALFTIME', 'IN_PROGRESS'],
    ['post', 'STATUS_FINAL', 'FINAL'],
    ['pre', 'STATUS_POSTPONED', 'POSTPONED'],
    ['pre', 'STATUS_CANCELED', 'CANCELED'],
  ])('maps state=%s name=%s to %s', (state, name, expected) => {
    expect(mapGameStatus(state, name)).toBe(expected);
  });

  it('treats anything unrecognised as not yet started', () => {
    expect(mapGameStatus(undefined, undefined)).toBe('SCHEDULED');
    expect(mapGameStatus('something-new', 'STATUS_MYSTERY')).toBe('SCHEDULED');
  });
});

describe('reading live state', () => {
  it('reads scores, quarter and clock', () => {
    const live = event({
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { abbreviation: 'MIA' }, score: '17' },
            { homeAway: 'away', team: { abbreviation: 'BUF' }, score: '21' },
          ],
          status: { period: 3, displayClock: '8:42', type: { state: 'in', name: 'STATUS_IN_PROGRESS' } },
        },
      ],
    });
    const [s] = parseLiveStates({ events: [live] });
    expect(s.status).toBe('IN_PROGRESS');
    expect(s.homeScore).toBe(17);
    expect(s.awayScore).toBe(21);
    expect(s.quarter).toBe('Q3');
    expect(s.clock).toBe('8:42');
  });

  it('labels overtime', () => {
    const ot = (period: number) =>
      parseLiveStates({
        events: [
          event({
            competitions: [
              {
                competitors: [
                  { homeAway: 'home', team: { abbreviation: 'MIA' }, score: '24' },
                  { homeAway: 'away', team: { abbreviation: 'BUF' }, score: '24' },
                ],
                status: { period, displayClock: '4:11', type: { state: 'in', name: 'STATUS_IN_PROGRESS' } },
              },
            ],
          }),
        ],
      })[0].quarter;
    expect(ot(5)).toBe('OT');
    expect(ot(6)).toBe('OT2');
  });

  it('leaves the score null before kickoff rather than reporting 0-0', () => {
    const pre = event({
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { abbreviation: 'MIA' }, score: '' },
            { homeAway: 'away', team: { abbreviation: 'BUF' } },
          ],
          status: { period: 0, type: { state: 'pre', name: 'STATUS_SCHEDULED' } },
        },
      ],
    });
    const [s] = parseLiveStates({ events: [pre] });
    expect(s.homeScore).toBeNull();
    expect(s.awayScore).toBeNull();
    expect(s.quarter).toBeNull();
  });
});

describe('reading the box score', () => {
  const summary = {
    boxscore: {
      players: [
        {
          statistics: [
            {
              name: 'passing',
              keys: ['completions/passingAttempts', 'passingYards', 'passingTouchdowns', 'interceptions'],
              athletes: [{ athlete: { displayName: 'Josh Allen' }, stats: ['21/33', '256', '2', '1'] }],
            },
            {
              name: 'rushing',
              keys: ['rushingAttempts', 'rushingYards', 'rushingTouchdowns', 'longRushing'],
              athletes: [
                { athlete: { displayName: 'Josh Allen' }, stats: ['6', '32', '1', '14'] },
                { athlete: { displayName: 'James Cook' }, stats: ['18', '104', '0', '23'] },
              ],
            },
            {
              name: 'receiving',
              keys: ['receptions', 'receivingYards', 'receivingTouchdowns', 'receivingTargets'],
              athletes: [{ athlete: { displayName: 'James Cook' }, stats: ['4', '31', '0', '5'] }],
            },
            {
              name: 'kicking',
              keys: ['fieldGoalsMade/fieldGoalAttempts', 'totalKickingPoints'],
              athletes: [{ athlete: { displayName: 'Tyler Bass' }, stats: ['2/3', '11'] }],
            },
          ],
        },
      ],
    },
  };

  const find = (stats: ReturnType<typeof parseBoxScore>, name: string, key: string) =>
    stats.find((s) => s.playerName === name && s.statKey === key)?.value;

  it('reads the statistics a wager can be graded against', () => {
    const stats = parseBoxScore(summary);
    expect(find(stats, 'Josh Allen', 'PASSING_YARDS')).toBe(256);
    expect(find(stats, 'Josh Allen', 'PASSING_TOUCHDOWNS')).toBe(2);
    expect(find(stats, 'Josh Allen', 'RUSHING_YARDS')).toBe(32);
    expect(find(stats, 'James Cook', 'RECEPTIONS')).toBe(4);
    expect(find(stats, 'James Cook', 'CARRIES')).toBe(18);
  });

  it('splits combined columns like "21/33" into both halves', () => {
    const stats = parseBoxScore(summary);
    expect(find(stats, 'Josh Allen', 'COMPLETIONS')).toBe(21);
    expect(find(stats, 'Josh Allen', 'PASS_ATTEMPTS')).toBe(33);
    expect(find(stats, 'Tyler Bass', 'FIELD_GOALS_MADE')).toBe(2);
    expect(find(stats, 'Tyler Bass', 'FIELD_GOAL_ATTEMPTS')).toBe(3);
  });

  it('derives rushing + receiving, which the group actually bets', () => {
    const stats = parseBoxScore(summary);
    // James Cook: 104 rushing + 31 receiving.
    expect(find(stats, 'James Cook', 'RUSHING_AND_RECEIVING_YARDS')).toBe(135);
    // Josh Allen rushed but did not receive; the total is still his rushing.
    expect(find(stats, 'Josh Allen', 'RUSHING_AND_RECEIVING_YARDS')).toBe(32);
  });

  it('keys players in the app\'s own normalized form', () => {
    const stats = parseBoxScore(summary);
    expect(stats.find((s) => s.playerName === 'Josh Allen')!.subjectKey).toBe('JOSH_ALLEN');
  });

  it('returns nothing for a payload it cannot read', () => {
    expect(parseBoxScore(null)).toHaveLength(0);
    expect(parseBoxScore({})).toHaveLength(0);
    expect(parseBoxScore({ boxscore: { players: 'nope' } })).toHaveLength(0);
    expect(parseBoxScore({ boxscore: { players: [{ statistics: [{ keys: ['mystery'], athletes: [] }] }] } })).toHaveLength(0);
    // Junk entries anywhere in the nested arrays must not throw.
    expect(parseBoxScore({ boxscore: { players: [null, 7, { statistics: [null, { keys: null, athletes: [null] }] }] } })).toHaveLength(0);
  });

  it('ignores a column it does not understand rather than mis-filing it', () => {
    const odd = {
      boxscore: {
        players: [
          {
            statistics: [
              {
                keys: ['brandNewMetric', 'rushingYards'],
                athletes: [{ athlete: { displayName: 'Josh Allen' }, stats: ['99', '32'] }],
              },
            ],
          },
        ],
      },
    };
    const stats = parseBoxScore(odd);
    expect(stats.some((s) => s.value === 99)).toBe(false);
    expect(find(stats, 'Josh Allen', 'RUSHING_YARDS')).toBe(32);
  });

  it('skips a player with no name', () => {
    const nameless = {
      boxscore: { players: [{ statistics: [{ keys: ['rushingYards'], athletes: [{ athlete: {}, stats: ['50'] }] }] }] },
    };
    expect(parseBoxScore(nameless)).toHaveLength(0);
  });
});
