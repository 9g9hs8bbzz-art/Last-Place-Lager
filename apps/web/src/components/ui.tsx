import type { ReactNode } from 'react';

export function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function Pill({ kind = '', children }: { kind?: string; children: ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="spinner">{label}</div>;
}

/**
 * Shown wherever a data source has not been connected. The app says so plainly
 * instead of displaying invented numbers (spec §95).
 */
export function Unavailable({ what, reason }: { what: string; reason?: string | null }) {
  return (
    <div className="banner">
      <strong>DATA CURRENTLY UNAVAILABLE</strong>
      <div className="tiny" style={{ marginTop: 4 }}>
        {what}
        {reason ? ` — ${reason}` : ''}
      </div>
    </div>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn-sm" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function statusPill(status: string) {
  const map: Record<string, { kind: string; label: string }> = {
    LOCKED: { kind: 'good', label: 'Locked' },
    OFFICIAL: { kind: 'gold', label: 'Official' },
    PENDING: { kind: 'info', label: 'Pending' },
    NO_PICK: { kind: '', label: 'No Pick' },
    ACTION_REQUIRED: { kind: 'bad', label: 'Action Required' },
    WIN: { kind: 'good', label: 'Won' },
    LOSS: { kind: 'bad', label: 'Lost' },
    PUSH: { kind: 'warn', label: 'Push' },
    VOID: { kind: 'warn', label: 'Void' },
    WON: { kind: 'good', label: 'Won' },
    LOST: { kind: 'bad', label: 'Lost' },
    LIVE: { kind: 'warn', label: 'Live' },
    NOT_STARTED: { kind: '', label: 'Not Started' },
  };
  const m = map[status] ?? { kind: '', label: status.replace(/_/g, ' ') };
  return <Pill kind={m.kind}>{m.label}</Pill>;
}
