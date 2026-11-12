import { afterEach, describe, expect, test } from 'bun:test';
import type { AxiosAdapter } from 'axios';
import { apiClient } from '../src/services/api/client';
import { touchSession } from '../src/services/api/session';
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
    // The cookie probe comes first: reusing the browser's session keeps whatever it
    // had unlocked, while a fresh session would ask for the master password again.
    expect(seen).toEqual(['get:/config', 'get:/session', 'post:/session', 'get:/config']);
    expect(readSessionToken()).toBe('fresh-token');
    expect(events.map((event) => event.type)).toEqual([]);
  });

  // A browser that still holds its session cookie does not need a new session at
  // all: the probe answers 200 and the dead token is simply dropped.
  test('keeps the same session when the cookie still resolves it', async () => {
    const events: Event[] = [];
    stubWindow(events);
    writeSessionToken('token-from-a-previous-process');
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });

    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(`${config.method}:${config.url}`);
      if (config.url === '/session' && config.method === 'get') {
        return { data: { id: 'same-session' }, status: 200, statusText: 'OK', headers: {}, config };
      }
      if (config.url === '/config') {
        const token = String(config.headers?.[SESSION_HEADER] ?? '');
        if (token) {
          throw Object.assign(new Error('unauthorized'), {
            isAxiosError: true,
            config,
            response: { data: { error: 'management session expired' }, status: 401, statusText: 'Unauthorized', headers: {}, config },
          });
        }
        return { data: { status: 'ok' }, status: 200, statusText: 'OK', headers: {}, config };
      }
      throw new Error(`unexpected call ${config.method}:${config.url}`);
    };

    await expect(apiClient.get('/config', { adapter })).resolves.toEqual({ status: 'ok' });
    expect(seen).toEqual(['get:/config', 'get:/session', 'get:/config']);
    // No new session was created, so the browser's own cookie carries the rest.
    expect(readSessionToken()).toBeNull();
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

// The reported bug: an operator who was actively working kept being returned to
// the login page. A refused `/session/touch` was one of the causes — the 401 was
// treated as "you were signed out" even though the browser still held a valid
// session cookie and the request could simply be retried on it.
describe('a refused session touch does not end a live session', () => {
  const refusal = (config: unknown, reason: string) =>
    Object.assign(new Error('management session expired'), {
      isAxiosError: true,
      config,
      response: {
        data: { error: 'management session expired', reason },
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config,
      },
    });

  test('rebuilds from the browser cookie and keeps the operator signed in', async () => {
    const events: Event[] = [];
    stubWindow(events);
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: '' });
    writeSessionToken('token-the-server-forgot');

    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(`${config.method}:${config.url}`);
      if (config.url === '/session/touch') throw refusal(config, 'expired');
      // The cookie is still valid: GET /session resolves it without a token.
      expect(config.headers?.[SESSION_HEADER]).toBeUndefined();
      return { data: { id: 'same-session' }, status: 200, statusText: 'OK', headers: {}, config };
    };

    expect(await touchSession({ force: true, adapter })).toBe('renewed');
    // Cookie first: a new session would have dropped the credential unlock.
    expect(seen).toEqual(['post:/session/touch', 'get:/session']);
    expect(readSessionToken()).toBeNull();
    expect(events.map((event) => event.type)).toEqual([]);
  });

  test('falls back to the management key when there is no usable cookie', async () => {
    const events: Event[] = [];
    stubWindow(events);
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    writeSessionToken('token-the-server-forgot');

    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(`${config.method}:${config.url}`);
      if (config.url === '/session/touch') throw refusal(config, 'expired');
      if (config.method === 'get' && config.url === '/session') throw refusal(config, 'missing');
      return { data: { id: 'fresh', token: 'fresh-token' }, status: 200, statusText: 'OK', headers: {}, config };
    };

    expect(await touchSession({ force: true, adapter })).toBe('renewed');
    expect(seen).toEqual(['post:/session/touch', 'get:/session', 'post:/session']);
    expect(readSessionToken()).toBe('fresh-token');
    expect(events.map((event) => event.type)).toEqual([]);
  });

  test('signs out only when neither the cookie nor the key can rebuild it', async () => {
    const events: Event[] = [];
    stubWindow(events);
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: '' });
    writeSessionToken('token-the-server-forgot');

    const adapter: AxiosAdapter = async (config) => {
      throw refusal(config, 'expired');
    };

    expect(await touchSession({ force: true, adapter })).toBe('ended');
    expect(events.map((event) => event.type)).toEqual(['unauthorized']);
  });

  // The service kills a session on its own clocks; that verdict is not a stale
  // token to be papered over. Rebuilding an `idle`/`absolute` refusal would let a
  // background poll silently revive a session the server had already ended —
  // "ten quiet minutes" would stop meaning anything as soon as the key was still
  // in memory.
  for (const reason of ['idle', 'absolute', 'ip'] as const) {
    test(`a ${reason} refusal ends the session instead of rebuilding it`, async () => {
      const events: Event[] = [];
      stubWindow(events);
      apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
      writeSessionToken('token-the-server-forgot');

      const seen: string[] = [];
      const adapter: AxiosAdapter = async (config) => {
        seen.push(`${config.method}:${config.url}`);
        throw refusal(config, reason);
      };

      expect(await touchSession({ force: true, adapter })).toBe('ended');
      // No cookie probe, no new session: the refusal stands.
      expect(seen).toEqual(['post:/session/touch']);
      expect(events.map((event) => event.type)).toEqual(['unauthorized']);
      expect(readSessionToken()).toBeNull();
    });
  }

  test('a network failure is not a sign-out', async () => {
    const events: Event[] = [];
    stubWindow(events);
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });

    const adapter: AxiosAdapter = async () => {
      throw Object.assign(new Error('socket hang up'), { isAxiosError: true, code: 'ECONNRESET' });
    };

    expect(await touchSession({ force: true, adapter })).toBe('ok');
    expect(events.map((event) => event.type)).toEqual([]);
  });
});

