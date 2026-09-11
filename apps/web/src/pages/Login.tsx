import { useState } from 'react';
import { login, type SessionUser } from '../lib/api';
import { Card, Banner } from '../components/ui';

export function Login({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
  const [displayName, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await login(displayName.trim(), password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app" style={{ paddingBottom: 0 }}>
      <main style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="center" style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 46 }}>🏈</div>
          <h1 style={{ margin: '10px 0 4px', fontSize: 24 }}>First Class Parlays</h1>
          <div className="muted">Last Place Lager's weekly 10-leg parlay</div>
        </div>

        <Card>
          <form onSubmit={submit}>
            {error && <Banner kind="bad">{error}</Banner>}
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" value={displayName} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="words" required />
            </div>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
            <button className="btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'SIGN IN'}</button>
          </form>
        </Card>

        <div className="tiny center" style={{ padding: '0 16px 24px' }}>
          21+. First Class Parlays is a private record-keeping tool for one group of friends. It is not Sports Bet Montana,
          is not a sportsbook, and no wager can be placed here.
        </div>
      </main>
    </div>
  );
}
