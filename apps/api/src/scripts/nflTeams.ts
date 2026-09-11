/**
 * The 32 NFL franchises. This is reference data, not sample data: the
 * abbreviation is the stable identifier used everywhere instead of display
 * text (spec §85). `aliases` carries the alternate and misspelled forms that
 * appear in the historical spreadsheet so imported rows still resolve.
 */
export interface TeamSeed {
  abbreviation: string;
  location: string;
  nickname: string;
  conference: 'AFC' | 'NFC';
  division: 'East' | 'North' | 'South' | 'West';
  aliases?: string[];
}

export const NFL_TEAMS: TeamSeed[] = [
  { abbreviation: 'ARI', location: 'Arizona', nickname: 'Cardinals', conference: 'NFC', division: 'West' },
  { abbreviation: 'ATL', location: 'Atlanta', nickname: 'Falcons', conference: 'NFC', division: 'South' },
  { abbreviation: 'BAL', location: 'Baltimore', nickname: 'Ravens', conference: 'AFC', division: 'North' },
  { abbreviation: 'BUF', location: 'Buffalo', nickname: 'Bills', conference: 'AFC', division: 'East' },
  { abbreviation: 'CAR', location: 'Carolina', nickname: 'Panthers', conference: 'NFC', division: 'South' },
  { abbreviation: 'CHI', location: 'Chicago', nickname: 'Bears', conference: 'NFC', division: 'North' },
  { abbreviation: 'CIN', location: 'Cincinnati', nickname: 'Bengals', conference: 'AFC', division: 'North' },
  { abbreviation: 'CLE', location: 'Cleveland', nickname: 'Browns', conference: 'AFC', division: 'North' },
  { abbreviation: 'DAL', location: 'Dallas', nickname: 'Cowboys', conference: 'NFC', division: 'East' },
  { abbreviation: 'DEN', location: 'Denver', nickname: 'Broncos', conference: 'AFC', division: 'West' },
  { abbreviation: 'DET', location: 'Detroit', nickname: 'Lions', conference: 'NFC', division: 'North' },
  { abbreviation: 'GB', location: 'Green Bay', nickname: 'Packers', conference: 'NFC', division: 'North' },
  { abbreviation: 'HOU', location: 'Houston', nickname: 'Texans', conference: 'AFC', division: 'South' },
  { abbreviation: 'IND', location: 'Indianapolis', nickname: 'Colts', conference: 'AFC', division: 'South' },
  { abbreviation: 'JAX', location: 'Jacksonville', nickname: 'Jaguars', conference: 'AFC', division: 'South', aliases: ['JAC'] },
  { abbreviation: 'KC', location: 'Kansas City', nickname: 'Chiefs', conference: 'AFC', division: 'West' },
  { abbreviation: 'LV', location: 'Las Vegas', nickname: 'Raiders', conference: 'AFC', division: 'West', aliases: ['OAK', 'Oakland Raiders'] },
  { abbreviation: 'LAC', location: 'Los Angeles', nickname: 'Chargers', conference: 'AFC', division: 'West', aliases: ['SD'] },
  { abbreviation: 'LAR', location: 'Los Angeles', nickname: 'Rams', conference: 'NFC', division: 'West', aliases: ['STL'] },
  { abbreviation: 'MIA', location: 'Miami', nickname: 'Dolphins', conference: 'AFC', division: 'East' },
  { abbreviation: 'MIN', location: 'Minnesota', nickname: 'Vikings', conference: 'NFC', division: 'North' },
  { abbreviation: 'NE', location: 'New England', nickname: 'Patriots', conference: 'AFC', division: 'East' },
  { abbreviation: 'NO', location: 'New Orleans', nickname: 'Saints', conference: 'NFC', division: 'South' },
  { abbreviation: 'NYG', location: 'New York', nickname: 'Giants', conference: 'NFC', division: 'East' },
  { abbreviation: 'NYJ', location: 'New York', nickname: 'Jets', conference: 'AFC', division: 'East' },
  { abbreviation: 'PHI', location: 'Philadelphia', nickname: 'Eagles', conference: 'NFC', division: 'East' },
  { abbreviation: 'PIT', location: 'Pittsburgh', nickname: 'Steelers', conference: 'AFC', division: 'North' },
  { abbreviation: 'SF', location: 'San Francisco', nickname: '49ers', conference: 'NFC', division: 'West', aliases: ['SFO', 'Niners'] },
  { abbreviation: 'SEA', location: 'Seattle', nickname: 'Seahawks', conference: 'NFC', division: 'West' },
  // "Bucaneers" is a real misspelling present in the group's historical sheet.
  { abbreviation: 'TB', location: 'Tampa Bay', nickname: 'Buccaneers', conference: 'NFC', division: 'South', aliases: ['Bucaneers', 'Bucs'] },
  { abbreviation: 'TEN', location: 'Tennessee', nickname: 'Titans', conference: 'AFC', division: 'South' },
  { abbreviation: 'WAS', location: 'Washington', nickname: 'Commanders', conference: 'NFC', division: 'East', aliases: ['WSH', 'Football Team', 'Redskins'] },
];

/** Resolve a nickname, abbreviation, city or historical alias to a team. */
export function resolveTeam(text: string): TeamSeed | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  for (const t of NFL_TEAMS) {
    if (
      t.abbreviation.toLowerCase() === needle ||
      t.nickname.toLowerCase() === needle ||
      `${t.location} ${t.nickname}`.toLowerCase() === needle ||
      t.location.toLowerCase() === needle ||
      (t.aliases ?? []).some((a) => a.toLowerCase() === needle)
    ) {
      return t;
    }
  }
  return null;
}