// Every other async tail in the panel compares `apiClient.getConnectionRevision()`
// before it writes state. The 401 → `unauthorized` dispatch did not, so a request
// that belonged to the previous connection signed the operator out of the new one:
// `logout()` ends whatever session is current.
describe('a late 401 cannot sign out a newer connection', () => {
  test('drops the sign-out from a request issued under the previous connection', async () => {
    const events: Event[] = [];
    stubWindow(events);
    apiClient.setConfig({ apiBase: 'http://first.invalid', managementKey: 'first-key' });

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let leftTheClient = false;
    // The request leaves under the first connection (the interceptor stamps it
    // there), then the operator switches while it is still in flight.
    const adapter: AxiosAdapter = async (config) => {
      leftTheClient = true;
      await gate;
      throw Object.assign(new Error('unauthorized'), {
        isAxiosError: true,
        config,
        response: { data: { error: 'unauthorized' }, status: 401, statusText: 'Unauthorized', headers: {}, config },
      });
    };

    const pending = apiClient.get('/config', { adapter });
    while (!leftTheClient) await new Promise((resolve) => setTimeout(resolve, 0));
    apiClient.setConfig({ apiBase: 'http://second.invalid', managementKey: 'second-key' });
    release?.();
    await expect(pending).rejects.toBeDefined();

    // The new connection survives: no sign-out was dispatched on its behalf.
    expect(events.map((event) => event.type)).toEqual([]);
  });

  test('still signs out when the 401 belongs to the current connection', async () => {
    const events: Event[] = [];
    stubWindow(events);
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });

    const adapter: AxiosAdapter = async (config) => {
      throw Object.assign(new Error('unauthorized'), {
        isAxiosError: true,
        config,
        response: { data: { error: 'unauthorized' }, status: 401, statusText: 'Unauthorized', headers: {}, config },
      });
    };

    await expect(apiClient.get('/config', { adapter })).rejects.toBeDefined();
    expect(events.map((event) => event.type)).toEqual(['unauthorized']);
  });
});
