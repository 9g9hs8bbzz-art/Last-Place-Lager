import { useEffect, useState } from 'react';
import { api, ApiError, session, fetchProtectedImage } from '../lib/api';
import { Card, Banner, Spinner, Pill, KV, Unavailable } from '../components/ui';
import { odds, relative } from '../lib/format';
import type { WeekInfo } from '../App';

type Tab = 'readiness' | 'reader' | 'ticket' | 'history' | 'settings';

export function Admin({ week }: { week: WeekInfo | null }) {
  const [tab, setTab] = useState<Tab>('readiness');
  return (
    <>
      <div className="tabs">
        <button className={tab === 'readiness' ? 'active' : ''} onClick={() => setTab('readiness')}>Readiness</button>
        <button className={tab === 'reader' ? 'active' : ''} onClick={() => setTab('reader')}>Reader</button>
        <button className={tab === 'ticket' ? 'active' : ''} onClick={() => setTab('ticket')}>Ticket</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
      </div>
      {tab === 'readiness' && <Readiness week={week} />}
      {tab === 'reader' && <Reader week={week} />}
      {tab === 'ticket' && <Ticket week={week} />}
      {tab === 'history' && <History />}
      {tab === 'settings' && <Settings />}
    </>
  );
}

/** Per-member readiness before the wager is placed (spec §53). */
function Readiness({ week }: { week: WeekInfo | null }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { if (week) api(`/admin/weeks/${week.id}/readiness`).then(setData).catch(() => {}); }, [week?.id]);
  if (!week) return <Banner kind="info">No active week.</Banner>;
  if (!data) return <Spinner />;

  return (
    <>
      <Card>
        <div className="row">
          <h2 style={{ margin: 0 }}>Week {week.weekNumber} status</h2>
          <Pill kind={data.summary.actionRequired > 0 ? 'bad' : data.summary.locked === data.summary.total ? 'good' : ''}>
            {String(data.weekStatus).replace(/_/g, ' ')}
          </Pill>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="muted">Locked</span>
          <span className="mono">{data.summary.locked} / {data.summary.total}</span>
        </div>
        {data.summary.actionRequired > 0 && (
          <Banner kind="bad">{data.summary.actionRequired} member(s) need attention before the wager is placed.</Banner>
        )}
      </Card>

      <Card title="Members">
        <div className="list">
          {data.rows.map((r: any) => (
            <div key={r.userId} className="item" style={{ display: 'block', cursor: 'default' }}>
              <div className="row">
                <div className="name">{r.displayName}</div>
                {r.actionRequired ? <Pill kind="bad">Action required</Pill> : <Pill kind="good">Ready</Pill>}
              </div>
              {r.matchupReserved ? (
                <>
                  <div className="tiny" style={{ marginTop: 6 }}>{r.matchup} — {r.selection}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="tiny">
                      {r.matchupReserved ? '✓' : '✗'} Matchup reserved &nbsp;
                      {r.exactMarketAvailable ? '✓' : '❌'} Exact market &nbsp;
                      {r.withinOddsGuideline === false ? '⚠' : '✓'} Odds guideline
                    </span>
                    <span className="tiny mono">Locked {odds(r.lockedOdds)} · Now {odds(r.currentOdds)}</span>
                  </div>
                </>
              ) : (
                <div className="tiny" style={{ marginTop: 6 }}>{r.notes.join(' · ')}</div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

/** The Sports Bet Montana reader dashboard (spec §36). */
function Reader({ week }: { week: WeekInfo | null }) {
  const [data, setData] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => api('/admin/reader').then(setData).catch(() => {});
  useEffect(() => { void load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, []);
  if (!data) return <Spinner />;

  const run = data.lastRun;
  const health = data.health as string;

  return (
    <>
      {msg && <Banner kind="info">{msg}</Banner>}

      <Card>
        <div className="row">
          <h2 style={{ margin: 0 }}>Board reader</h2>
          <Pill kind={health === 'HEALTHY' ? 'good' : health === 'PAUSED_FOR_SAFETY' || health === 'ERROR' ? 'bad' : 'warn'}>
            {health.replace(/_/g, ' ')}
          </Pill>
        </div>
        {!data.configured && (
          <Unavailable
            what="The reader has no Sports Bet Montana address configured."
            reason="Until it is connected, the app shows no odds rather than invented ones. See docs/SETUP.md."
          />
        )}
        <p className="tiny">{data.guidance}</p>
      </Card>

      {data.currentRun && (
        <Card title="Scan in progress">
          <KV k="Started" v={relative(data.currentRun.startedAt)} />
          <KV k="Elapsed" v={`${data.currentRun.elapsedMinutes} min`} />
          <KV k="Progress" v={data.currentRun.progressNote ?? '—'} />
          <KV k="Requests used" v={`${data.currentRun.requestsMade} / ${data.currentRun.requestBudget}`} />
        </Card>
      )}

      <Card title="Last completed scan">
        {!run ? <p className="muted">The reader has not run yet.</p> : (
          <>
            <KV k="Status" v={String(run.status).replace(/_/g, ' ')} />
            <KV k="Finished" v={relative(run.finishedAt)} />
            <KV k="Duration" v={run.durationMinutes === null ? '—' : `${run.durationMinutes} min (20-30 is normal)`} />
            <KV k="Requests used" v={`${run.requestsMade} / ${run.requestBudget}`} />
            <KV k="Events checked" v={run.eventsChecked} />
            <KV k="Cache hits (no work needed)" v={run.cacheHits} />
            <KV k="Markets active" v={run.marketsActive} />
            <KV k="Markets changed" v={run.marketsChanged} />
            <KV k="New markets" v={run.marketsNew} />
            <KV k="Removed / restored" v={`${run.marketsRemoved} / ${run.marketsRestored}`} />
            {run.errorSummary && <KV k="Note" v={run.errorSummary} />}
          </>
        )}
      </Card>

      <Card title="Safety">
        <KV k="Circuit breaker" v={data.circuitBreaker.open ? 'PAUSED FOR SAFETY' : 'Closed'} />
        <KV k="Consecutive failures" v={data.circuitBreaker.consecutiveFailures} />
        {data.circuitBreaker.cooldownUntil && <KV k="Resumes at" v={new Date(data.circuitBreaker.cooldownUntil).toLocaleString()} />}
        {data.circuitBreaker.reason && <KV k="Reason" v={data.circuitBreaker.reason} />}
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            disabled={!data.configured}
            onClick={async () => {
              const r = await api<{ message: string }>('/admin/reader/run', { body: { nflWeekId: week?.id } });
              setMsg(r.message);
            }}
          >
            RUN A SCAN NOW
          </button>
          <button
            disabled={!data.circuitBreaker.open}
            onClick={async () => { await api('/admin/reader/resume', { body: {} }); setMsg('Safety pause cleared.'); void load(); }}
          >
            CLEAR SAFETY PAUSE
          </button>
        </div>
      </Card>

      {data.recentErrors?.length > 0 && (
        <Card title="Recent errors">
          <div className="list">
            {data.recentErrors.slice(0, 8).map((e: any) => (
              <div key={e.id} className="item" style={{ display: 'block', cursor: 'default' }}>
                <div className="name" style={{ fontSize: 13 }}>{e.kind}</div>
                <div className="meta">{e.message}</div>
                <div className="tiny">{relative(e.occurredAt)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

/**
 * The uploaded ticket photo. The API requires a bearer token, so the bytes are
 * fetched and shown as a blob rather than linked directly.
 */
function TicketImage({ ticketId }: { ticketId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchProtectedImage(`/tickets/${ticketId}/image`).then((u) => {
      if (cancelled) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      objectUrl = u;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ticketId]);

  if (failed) {
    return <Unavailable what="The ticket image could not be loaded." reason="It may need to be uploaded again." />;
  }
  if (!url) return <Spinner label="Loading the ticket photo…" />;

  return (
    <img
      src={url}
      alt="The official Sports Bet Montana ticket"
      style={{ width: '100%', borderRadius: 12, border: '1px solid var(--line)' }}
    />
  );
}

/** Upload, verify and confirm the official ticket (spec §54-§57). */
function Ticket({ week }: { week: WeekInfo | null }) {
  const [data, setData] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => { if (week) api(`/admin/weeks/${week.id}/ticket`).then(setData).catch(() => {}); };
  useEffect(load, [week?.id]);

  if (!week) return <Banner kind="info">No active week.</Banner>;

  async function upload(file: File) {
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/admin/weeks/${week!.id}/ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
        body: fd,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? 'Upload failed.');
      setMsg(body.extraction?.extracted ? 'Ticket uploaded and read. Check every leg before confirming.' : 'Ticket uploaded. Enter the ten legs by hand, then verify.');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, body?: unknown) {
    setBusy(true); setError(null);
    try {
      await api(path, { method: 'POST', body: body ?? {} });
      load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const ticket = data?.ticket;

  return (
    <>
      {msg && <Banner kind="info">{msg}</Banner>}
      {error && <Banner kind="bad">{error}</Banner>}

      <Card title="Official Sports Bet Montana ticket">
        <p className="tiny" style={{ marginTop: 0 }}>
          Place the wager yourself at Sports Bet Montana, then upload a photo or screenshot of the ticket here. The
          uploaded ticket becomes the group's authoritative record of what was actually wagered.
        </p>
        <label htmlFor="ticket-file">Ticket photo or screenshot</label>
        <input
          id="ticket-file"
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
        />
      </Card>

      {ticket && (
        <>
          <Card title="The ticket">
            <p className="tiny" style={{ marginTop: 0 }}>
              Check each leg below against this photo before confirming.
            </p>
            <TicketImage ticketId={ticket.id} />
          </Card>

          <Card title="Ticket status">
            <KV k="Status" v={String(ticket.status).replace(/_/g, ' ')} />
            <KV k="Uploaded" v={relative(ticket.uploadedAt)} />
            {ticket.ocrConfidence !== null && ticket.ocrConfidence !== undefined && (
              <KV k="Reading confidence" v={`${Math.round(ticket.ocrConfidence * 100)}%`} />
            )}
            {ticket.extractionNotes && <p className="tiny">{ticket.extractionNotes}</p>}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button disabled={busy} onClick={() => act(`/admin/tickets/${ticket.id}/verify`)}>VERIFY AGAINST LOCKED PICKS</button>
              <button
                className="btn-primary"
                disabled={busy || ticket.status === 'CONFIRMED'}
                onClick={() => {
                  if (confirm('Confirming freezes every member\'s pick for this week and starts live tracking. Continue?')) {
                    void act(`/admin/tickets/${ticket.id}/confirm`);
                  }
                }}
              >
                {ticket.status === 'CONFIRMED' ? 'CONFIRMED' : 'CONFIRM OFFICIAL PARLAY'}
              </button>
            </div>
          </Card>

          <Card title={`Legs (${ticket.legs.length})`}>
            {ticket.legs.length === 0 ? (
              <p className="muted">No legs recorded yet. Add them from the ticket image.</p>
            ) : (
              <div className="list">
                {ticket.legs.map((leg: any) => (
                  <div key={leg.id} className="item" style={{ display: 'block', cursor: 'default' }}>
                    <div className="row">
                      <div className="left">
                        <div className="name" style={{ fontSize: 14 }}>{leg.descriptionText}</div>
                        <div className="meta">{leg.user?.displayName ?? 'Unassigned'}</div>
                      </div>
                      <div className="right">
                        <Pill kind={leg.verification === 'MATCH' ? 'good' : leg.verification === 'MATCH_ODDS_CHANGED' ? 'info' : 'bad'}>
                          {String(leg.verification).replace(/_/g, ' ')}
                        </Pill>
                        <div className="tiny mono" style={{ marginTop: 4 }}>{odds(leg.americanOdds)}</div>
                      </div>
                    </div>
                    {leg.verificationNote && <div className="tiny" style={{ marginTop: 6 }}>{leg.verificationNote}</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

/** Historical import and the permanent correction record (spec §83, §84). */
function History() {
  const [preview, setPreview] = useState<any>(null);
  const [corrections, setCorrections] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/admin/corrections').then(setCorrections).catch(() => {}); }, [msg]);

  async function upload(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/import/preview', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
        body: fd,
      });
      setPreview(await res.json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {msg && <Banner kind="info">{msg}</Banner>}

      <Card title="Import the historical spreadsheet">
        <p className="tiny" style={{ marginTop: 0 }}>
          Nothing is written until you review the preview and press Apply.
        </p>
        <label htmlFor="wb">Workbook (.xlsx)</label>
        <input id="wb" type="file" accept=".xlsx" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      </Card>

      {preview && (
        <Card title="Import preview">
          <KV k="Seasons found" v={preview.seasonsFound?.join(', ')} />
          <KV k="Weeks found" v={preview.weeksFound?.length} />
          <KV k="Unique picks found" v={preview.rowCount} />
          <KV k="Duplicates excluded" v={preview.duplicatesExcluded} />
          <KV k="Users matched" v={preview.usersMatched?.length} />
          <KV k="Week Offs" v={preview.weekOffs?.map((w: any) => `${w.season} W${w.week}`).join(', ')} />
          <KV k="Corrections applied" v={preview.overridesApplied} />
          <KV k="Scores restored" v={preview.scoresRestored} />
          <KV k="Needing review" v={preview.needsReview?.length ?? 0} />

          {preview.conflicts?.length > 0 && (
            <>
              <h2 style={{ marginTop: 16 }}>Flagged for audit</h2>
              <div className="list">
                {preview.conflicts.map((c: any, i: number) => (
                  <div key={i} className="item" style={{ display: 'block', cursor: 'default' }}>
                    <div className="name" style={{ fontSize: 13 }}>{c.scope.replace(/_/g, ' ')}</div>
                    <div className="meta">{c.season} W{c.week} {c.bettor ?? ''} {c.field ?? ''}</div>
                    <div className="tiny" style={{ marginTop: 4 }}>{c.detail}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          <button
            className="btn-primary"
            style={{ marginTop: 16 }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<any>('/admin/import/apply', { body: { storedPath: preview.storedPath, fileName: 'history.xlsx' } });
                setMsg(`Imported ${r.summary.rowCount} picks.`);
                setPreview(null);
              } finally {
                setBusy(false);
              }
            }}
          >
            APPLY IMPORT
          </button>
        </Card>
      )}

      <Card title="Correction record">
        <p className="tiny" style={{ marginTop: 0 }}>
          Approved corrections always beat the raw spreadsheet, so the same fixes never have to be made twice.
        </p>
        {!corrections ? <Spinner /> : (
          <div className="list">
            {corrections.corrections.map((c: any) => (
              <div key={c.id} className="item" style={{ display: 'block', cursor: 'default' }}>
                <div className="row">
                  <div className="left">
                    <div className="name" style={{ fontSize: 14 }}>{c.seasonYear} W{c.weekNumber} · {c.bettorName}</div>
                    <div className="meta">{c.field}: {c.originalValue ?? '(blank)'} → {c.correctedValue}</div>
                  </div>
                  <div className="right">
                    <Pill kind={c.status === 'APPROVED' ? 'good' : ''}>{c.status}</Pill>
                    {c.canonical && <div className="tiny" style={{ marginTop: 4 }}>canonical</div>}
                  </div>
                </div>
                <div className="tiny" style={{ marginTop: 6 }}>{c.reason}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function Settings() {
  const [data, setData] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { api('/admin/settings').then(setData).catch(() => {}); }, [msg]);
  if (!data) return <Spinner />;

  return (
    <>
      {msg && <Banner kind="info">{msg}</Banner>}

      <Card title="Odds guideline">
        <p className="tiny" style={{ marginTop: 0 }}>
          A guideline, not a rule: picks outside this range warn the member but are always allowed.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            await api('/admin/settings/guideline', {
              method: 'PATCH',
              body: {
                minAmerican: Number(f.get('min')),
                maxAmerican: Number(f.get('max')),
                movementPointsThreshold: Number(f.get('move')),
              },
            });
            setMsg('Odds guideline updated.');
          }}
        >
          <div className="grid2">
            <div className="field"><label>Minimum</label><input name="min" type="number" defaultValue={data.guideline.minAmerican} /></div>
            <div className="field"><label>Maximum</label><input name="max" type="number" defaultValue={data.guideline.maxAmerican} /></div>
          </div>
          <div className="field">
            <label>Alert when implied probability moves by (percentage points)</label>
            <input name="move" type="number" step="0.5" defaultValue={data.guideline.movementPointsThreshold} />
          </div>
          <button>SAVE GUIDELINE</button>
        </form>
      </Card>

      <Card title="Reader pacing">
        <p className="tiny" style={{ marginTop: 0 }}>
          These values exist to keep traffic to Sports Bet Montana as low as possible. Longer delays and smaller budgets
          are always safer. A scan taking 20-30 minutes is the intended behaviour.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            await api('/admin/reader/settings', {
              method: 'PATCH',
              body: {
                enabled: f.get('enabled') === 'on',
                requestBudgetPerRun: Number(f.get('budget')),
                minDelayMs: Number(f.get('minDelay')) * 1000,
                maxDelayMs: Number(f.get('maxDelay')) * 1000,
              },
            });
            setMsg('Reader settings updated.');
          }}
        >
          <div className="field">
            <label>Reader switched on</label>
            <input name="enabled" type="checkbox" defaultChecked={data.reader.enabled} style={{ width: 'auto', minHeight: 'auto' }} />
          </div>
          <div className="field"><label>Maximum requests per scan</label><input name="budget" type="number" defaultValue={data.reader.requestBudgetPerRun} /></div>
          <div className="grid2">
            <div className="field"><label>Minimum delay (seconds)</label><input name="minDelay" type="number" defaultValue={Math.round(data.reader.minDelayMs / 1000)} /></div>
            <div className="field"><label>Maximum delay (seconds)</label><input name="maxDelay" type="number" defaultValue={Math.round(data.reader.maxDelayMs / 1000)} /></div>
          </div>
          <button>SAVE READER SETTINGS</button>
        </form>
      </Card>

      <Card title="Connected data sources">
        <p className="tiny" style={{ marginTop: 0 }}>{data.integrations.note}</p>
        <div className="list">
          {data.integrations.providers.map((p: any) => (
            <div key={p.key} className="item" style={{ display: 'block', cursor: 'default' }}>
              <div className="row">
                <div className="left">
                  <div className="name" style={{ fontSize: 14 }}>{p.name}</div>
                  <div className="meta">{p.purpose}</div>
                </div>
                <div className="right"><Pill kind={p.configured ? 'good' : 'warn'}>{p.configured ? 'Connected' : 'Not connected'}</Pill></div>
              </div>
              {!p.configured && <div className="tiny" style={{ marginTop: 6 }}>Set <code>{p.envVar}</code> — see docs/SETUP.md</div>}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
