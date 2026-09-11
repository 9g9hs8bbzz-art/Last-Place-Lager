import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { session, api, logout, type SessionUser } from './lib/api';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Picks } from './pages/Picks';
import { Parlay } from './pages/Parlay';
import { Sweat } from './pages/Sweat';
import { Stats } from './pages/Stats';
import { Admin } from './pages/Admin';
import { Legal } from './pages/Legal';

export interface WeekInfo {
  id: string;
  weekNumber: number;
  seasonYear: number;
  status: string;
  frozen: boolean;
  weekOffReason: string | null;
}

export function App() {
  const [user, setUser] = useState<SessionUser | null>(session.user);
  const [week, setWeek] = useState<WeekInfo | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!user) {
      setReady(true);
      return;
    }
    api<{ week: WeekInfo | null }>('/current-week')
      .then((d) => setWeek(d.week))
      .catch(() => session.clear())
      .finally(() => setReady(true));
  }, [user]);

  if (!ready) return <div className="spinner">Loading…</div>;
  if (!user) return <Login onSignedIn={setUser} />;

  return (
    <BrowserRouter>
      <Shell
        user={user}
        week={week}
        onSignOut={async () => {
          await logout();
          setUser(null);
        }}
      />
    </BrowserRouter>
  );
}

function Shell({ user, week, onSignOut }: { user: SessionUser; week: WeekInfo | null; onSignOut: () => void }) {
  const location = useLocation();

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>First Class Parlays</h1>
          <div className="sub">
            {week ? `${week.seasonYear} · Week ${week.weekNumber}` : 'No active week'} · {user.displayName}
          </div>
        </div>
        <button className="btn-sm" onClick={onSignOut}>Sign out</button>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Home week={week} user={user} />} />
          <Route path="/picks" element={<Picks week={week} />} />
          <Route path="/parlay" element={<Parlay week={week} />} />
          <Route path="/sweat" element={<Sweat week={week} />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/legal" element={<Legal />} />
          <Route path="/admin" element={user.role === 'ADMIN' ? <Admin week={week} /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <nav className="bottomnav" key={location.pathname}>
        <Tab to="/" glyph="🏈" label="HOME" />
        <Tab to="/picks" glyph="📋" label="PICKS" />
        <Tab to="/parlay" glyph="🎟️" label="PARLAY" />
        <Tab to="/sweat" glyph="🔥" label="SWEAT" />
        <Tab to="/stats" glyph="📊" label="STATS" />
        {user.role === 'ADMIN' && <Tab to="/admin" glyph="⚙️" label="ADMIN" />}
      </nav>
    </div>
  );
}

function Tab({ to, glyph, label }: { to: string; glyph: string; label: string }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span className="glyph">{glyph}</span>
      {label}
    </NavLink>
  );
}
