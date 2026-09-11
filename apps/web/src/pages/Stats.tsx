import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Spinner, Pill } from '../components/ui';
import { odds, pct, money } from '../lib/format';

type Tab = 'season' | 'alltime' | 'group' | 'history' | 'awards';

export function Stats() {
  const [tab, setTab] = useState<Tab>('season');
  return (
    <>
      <div className="tabs">
        <button className={tab === 'season' ? 'active' : ''} onClick={() => setTab('season')}>This Season</button>
        <button className={tab === 'alltime' ? 'active' : ''} onClick={() => setTab('alltime')}>All Time</button>
        <button className={tab === 'group' ? 'active' : ''} onClick={() => setTab('group')}>Group</button>
        <button className={tab === 'awards' ? 'active' : ''} onClick={() => setTab('awards')}>Awards</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button>
      </div>
      {tab === 'season' && <Leaderboard season={new Date().getFullYear()} />}
      {tab === 'alltime' && <Leaderboard />}
      {tab === 'group' && <GroupStats />}
      {tab === 'awards' && <Awards />}
      {tab === 'history' && <History />}
    </>
  );
}

function Leaderboard({ season }: { season?: number }) {
  const [data, setData] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);

  useEffect(() => {
    setData(null);
    api(`/stats/leaderboard${season ? `?season=${season}` : ''}`).then(setData).catch(() => setData({ rows: [] }));
  }, [season]);

  if (!data) return <Spinner />;
  if (data.rows.length === 0) {
    return <Card title={season ? `${season} standings` : 'All-time standings'}><p className="muted">No settled picks recorded for this period yet.</p></Card>;
  }

  return (
    <>
      <Card title={season ? `${season} standings` : 'All-time standings'}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Bettor</th><th>W</th><th>L</th><th>Win %</th><th>Avg Odds</th><th>$10 P/L</th><th>ROI</th><th>Streak</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.displayName} onClick={() => api(`/stats/profile/${r.displayName}`).then(setProfile)} style={{ cursor: 'pointer' }}>
                  <td>{r.displayName}</td>
                  <td className="mono">{r.wins}</td>
                  <td className="mono">{r.losses}</td>
                  <td className="mono">{pct(r.winPct)}</td>
                  <td className="mono">{odds(r.averageOdds)}</td>
                  <td className="mono" style={{ color: r.profit >= 0 ? 'var(--green)' : 'var(--red)' }}>{money(r.profit)}</td>
                  <td className="mono">{pct(r.roi)}</td>
                  <td className="mono">{r.currentStreak.kind ? `${r.currentStreak.kind}${r.currentStreak.length}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tiny" style={{ marginTop: 10, marginBottom: 0 }}>{data.note}</p>
      </Card>

      {profile && (
        <Card title={`${profile.displayName} — profile`}>
          <div className="row">
            <span className="muted">All time</span>
            <span className="mono">{profile.allTime.wins}-{profile.allTime.losses} · {odds(profile.allTime.averageOdds)} · ROI {pct(profile.allTime.roi)}</span>
          </div>
          <h2 style={{ marginTop: 16 }}>By market</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Market</th><th>W</th><th>L</th><th>Win %</th><th>Avg Odds</th></tr></thead>
              <tbody>
                {profile.byMarket.map((m: any) => (
                  <tr key={m.label}><td>{m.label}</td><td className="mono">{m.wins}</td><td className="mono">{m.losses}</td><td className="mono">{pct(m.winPct)}</td><td className="mono">{odds(m.averageOdds)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 style={{ marginTop: 16 }}>By price range</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Range</th><th>W</th><th>L</th><th>Win %</th></tr></thead>
              <tbody>
                {profile.byOddsRange.map((m: any) => (
                  <tr key={m.label}><td>{m.label}</td><td className="mono">{m.wins}</td><td className="mono">{m.losses}</td><td className="mono">{pct(m.winPct)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn-sm" style={{ marginTop: 14 }} onClick={() => setProfile(null)}>Close profile</button>
        </Card>
      )}
    </>
  );
}

function GroupStats() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api('/stats/group').then(setData).catch(() => {}); }, []);
  if (!data) return <Spinner />;
  const p = data.parlays;

  return (
    <>
      <Card title="Group parlay record">
        <div className="grid2">
          <Fig label="Parlays played" value={p.totalParlays} />
          <Fig label="Weeks off" value={p.weeksOff} />
          <Fig label="Parlays won" value={p.parlaysWon} />
          <Fig label="10 / 10 weeks" value={p.tenOfTenWeeks} />
          <Fig label="9 / 10 weeks" value={p.nineOfTenWeeks} />
          <Fig label="Avg legs won" value={p.averageLegsWon === null ? '—' : p.averageLegsWon.toFixed(1)} />
        </div>
      </Card>
      <Card title="Group tendencies">
        {data.tendencies.notes.length === 0 ? <p className="muted">Not enough settled picks yet.</p> : (
          <ul className="muted" style={{ paddingLeft: 18, margin: 0 }}>
            {data.tendencies.notes.map((n: any, i: number) => <li key={i} style={{ marginBottom: 8 }}>{n.text}</li>)}
          </ul>
        )}
        <p className="tiny" style={{ marginTop: 12, marginBottom: 0 }}>{data.tendencies.disclaimer}</p>
      </Card>
    </>
  );
}

function Awards() {
  const [data, setData] = useState<any>(null);
  const [season, setSeason] = useState<number | undefined>(undefined);
  useEffect(() => { setData(null); api(`/stats/awards${season ? `?season=${season}` : ''}`).then(setData).catch(() => {}); }, [season]);

  return (
    <>
      <div className="tabs">
        <button className={season === undefined ? 'active' : ''} onClick={() => setSeason(undefined)}>All Time</button>
        <button className={season === 2025 ? 'active' : ''} onClick={() => setSeason(2025)}>2025</button>
        <button className={season === 2024 ? 'active' : ''} onClick={() => setSeason(2024)}>2024</button>
      </div>
      {!data ? <Spinner /> : (
        <Card title="Awards">
          <div className="list">
            {data.awards.map((a: any) => (
              <div key={a.awardKey} className="item" style={{ cursor: 'default' }}>
                <div className="left"><div className="name">{a.label}</div><div className="meta">{a.detail}</div></div>
                <div className="right"><Pill kind="gold">{a.winner}</Pill></div>
              </div>
            ))}
          </div>
          <p className="tiny" style={{ marginTop: 12, marginBottom: 0 }}>{data.note}</p>
        </Card>
      )}
    </>
  );
}

function History() {
  const [data, setData] = useState<any>(null);
  const [season, setSeason] = useState(2025);
  useEffect(() => { setData(null); api(`/history/picks?season=${season}`).then(setData).catch(() => {}); }, [season]);

  const weeks = data ? [...new Set<number>(data.picks.map((p: any) => p.weekNumber as number))].sort((a, b) => b - a) : [];

  return (
    <>
      <div className="tabs">
        {[2025, 2024].map((y) => (
          <button key={y} className={season === y ? 'active' : ''} onClick={() => setSeason(y)}>{y}</button>
        ))}
      </div>
      {!data ? <Spinner /> : (
        <>
          {data.weeksOff.filter((w: any) => w.seasonYear === season).map((w: any) => (
            <Card key={w.weekNumber} title={`Week ${w.weekNumber}`}>
              <h3 style={{ margin: 0 }}>WEEK OFF</h3>
              <p className="tiny" style={{ marginBottom: 0 }}>{w.reason}</p>
            </Card>
          ))}
          {weeks.map((wk) => {
            const rows = data.picks.filter((p: any) => p.weekNumber === wk);
            const won = rows.filter((r: any) => r.result === 'WIN').length;
            return (
              <Card key={wk} title={`Week ${wk} — ${won}/${rows.length} legs won`}>
                <div className="list">
                  {rows.map((p: any) => (
                    <div key={p.id} className="item" style={{ display: 'block', cursor: 'default' }}>
                      <div className="row">
                        <div className="left">
                          <div className="name" style={{ fontSize: 14 }}>{p.bettorName}</div>
                          <div className="meta">{p.pickText}</div>
                        </div>
                        <div className="right">
                          <Pill kind={p.result === 'WIN' ? 'good' : 'bad'}>{p.result === 'WIN' ? 'W' : 'L'}</Pill>
                          <div className="tiny mono" style={{ marginTop: 4 }}>{odds(p.americanOdds)}</div>
                        </div>
                      </div>
                      <div className="tiny" style={{ marginTop: 6 }}>
                        {p.matchupText}{p.outcomeText ? ` · ${p.outcomeText}` : ''}
                        {p.corrected && <> · <Pill kind="info">corrected</Pill></>}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </>
      )}
    </>
  );
}

function Fig({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="big">{value}</div><div className="tiny">{label}</div></div>;
}
