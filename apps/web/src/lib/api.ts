/**
 * API client.
 *
 * Tokens live in localStorage rather than a browser-only cookie so the exact
 * same request flow works from a future iOS/Android client (spec §92).
 */
const ACCESS_KEY = 'fcp.accessToken';
const REFRESH_KEY = 'fcp.refreshToken';
const USER_KEY = 'fcp.user';

export interface SessionUser {
  id: string;
  displayName: string;
  role: 'MEMBER' | 'ADMIN';
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
  }
}

export const session = {
  get accessToken() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refreshToken() {
    return localStorage.getItem(REFRESH_KEY);
  },
  get user(): SessionUser | null {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  },
  save(accessToken: string, refreshToken: string, user: SessionUser) {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    [ACCESS_KEY, REFRESH_KEY, USER_KEY].forEach((k) => localStorage.removeItem(k));
  },
};

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;
  const token = session.refreshToken;
  if (!token) return false;

  refreshing = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) {
        session.clear();
        return false;
      }
      const data = await res.json();
      session.save(data.accessToken, data.refreshToken, data.user);
      return true;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; formData?: FormData; retry?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = session.accessToken;
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method: options.method ?? (options.body || options.formData ? 'POST' : 'GET'),
    headers,
    body: options.formData ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });

  // One silent retry after refreshing an expired access token.
  if (res.status === 401 && options.retry !== false && (await refreshSession())) {
    return api<T>(path, { ...options, retry: false });
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? 'Something went wrong.', data.detail);
  }
  return data as T;
}

export async function login(displayName: string, password: string): Promise<SessionUser> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'ERROR', data.message ?? 'Sign in failed.');
  session.save(data.accessToken, data.refreshToken, data.user);
  return data.user;
}

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // Signing out locally must work even if the request fails.
  }
  session.clear();
}

/**
 * Fetch a protected image and turn it into a URL an <img> can use.
 *
 * The API authenticates with a bearer token, and an <img src> cannot send an
 * Authorization header, so the bytes are fetched here and handed to the browser
 * as a blob URL. Revoke it when the view goes away.
 */
export async function fetchProtectedImage(path: string): Promise<string | null> {
  const token = session.accessToken;
  const res = await fetch(`/api${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401 && (await refreshSession())) return fetchProtectedImage(path);
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
