import { afterEach, describe, expect, test } from 'bun:test';
import type { AxiosAdapter } from 'axios';
import { apiClient } from '../src/services/api/client';
import { readSessionToken, SESSION_HEADER, writeSessionToken, clearSessionToken } from '../src/services/api/sessionToken';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  clearSessionToken();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/** Minimal window stub: the panel writes the session token through localStorage. */
function stubWindow(events: Event[]): void {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
      localStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
          entries.set(key, value);
        },
        removeItem: (key: string) => {
          entries.delete(key);
        },
      },
    },
  });
}

describe('v8 management transport', () => {
  test('uses the v8 prefix, bearer authentication and bare JSON scalar writes', async () => {
    apiClient.setConfig({
      apiBase: 'https://proxy.invalid/gateway/v8/management',
      managementKey: 'fixture-only',
    });
    const adapter: AxiosAdapter = async (config) => {
      expect(config.baseURL).toBe('https://proxy.invalid/gateway/v8/management');
      expect(config.url).toBe('/config/observability/logs/debug');
      expect(config.headers.Authorization).toBe('Bearer fixture-only');
      expect(config.data).toBe('false');
      return { data: { status: 'ok' }, status: 200, statusText: 'OK', headers: {}, config };
    };
    await apiClient.put('/config/observability/logs/debug', false, { adapter });
  });

  test('retains backend version and plugin support events', async () => {
    const events: Event[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event);
          return true;
        },
      },
    });
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    const adapter: AxiosAdapter = async (config) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      config,
      headers: { 'x-cpa-version': 'v8.0.3', 'x-cpa-support-plugin': 'true' },
    });
    await apiClient.get('/config', { adapter });
    expect(events.map((event) => event.type)).toEqual([
      'server-version-update',
      'server-plugin-support-update',
    ]);
    expect((events[0] as CustomEvent).detail.version).toBe('v8.0.3');
    expect((events[1] as CustomEvent).detail.supportsPlugin).toBe(true);
  });

  // A browser can still hold the token of a previous process (backend restarted,
  // or the session idled out while the page was closed). The probe that replaces
  // it must not be read as "you were signed out" -- otherwise the very login that
  // would have replaced the token fails with "invalid management key".
  test('treats a 401 from the session probe as a stale token, not a sign-out', async () => {
    const events: Event[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event);
          return true;
        },
      },
    });
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    const rejecting: AxiosAdapter = async (config) => {
      throw Object.assign(new Error('unauthorized'), {
        isAxiosError: true,
        config,
        response: {
          data: { error: 'management session expired' },
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          config,
        },
      });
    };

    await expect(apiClient.get('/session', { adapter: rejecting })).rejects.toBeDefined();
    expect(events.map((event) => event.type)).toEqual([]);

    // A real endpoint still signs the operator out.
    await expect(apiClient.get('/config', { adapter: rejecting })).rejects.toBeDefined();
    expect(events.map((event) => event.type)).toEqual(['unauthorized']);
  });

  // The session dies with the backend process, but an open tab does not: after a
  // restart every request arrives with a token the server no longer knows. That
  // 401 is about the token, so the panel opens a new session and replays the
  // request instead of throwing the operator back to the login page.
  test('renews the session and replays a request whose token the server dropped', async () => {
    const events: Event[] = [];
    stubWindow(events);
    writeSessionToken('token-from-a-previous-process');
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });

    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(`${config.method}:${config.url}`);
      const token = String(config.headers?.[SESSION_HEADER] ?? '');
      if (config.url === '/session' && config.method === 'post') {
        expect(token).toBe('');
        return { data: { id: 'fresh', token: 'fresh-token' }, status: 200, statusText: 'OK', headers: {}, config };
      }
      if (token !== 'fresh-token') {
        throw Object.assign(new Error('unauthorized'), {
          isAxiosError: true,
          config,
          response: { data: { error: 'unknown session' }, status: 401, statusText: 'Unauthorized', headers: {}, config },
        });
      }
      return { data: { status: 'ok' }, status: 200, statusText: 'OK', headers: {}, config };
    };

    await expect(apiClient.get('/config', { adapter })).resolves.toEqual({ status: 'ok' });
    expect(seen).toEqual(['get:/config', 'post:/session', 'get:/config']);
    expect(readSessionToken()).toBe('fresh-token');
    expect(events.map((event) => event.type)).toEqual([]);
  });

  // Renewing is only worth trying because the management key is still good. When
  // it is not, the panel must sign out exactly as before.
  test('signs out when the session cannot be renewed', async () => {
    const events: Event[] = [];
    stubWindow(events);
    writeSessionToken('token-from-a-previous-process');
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });

    const unauthorized = (config: unknown) =>
      Object.assign(new Error('unauthorized'), {
        isAxiosError: true,
        config,
        response: { data: { error: 'unauthorized' }, status: 401, statusText: 'Unauthorized', headers: {}, config },
      });
    const adapter: AxiosAdapter = async (config) => {
      throw unauthorized(config);
    };

    await expect(apiClient.get('/config', { adapter })).rejects.toBeDefined();
    expect(events.map((event) => event.type)).toEqual(['unauthorized']);
  });
});
