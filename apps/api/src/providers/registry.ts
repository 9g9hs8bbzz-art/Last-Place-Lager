/**
 * Provider registry.
 *
 * Every external dependency resolves through here. When a provider has no
 * credentials, the registry returns an implementation that reports
 * DATA CURRENTLY UNAVAILABLE. It never returns invented values (spec §95), and
 * swapping in a real provider is a change to this file alone (spec §87).
 */
import { env } from '../lib/env.js';
import { dataUnavailable } from '@fcp/shared';
import { SbmBoardReader } from './sbmBoardReader.js';
import { espnProvider } from './espn.js';
import type {
  AiResearchProvider, BoardReaderProvider, InjuryProvider, LiveScoreProvider,
  NewsProvider, ScheduleProvider, StatsProvider, TicketOcrProvider, WeatherProvider,
} from './types.js';

const NOT_CONFIGURED = 'This data source has not been connected yet. See docs/SETUP.md to add it.';

function unavailable(provider: string) {
  return dataUnavailable(provider, NOT_CONFIGURED, null);
}

export const boardReader: BoardReaderProvider = new SbmBoardReader();

/**
 * Schedule and live scores both come from ESPN's free public endpoints. They
 * need no key, so they are on by default; set NFL_DATA_SOURCE to anything else
 * to switch them off and fall back to entering games by hand.
 */
export const scheduleProvider: ScheduleProvider = espnProvider;
export const liveScoreProvider: LiveScoreProvider = espnProvider;

export const statsProvider: StatsProvider = {
  name: 'NFL_STATS',
  isConfigured: () => Boolean(env.providers.statsKey),
  async getPlayerSamples() {
    return unavailable('NFL_STATS');
  },
  async getDefensiveRanks() {
    return unavailable('NFL_STATS');
  },
};

export const injuryProvider: InjuryProvider = {
  name: 'INJURIES',
  isConfigured: () => Boolean(env.providers.injuryKey),
  async getInjuries() {
    return unavailable('INJURIES');
  },
};

export const weatherProvider: WeatherProvider = {
  name: 'WEATHER',
  isConfigured: () => Boolean(env.providers.weatherKey),
  async getForecast() {
    return unavailable('WEATHER');
  },
};

export const newsProvider: NewsProvider = {
  name: 'NEWS',
  isConfigured: () => Boolean(env.providers.newsKey),
  async search() {
    return unavailable('NEWS');
  },
};

export const aiResearchProvider: AiResearchProvider = {
  name: 'AI_RESEARCH',
  isConfigured: () => Boolean(env.providers.anthropicKey),
  async summarize() {
    return unavailable('AI_RESEARCH');
  },
};

export const ticketOcrProvider: TicketOcrProvider = {
  name: 'TICKET_OCR',
  isConfigured: () => Boolean(env.providers.ocrProvider && env.providers.ocrKey),
  async extract() {
    return unavailable('TICKET_OCR');
  },
};

/** Integration status for the admin screen, so gaps are visible not silent. */
export function integrationStatus() {
  const entries: { key: string; name: string; configured: boolean; purpose: string; envVar: string }[] = [
    { key: 'sbm', name: 'Sports Bet Montana Board Reader', configured: boardReader.isConfigured(), purpose: 'The odds members pick from.', envVar: 'SBM_BOARD_BASE_URL' },
    { key: 'schedule', name: 'NFL Schedule (ESPN)', configured: scheduleProvider.isConfigured(), purpose: 'Pulls each week\'s games automatically. Free, no key needed.', envVar: 'NFL_DATA_SOURCE' },
    { key: 'live', name: 'NFL Live Scores & Stats (ESPN)', configured: liveScoreProvider.isConfigured(), purpose: 'Powers The Sweat and automatic grading. Free, no key needed.', envVar: 'NFL_DATA_SOURCE' },
    { key: 'stats', name: 'Historical Player Statistics', configured: statsProvider.isConfigured(), purpose: 'Hit rates and matchup research.', envVar: 'NFL_STATS_API_KEY' },
    { key: 'injuries', name: 'Injury Reports', configured: injuryProvider.isConfigured(), purpose: 'Injury context on research panels.', envVar: 'INJURY_API_KEY' },
    { key: 'weather', name: 'Weather', configured: weatherProvider.isConfigured(), purpose: 'Forecasts for outdoor games.', envVar: 'WEATHER_API_KEY' },
    { key: 'news', name: 'News', configured: newsProvider.isConfigured(), purpose: 'Wager-specific news items.', envVar: 'NEWS_API_KEY' },
    { key: 'ai', name: 'AI Research Summaries', configured: aiResearchProvider.isConfigured(), purpose: 'Case For / Case Against write-ups.', envVar: 'ANTHROPIC_API_KEY' },
    { key: 'ocr', name: 'Ticket Reading (OCR)', configured: ticketOcrProvider.isConfigured(), purpose: 'Reads the uploaded Sports Bet Montana ticket.', envVar: 'OCR_API_KEY' },
  ];
  return {
    providers: entries,
    configuredCount: entries.filter((e) => e.configured).length,
    totalCount: entries.length,
    note: 'Features whose data source is not connected show "DATA CURRENTLY UNAVAILABLE" rather than made-up values.',
  };
}
