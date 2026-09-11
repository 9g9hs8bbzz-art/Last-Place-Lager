import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Banner, Spinner, Pill, statusPill } from '../components/ui';
import { odds, money } from '../lib/format';
import type { WeekInfo } from '../App';

interface SweatLeg {
  legIndex: number;
  bettor: string;
  description: string;
  americanOdds: number | null;
  state: string;
  current: number | null;
  needed: string | null;
  narrative: string | null;
  awaitingManualGrading: boolean;
  matchup: string | null;
  quarter: string | null;
  clock: string | null;
}

export function Sweat({ week }: { week: WeekInfo | null }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    if (!week) return;
    const load = () => api(`/weeks/${week.id}/sweat`).then(setData).catch(() => {});
    void load();
    // Refresh while games are in progress. This polls our own API only —
    // never Sports Bet Montana.
    const timer = setInterval(load, 45_000);
    return () => clearInterval(timer);
  }, [week?.id]);

  if (!week) return <Banner kind="info">No active week yet.</Banner>;
  if (!data) return <Spinner />;

  if (!data.available) {
    return (
      <Card title="The Sweat">
        <p className="muted">{data.reason}</p>
        <p className="tiny">Live tracking begins once the parlay manager confirms the official ticket.</p>
      </Card>
    );
  }

  const { counts, legs, finalLeg, parlay } = data as { counts: any; legs: SweatLeg[]; finalLeg: SweatLeg | null; parlay: any };

  return (
    <>
      <Card>
        <div className="grid2">
          <Stat label="Won" value={counts.won} tone="good" />
          <Stat label="Live" value={counts.live} tone="warn" />
          <Stat label="Not started" value={counts.notStarted} />
          <Stat label="Lost" value={counts.lost} tone={counts.lost > 0 ? 'bad' : ''} />
        </div>
        {parlay.combinedAmericanOdds !== null && (
          <div className="row" style={{ marginTop: 14 }}>
            <span className="muted">Parlay price</span>
            <span className="mono" style={{ fontWeight: 700 }}>{odds(parlay.combinedAmericanOdds)}</span>
          </div>
        )}
        {parlay.potentialPayout !== null && (
          <div className="row">
            <span className="muted">Potential payout</span>
            <span className="mono" style={{ fontWeight: 700, color: 'var(--gold)' }}>{money(parlay.potentialPayout)}</span>
          </div>
        )}
      </Card>

      {finalLeg && (
        <Card>
          <div className="center">
            <div className="big" style={{ color: 'var(--gold)', fontSize: 34 }}>{counts.won} / {legs.length} ✓</div>
            <h3 style={{ marginTop: 6 }}>ONE LEG REMAINS</h3>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 12 }}>{finalLeg.bettor}</div>
            <div className="muted">{finalLeg.description}</div>
            {finalLeg.needed && <div className="big" style={{ color: 'var(--amber)', marginTop: 12 }}>{finalLeg.needed}</div>}
            {finalLeg.quarter && <div className="tiny" style={{ marginTop: 6 }}>{finalLeg.quarter} · {finalLeg.clock}</div>}
          </div>
        </Card>
      )}

      <Card title="Every leg">
        <div className="list">
          {legs.map((leg) => (
            <div key={leg.legIndex} className="item" style={{ display: 'block', cursor: 'default' }}>
              <div className="row">
                <div className="left">
                  <div className="name">{leg.bettor}</div>
                  <div className="meta">{leg.description}</div>
                </div>
                <div className="right">
                  {statusPill(leg.state)}
                  <div className="tiny mono" style={{ marginTop: 4 }}>{odds(leg.americanOdds)}</div>
                </div>
              </div>
              {(leg.needed || leg.narrative || leg.awaitingManualGrading) && (
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="tiny" style={{ color: leg.state === 'LOST' ? 'var(--red)' : 'var(--amber)' }}>
                    {leg.awaitingManualGrading ? 'AWAITING MANUAL GRADING' : leg.needed ?? leg.narrative}
                  </span>
                  {leg.current !== null && <span className="tiny mono">Current: {leg.current}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: number; tone?: string }) {
  const color = tone === 'good' ? 'var(--green)' : tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'var(--text)';
  return (
    <div>
      <div className="big" style={{ color }}>{value}</div>
      <div className="tiny">{label}</div>
    </div>
  );
}
