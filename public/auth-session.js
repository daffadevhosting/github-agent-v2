export function parseAuthHash(hash = (typeof window !== 'undefined' ? window.location.hash : '')) {
  const raw = hash || '';
  if (!raw || !raw.startsWith('#auth=')) return null;

  try {
    const payload = raw.slice('#auth='.length);
    const parsed = JSON.parse(decodeURIComponent(payload));
    if (!parsed || !parsed.token || !parsed.user) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readStoredAuth() {
  try {
    const raw = localStorage.getItem('github-agent-auth');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveAuth(auth) {
  if (!auth || !auth.token) return null;

  try {
    localStorage.setItem('github-agent-auth', JSON.stringify(auth));
    return auth;
  } catch {
    return null;
  }
}

export function clearAuth() {
  try {
    localStorage.removeItem('github-agent-auth');
  } catch {
    // ignore storage error
  }
}

export function bootstrapAuthSession() {
  const fromHash = parseAuthHash();
  const auth = fromHash || readStoredAuth();

  if (!auth || !auth.token) return null;

  saveAuth(auth);

  if (typeof window !== 'undefined' && window.location.hash.startsWith('#auth=')) {
    const url = new URL(window.location.href);
    url.hash = '';
    window.history.replaceState({}, '', url.toString());
  }

  return auth;
}

export async function authenticatedFetch(input, init = {}) {
  const auth = readStoredAuth();
  if (!auth?.token) {
    return fetch(input, init);
  }

  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${auth.token}`);
  return fetch(input, { ...init, headers });
}
