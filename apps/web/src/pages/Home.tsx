import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type SessionUser } from '../lib/api';
import { Card, Banner, Spinner, Pill, statusPill } from '../components/ui';
import { odds, kickoff, wagerLabel } from '../lib/format';
import type { WeekInfo } from '../App';

interface HomeData {
  week: WeekInfo;
  myPick: {
    id: string;
    state: 'PENDING' | 'LOCKED';
    matchup: string;
    kickoffAt: string;
    marketId: string;
    marketLabel: string;
    selectionLabel: string;
    subjectLabel: string | null;
    lockedOdds: number | null;
    currentOdds: number | null;
    marketAvailable: boolean;
    marketUnavailable: boolean;
    outsideGuidelineNow: boolean | null;
    movement: { impliedProbabilityPoints: number; message: string | null; crossedIntoOutsideGuideline: boolean } | null;
    freshness: string;
    lockExplanation: string;
  } | null;
  board: { lockedCount: number; memberCount: number; rows: BoardRow[] };
}

export interface BoardRow {
  userId: string;
  displayName: string;
  status: string;
  matchup: string | null;
  selection: string | null;
  subject: string | null;
  lockedOdds: number | null;
  currentOdds: number | null;
  marketUnavailable: boolean;
  result: string | null;
  isSelf: boolean;
}

export function Home({ week, user }: { week: WeekInfo | null; user: SessionUser }) {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function load() {
    if (!week) return;
    try {
      setData(await api<HomeData>(`/weeks/${week.id}/home`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [week?.id]);

  if (!week) {
    return (
      <Banner kind="info">
        No NFL week has been set up yet. The parlay manager can create one from the Admin screen.
      </Banner>
    );
  }

  if (week.status === 'WEEK_OFF') {
    return (
      <Card title={`Week ${week.weekNumber}`}>
        <h3>WEEK OFF</h3>
        <p className="muted">{week.weekOffReason ?? 'The group is intentionally skipping this week.'}</p>
      </Card>
    );
  }

  if (!data) return <Spinner />;

  const pick = data.myPick;

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body: body ?? {} });
      await load();
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <Banner kind="bad">{error}</Banner>}

      {/* The first question the app answers: what is my pick this week? */}
      {!pick && (
        <Card>
          <h2>Your pick — Week {week.weekNumber}</h2>
          <h3 style={{ fontSize: 22, marginBottom: 14 }}>No Pick Selected</h3>
          <button className="btn-primary" onClick={() => navigate('/picks')}>MAKE A PICK</button>
        </Card>
      )}

      {pick?.state === 'PENDING' && (
        <Card>
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Pending pick</h2>
            <Pill kind="info">Matchup not reserved</Pill>
          </div>
          <h3>{wagerLabel(pick.subjectLabel, pick.selectionLabel)}</h3>
          <div className="muted">{pick.matchup} · {kickoff(pick.kickoffAt)}</div>
          <div className="row" style={{ marginTop: 12 }}>
            <span className="muted">Current Sports Bet Montana odds</span>
            <span className="big mono">{odds(pick.currentOdds)}</span>
          </div>
          <div className="tiny" style={{ marginTop: 6 }}>{pick.freshness}</div>

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn-primary" disabled={busy} onClick={() => act(`/weeks/${week.id}/lock`, { marketId: pick.marketId, acknowledgeOutsideGuideline: true })}>
              LOCK PICK
            </button>
            <button onClick={() => navigate(`/picks?research=${pick.marketId}`)}>RESEARCH</button>
            <button onClick={() => navigate('/picks')}>CHANGE PICK</button>
            <button className="btn-danger" disabled={busy} onClick={() => act(`/weeks/${week.id}/pending-pick`, undefined)}>REMOVE</button>
          </div>
          <p className="tiny" style={{ marginTop: 12, marginBottom: 0 }}>
            A pending pick is private and does not reserve the matchup. Another member can still take this game.
          </p>
        </Card>
      )}

      {pick?.state === 'LOCKED' && (
        <Card>
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Locked — matchup reserved</h2>
            {pick.marketUnavailable ? <Pill kind="bad">Action required</Pill> : <Pill kind="good">Reserved</Pill>}
          </div>
          <h3>{wagerLabel(pick.subjectLabel, pick.selectionLabel)}</h3>
          <div className="muted">{pick.matchup} · {kickoff(pick.kickoffAt)}</div>

          <div className="grid2" style={{ marginTop: 14 }}>
            <div>
              <div className="tiny">Odds when locked</div>
              <div className="big mono">{odds(pick.lockedOdds)}</div>
            </div>
            <div>
              <div className="tiny">Current SBM odds</div>
              <div className="big mono">{odds(pick.currentOdds)}</div>
            </div>
          </div>

          {pick.movement?.message && (
            <Banner kind={pick.movement.crossedIntoOutsideGuideline ? 'warn' : 'info'}>
              {pick.movement.message}
              <div className="tiny" style={{ marginTop: 4 }}>
                Your matchup stays reserved and your wager is unchanged.
              </div>
            </Banner>
          )}

          {pick.marketUnavailable && (
            <Banner kind="bad">
              <strong>ACTION REQUIRED</strong>
              <div style={{ marginTop: 4 }}>
                Your locked wager is no longer available at Sports Bet Montana. Your matchup remains reserved — choose
                another wager from this matchup, or unlock the matchup.
              </div>
            </Banner>
          )}

          <div className="tiny" style={{ marginTop: 10 }}>{pick.freshness}</div>

          <div className="btn-row" style={{ marginTop: 16 }}>
            <button onClick={() => navigate(`/picks?research=${pick.marketId}`)}>RESEARCH</button>
            <button
              className="btn-danger"
              disabled={busy || week.frozen}
              onClick={() => {
                if (confirm('Unlocking immediately releases this matchup to the rest of the group. Continue?')) {
                  void act(`/weeks/${week.id}/unlock`);
                }
              }}
            >
              UNLOCK / EDIT
            </button>
          </div>
          <p className="tiny" style={{ marginTop: 12, marginBottom: 0 }}>{pick.lockExplanation}</p>
        </Card>
      )}

      <Card>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>This week's parlay</h2>
          <Pill kind={data.board.lockedCount === data.board.memberCount ? 'good' : ''}>
            {data.board.lockedCount} / {data.board.memberCount} Locked
          </Pill>
        </div>
        <div className="list">
          {data.board.rows.map((row) => (
            <div className="item" key={row.userId} style={{ cursor: 'default' }}>
              <div className="left">
                <div className="name">
                  {row.displayName}
                  {row.isSelf && <span className="tiny"> (you)</span>}
                </div>
                {/* A pending pick belonging to someone else is never revealed. */}
                <div className="meta">{row.matchup ?? (row.status === 'PENDING' ? 'Working on it' : '—')}</div>
              </div>
              <div className="right">{statusPill(row.result ?? (row.marketUnavailable ? 'ACTION_REQUIRED' : row.status))}</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
