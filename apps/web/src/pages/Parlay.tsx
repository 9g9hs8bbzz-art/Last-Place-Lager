import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Banner, Spinner, Pill, statusPill } from '../components/ui';
import { odds, wagerLabel } from '../lib/format';
import type { WeekInfo } from '../App';
import type { BoardRow } from './Home';

export function Parlay({ week }: { week: WeekInfo | null }) {
  const [board, setBoard] = useState<{ lockedCount: number; memberCount: number; rows: BoardRow[]; week: WeekInfo } | null>(null);
  const [status, setStatus] = useState<{ label: string; health: string; paused: boolean; note: string } | null>(null);

  useEffect(() => {
    if (!week) return;
    void api(`/weeks/${week.id}/board`).then(setBoard as never);
    void api('/sportsbook/status').then(setStatus as never);
  }, [week?.id]);

  if (!week) return <Banner kind="info">No active week yet.</Banner>;
  if (week.status === 'WEEK_OFF') {
    return <Card title={`Week ${week.weekNumber}`}><h3>WEEK OFF</h3><p className="muted">{week.weekOffReason}</p></Card>;
  }
  if (!board) return <Spinner />;

  return (
    <>
      {status && (
        <div className={`banner ${status.health === 'HEALTHY' ? '' : 'warn'}`}>
          {status.label}
          <div className="tiny" style={{ marginTop: 4 }}>{status.note}</div>
        </div>
      )}

      <Card>
        <div className="row">
          <div>
            <h2 style={{ margin: 0 }}>Week {week.weekNumber} parlay</h2>
            <div className="tiny">{week.seasonYear} season</div>
          </div>
          <Pill kind={board.lockedCount === board.memberCount ? 'good' : ''}>
            {board.lockedCount} / {board.memberCount} Locked
          </Pill>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="muted">Week status</span>
          {statusPill(week.status)}
        </div>
      </Card>

      <Card title="All ten selections">
        <div className="list">
          {board.rows.map((r) => (
            <div key={r.userId} className="item" style={{ display: 'block', cursor: 'default' }}>
              <div className="row">
                <div className="left">
                  <div className="name">{r.displayName}{r.isSelf && <span className="tiny"> (you)</span>}</div>
                  <div className="meta">{r.matchup ?? (r.status === 'PENDING' ? 'Working on it' : 'No pick yet')}</div>
                </div>
                <div className="right">{statusPill(r.result ?? (r.marketUnavailable ? 'ACTION_REQUIRED' : r.status))}</div>
              </div>
              {r.selection && (
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="tiny">{wagerLabel(r.subject, r.selection)}</span>
                  <span className="mono tiny">
                    {r.lockedOdds !== null && <>locked {odds(r.lockedOdds)}</>}
                    {r.currentOdds !== null && r.lockedOdds !== r.currentOdds && <> · now {odds(r.currentOdds)}</>}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <p className="tiny center">
        The official Sports Bet Montana ticket, once uploaded and confirmed by the parlay manager, is the authoritative
        record of what was actually wagered.
      </p>
    </>
  );
}
