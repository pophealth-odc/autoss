/**
 * Small preferences saved in the browser (service address, pairing token, form values, theme).
 * Screenshots and their metadata are NEVER stored here: they live in the local service's folder.
 */

const PREFIX = 'ssg.';

function read(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null; // storage blocked (private window, policy)
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}

export function loadJson<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  const raw = read(key);
  if (raw === null) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (validate && !validate(value)) return fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  return write(key, JSON.stringify(value));
}

export function loadString(key: string): string | null {
  return read(key);
}

export function saveString(key: string, value: string): boolean {
  return write(key, value);
}

export function removeKey(key: string): void {
  remove(key);
}

export const KEYS = {
  serviceUrl: 'serviceUrl',
  token: 'token',
  rememberToken: 'rememberToken',
  form: 'form',
  theme: 'theme',
  sort: 'sort',
  urlText: 'urlText',
} as const;

/**
 * The pairing token is kept for the browser session only unless the person opts in to remembering it, because anything
 * in localStorage is readable by every script on this page's origin (and on GitHub Pages that origin is shared with all
 * other pages of the same user).
 */
export function loadToken(): { token: string | null; remembered: boolean } {
  const remembered = read(KEYS.rememberToken) === 'true';
  try {
    const session = sessionStorage.getItem(PREFIX + KEYS.token);
    if (session) return { token: session, remembered };
  } catch {
    /* sessionStorage blocked */
  }
  return { token: remembered ? read(KEYS.token) : null, remembered };
}

export function saveToken(token: string | null, remember: boolean): void {
  remove(KEYS.token);
  try {
    sessionStorage.removeItem(PREFIX + KEYS.token);
  } catch {
    /* ignore */
  }
  write(KEYS.rememberToken, remember ? 'true' : 'false');
  if (token === null || token === '') return;
  if (remember) write(KEYS.token, token);
  try {
    sessionStorage.setItem(PREFIX + KEYS.token, token);
  } catch {
    /* ignore */
  }
}
