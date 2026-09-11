export function odds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const n = Math.round(value);
  return n > 0 ? `+${n}` : `${n}`;
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function kickoff(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function relative(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const d = typeof value === 'string' ? new Date(value) : value;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Wager label for display. Some markets name their subject inside the
 * selection text ("Broncos Moneyline"), so prefixing the subject again would
 * read as "Broncos — Broncos Moneyline".
 */
export function wagerLabel(subject: string | null | undefined, selection: string): string {
  if (!subject) return selection;
  const s = subject.trim().toLowerCase();
  return selection.toLowerCase().includes(s) ? selection : `${subject} — ${selection}`;
}
