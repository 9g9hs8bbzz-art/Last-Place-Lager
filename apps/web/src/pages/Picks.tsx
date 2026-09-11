import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Card, Banner, Spinner, Pill, Sheet, Unavailable, KV } from '../components/ui';
import { odds, kickoff, relative, wagerLabel } from '../lib/format';
import type { WeekInfo } from '../App';

interface GameRow {
  id: string;
  label: string;
  kickoffAt: string;
  state: 'AVAILABLE' | 'MY_PENDING_GAME' | 'MY_RESERVED_GAME' | 'RESERVED_BY_OTHER' | 'NOT_ELIGIBLE' | 'STARTED' | 'CLOSED';
  reservedBy: string | null;
  selectable: boolean;
  eligible: boolean;
  eligibilityNote: string | null;
}

interface MarketRow {
  id: string;
  category: string;
  marketLabel: string;
  subjectLabel: string | null;
  selectionLabel: string;
  line: number | null;
  americanOdds: number | null;
  available: boolean;
  source: string;
  manualNote: string | null;
  outsideGuideline: boolean | null;
  freshness: string;
}

export function Picks({ week }: { week: WeekInfo | null }) {
  const [games, setGames] = useState<GameRow[] | null>(null);
  const [game, setGame] = useState<GameRow | null>(null);
  const [markets, setMarkets] = useState<{ available: boolean; message?: string; markets: MarketRow[] } | null>(null);
  const [research, setResearch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();

  useEffect(() => {
    if (!week) return;
    api<{ games: GameRow[] }>(`/weeks/${week.id}/games`).then((d) => setGames(d.games)).catch((e) => setError((e as Error).message));
  }, [week?.id]);

  useEffect(() => {
    const r = params.get('research');
    if (r) setResearch(r);
  }, [params]);

  async function openGame(g: GameRow) {
    setGame(g);
    setMarkets(null);
    setMarkets(await api(`/games/${g.id}/markets`));
  }

  async function choose(market: MarketRow, mode: 'lock' | 'pending') {
    if (!week) return;

    // Outside the guideline is allowed — the member is asked, not blocked (spec §30).
    if (mode === 'lock' && market.outsideGuideline) {
      const ok = confirm(
        `⚠ OUTSIDE GROUP ODDS GUIDELINE\n\nCurrent Odds: ${odds(market.americanOdds)}\nPreferred Range: -200 to +200\n\nSELECT ANYWAY?`,
      );
      if (!ok) return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'lock') {
        const res = await api<{ matchup: string; guidelineMessage: string | null }>(`/weeks/${week.id}/lock`, {
          body: { marketId: market.id, acknowledgeOutsideGuideline: true },
        });
        setNotice(`LOCKED — ${res.matchup} is reserved for you.`);
      } else {
        await api(`/weeks/${week.id}/pending-pick`, { body: { marketId: market.id } });
        setNotice('Saved as a pending pick. This does not reserve the matchup.');
      }
      setGame(null);
      const d = await api<{ games: GameRow[] }>(`/weeks/${week.id}/games`);
      setGames(d.games);
    } catch (e) {
      setError((e as ApiError).message);
      if (week) setGames((await api<{ games: GameRow[] }>(`/weeks/${week.id}/games`)).games);
    } finally {
      setBusy(false);
    }
  }

  async function watch(market: MarketRow) {
    if (!week) return;
    await api(`/weeks/${week.id}/watchlist`, { body: { marketId: market.id } });
    setNotice('Added to your watchlist. Watching does not reserve the matchup.');
  }

  if (!week) return <Banner kind="info">No active week yet.</Banner>;
  if (!games) return <Spinner />;

  const eligible = games.filter((g) => g.eligible);
  const notEligible = games.filter((g) => !g.eligible);

  return (
    <>
      {error && <Banner kind="bad">{error}</Banner>}
      {notice && <Banner kind="info">{notice}</Banner>}

      {games.length === 0 && (
        <Unavailable what="No games have been loaded for this week yet." reason="An administrator can add the week's games from the Admin screen." />
      )}

      {eligible.length > 0 && (
        <Card title="Eligible games">
          <div className="list">
            {eligible.map((g) => (
              <button
                key={g.id}
                className={`item ${g.state === 'RESERVED_BY_OTHER' || g.state === 'STARTED' || g.state === 'CLOSED' ? 'disabled' : ''} ${g.state === 'MY_RESERVED_GAME' || g.state === 'MY_PENDING_GAME' ? 'mine' : ''}`}
                disabled={!g.selectable}
                onClick={() => openGame(g)}
              >
                <div className="left">
                  <div className="name">{g.label}</div>
                  <div className="meta">{kickoff(g.kickoffAt)}</div>
                </div>
                <div className="right">{gameStatePill(g)}</div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {notEligible.length > 0 && (
        <Card title="Not eligible this week">
          <p className="tiny" style={{ marginTop: 0 }}>
            These games are shown for research only and cannot be selected for this week's parlay.
          </p>
          <div className="list">
            {notEligible.map((g) => (
              <button key={g.id} className="item disabled" onClick={() => openGame(g)}>
                <div className="left">
                  <div className="name">{g.label}</div>
                  <div className="meta">{g.eligibilityNote ?? "NOT ELIGIBLE FOR THIS WEEK'S PARLAY"}</div>
                </div>
                <div className="right"><Pill>Research only</Pill></div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {game && (
        <Sheet title={game.label} onClose={() => setGame(null)}>
          {!markets && <Spinner label="Loading Sports Bet Montana offerings…" />}
          {markets && !markets.available && <Unavailable what={markets.message ?? 'No offerings loaded for this game.'} />}
          {markets?.available && (
            <div className="list">
              {markets.markets.map((m) => (
                <div key={m.id} className="item" style={{ display: 'block', cursor: 'default' }}>
                  <div className="row">
                    <div className="left">
                      <div className="name">{wagerLabel(m.subjectLabel, m.selectionLabel)}</div>
                      <div className="meta">
                        {m.marketLabel}
                        {m.source !== 'SBM_BOARD_READER' && <> · <Pill kind="warn">Entered by hand</Pill></>}
                      </div>
                    </div>
                    <div className="right">
                      <div className="big mono">{odds(m.americanOdds)}</div>
                      {m.outsideGuideline && <Pill kind="warn">Outside guideline</Pill>}
                    </div>
                  </div>
                  <div className="tiny" style={{ marginTop: 6 }}>{m.freshness}</div>
                  <div className="btn-row" style={{ marginTop: 10 }}>
                    <button className="btn-primary btn-sm" disabled={busy || !game.selectable || !m.available} onClick={() => choose(m, 'lock')}>LOCK</button>
                    <button className="btn-sm" disabled={busy || !game.selectable} onClick={() => choose(m, 'pending')}>PENDING</button>
                    <button className="btn-sm" onClick={() => setResearch(m.id)}>RESEARCH</button>
                    <button className="btn-sm" onClick={() => watch(m)}>WATCH</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Sheet>
      )}

      {research && <ResearchSheet marketId={research} onClose={() => setResearch(null)} />}
    </>
  );
}

function gameStatePill(g: GameRow) {
  switch (g.state) {
    case 'MY_RESERVED_GAME': return <Pill kind="gold">Your matchup</Pill>;
    case 'MY_PENDING_GAME': return <Pill kind="info">Your pending</Pill>;
    case 'RESERVED_BY_OTHER': return <Pill kind="bad">{g.reservedBy}</Pill>;
    case 'STARTED': return <Pill>Started</Pill>;
    case 'CLOSED': return <Pill>Final</Pill>;
    default: return <Pill kind="good">Available</Pill>;
  }
}

/** The research panel, assembled for this exact wager (spec §37-§51). */
function ResearchSheet({ marketId, onClose }: { marketId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api(`/markets/${marketId}/research`).then(setData).catch((e) => setError((e as Error).message));
  }, [marketId]);

  if (error) return <Sheet title="Research" onClose={onClose}><Banner kind="bad">{error}</Banner></Sheet>;
  if (!data) return <Sheet title="Research" onClose={onClose}><Spinner /></Sheet>;

  const w = data.wager;

  return (
    <Sheet title="Research" onClose={onClose}>
      <Card>
        <h3>{w.description}</h3>
        <div className="muted">{w.matchup} · {kickoff(w.kickoffAt)}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="muted">Sports Bet Montana</span>
          <span className="big mono">{odds(w.americanOdds)}</span>
        </div>
        <div className="tiny">Verified {relative(w.lastVerifiedAt)}</div>
      </Card>

      <Section title="Hit rate" section={data.hitRates}>
        {(rows: any[]) => (
          <div>
            {rows.map((r, i) => (
              <KV key={i} k={r.sample.replace(/_/g, ' ')} v={`${r.display} (${r.sampleSize} games)`} />
            ))}
            <p className="tiny" style={{ marginTop: 8, marginBottom: 0 }}>Sample sizes are always shown. A small sample is not strong evidence.</p>
          </div>
        )}
      </Section>

      <Section title="Alternate lines" section={data.alternates}>
        {(rows: any[]) => (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Line</th><th>SBM odds</th><th>Available</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.marketId} style={r.isCurrent ? { color: 'var(--gold)' } : undefined}>
                    <td>{r.label}</td>
                    <td className="mono">{odds(r.americanOdds)}</td>
                    <td>{r.available ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Line movement" section={data.lineMovement}>
        {(rows: any[]) =>
          rows.length === 0 ? <p className="tiny">No price changes recorded yet.</p> : (
            <div>{rows.map((s, i) => <KV key={i} k={new Date(s.observedAt).toLocaleString()} v={odds(s.americanOdds)} />)}</div>
          )
        }
      </Section>

      <Section title="Opponent matchup" section={data.defense}>{(rows: any[]) => <div>{rows.map((r, i) => <KV key={i} k={r.label} v={r.rank ? `${r.value} (rank ${r.rank})` : String(r.value)} />)}</div>}</Section>
      <Section title="Injuries" section={data.injuries}>{(rows: any[]) => <div>{rows.map((r: any, i: number) => <KV key={i} k={`${r.playerName} (${r.position ?? '—'})`} v={r.status} />)}</div>}</Section>
      <Section title="Weather" section={data.weather}>
        {(d: any) => d.indoor ? <p className="muted">{d.note ?? 'Indoor game — weather not expected to materially affect play.'}</p> : (
          <div><KV k="Temperature" v={`${d.temperatureF ?? '—'}°F`} /><KV k="Wind" v={`${d.windMph ?? '—'} mph`} /><KV k="Conditions" v={d.conditions ?? '—'} /></div>
        )}
      </Section>
      <Section title="News" section={data.news}>
        {(rows: any[]) => (
          <div className="list">
            {rows.map((n: any, i: number) => (
              <div key={i} className="item" style={{ display: 'block', cursor: 'default' }}>
                <div className="name" style={{ fontSize: 14 }}>{n.title}</div>
                <div className="meta">{n.source}{n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleDateString()}` : ''}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Case for / case against" section={data.summary}>
        {(d: any) => (
          <div>
            <strong style={{ color: 'var(--green)' }}>CASE FOR</strong>
            <ul className="muted">{d.caseFor.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            <strong style={{ color: 'var(--red)' }}>CASE AGAINST</strong>
            <ul className="muted">{d.caseAgainst.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
            <strong>BOTTOM LINE</strong>
            <p className="muted">{d.bottomLine}</p>
            <p className="tiny">{d.note}</p>
          </div>
        )}
      </Section>

      <Card title={`This group's history (${data.groupHistory.sampleSize} similar picks)`}>
        {data.groupHistory.data.length === 0 ? (
          <p className="tiny">No similar picks in the group's records yet.</p>
        ) : (
          <div className="list">
            {data.groupHistory.data.slice(0, 8).map((h: any) => (
              <div key={h.id} className="item" style={{ cursor: 'default' }}>
                <div className="left">
                  <div className="name" style={{ fontSize: 14 }}>{h.pickText}</div>
                  <div className="meta">{h.seasonYear} W{h.weekNumber} · {h.bettorName}</div>
                </div>
                <div className="right"><Pill kind={h.result === 'WIN' ? 'good' : 'bad'}>{h.result}</Pill></div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Sheet>
  );
}

function Section({ title, section, children }: { title: string; section: any; children: (data: any) => React.ReactNode }) {
  return (
    <Card title={title}>
      {section?.available && section.data ? (
        <>
          {children(section.data)}
          <p className="tiny" style={{ marginTop: 10, marginBottom: 0 }}>
            Source: {section.provider} · collected {relative(section.fetchedAt)}
          </p>
        </>
      ) : (
        <Unavailable what={title} reason={section?.unavailableReason} />
      )}
    </Card>
  );
}
