import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The gate components bind CSS-module classes at import time, which Bun cannot
// render, so these are source contracts. The behaviour they protect was verified
// in a real browser (a signed-out session must never show the dialog, and a
// verify round-trip must not blank the form mid-flight).
const gateModal = readFileSync(
  new URL('../src/features/sms/SecretGateModal.tsx', import.meta.url),
  'utf8'
);
const gateBanner = readFileSync(
  new URL('../src/features/sms/SecretLockedBanner.tsx', import.meta.url),
  'utf8'
);
const gateStore = readFileSync(
  new URL('../src/stores/useSecretGateStore.ts', import.meta.url),
  'utf8'
);

/**
 * The implementation body of a store action, so assertions cannot match the
 * `name: () => void;` declaration in the state interface or another action.
 * `end` is the first marker after the action (the following action).
 */
function sourceActionBody(source: string, name: string, endMarker: string): string {
  // lastIndexOf: the state interface declares `name: (...) => ...;` earlier in
  // the file; the implementation is always the final occurrence.
  const start = source.lastIndexOf(`${name}: `);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf(endMarker);
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

function actionBody(name: string, endMarker: string): string {
  return sourceActionBody(gateStore, name, endMarker);
}

/** The `const open = ...;` expression from the dialog, whitespace collapsed. */
function openExpression(): string {
  const start = gateModal.indexOf('const open =');
  expect(start).toBeGreaterThan(-1);
  const end = gateModal.indexOf(';', start);
  return gateModal.slice(start, end).replace(/\s+/g, ' ');
}

describe('secret gate is scoped to an authenticated session', () => {
  test('the dialog opens only while authenticated', () => {
    // A stale storeAvailable/passphraseSet from a previous session must not put
    // the dialog on top of the login page.
    expect(openExpression()).toContain('isAuthenticated');
    expect(openExpression()).toContain("phase === 'idle'");
  });

  test('the dialog stays up while the verify round-trip is in flight', () => {
    // Closing on `verifying` blanks the form mid-request and lets a stray click
    // hit whatever is underneath.
    expect(openExpression()).toContain("phase === 'verifying'");
  });

  test('the dialog probe still waits for authentication', () => {
    const probe = gateModal
      .split('\n')
      .find((line) => line.includes('if (phase !== ') && line.includes('return;'));
    expect(probe).toBeDefined();
    expect(probe).toContain('isAuthenticated');
  });

  test('the locked banner is hidden outside an authenticated session', () => {
    const guard = gateBanner.split('\n').find((line) => line.includes('if (!isAuthenticated'));
    expect(guard).toBeDefined();
    expect(guard).toContain("phase !== 'locked'");
  });

  test('the banner is rendered inside the padded content, not on the shell', () => {
    // `.main-header` is `position: fixed` with z-index 1001 and spans the top
    // --header-height of the viewport; `.content` starts at y=0. Only
    // `.main-content` carries the padding that reserves room for the header, so a
    // banner mounted as a direct child of `.content` is laid out at y=0 and its
    // "verify" button ends up underneath the header's floating action cluster —
    // a real click lands on the header instead. Verified in a browser: at a 721px
    // window the banner button and the header actions overlapped.
    const mainLayout = readFileSync(
      new URL('../src/components/layout/MainLayout.tsx', import.meta.url),
      'utf8'
    );
    const bannerAt = mainLayout.indexOf('<SecretLockedBanner />');
    const mainOpenAt = mainLayout.indexOf('className={`main-content');
    const mainCloseAt = mainLayout.indexOf('</main>');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(mainOpenAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeGreaterThan(mainOpenAt);
    expect(bannerAt).toBeLessThan(mainCloseAt);
  });
});

describe('logging out clears the whole gate, not just the phase', () => {
  test('reset drops the store probes as well as the phase', () => {
    const body = actionBody('reset', 'setIdleTimeout:');
    expect(body).toContain("phase: 'idle'");
    // Left behind, these two would re-open the dialog on the login page.
    expect(body).toContain('passphraseSet: false');
    expect(body).toContain('storeAvailable: false');
  });

  test('skip and reset agree on what a locked session looks like', () => {
    expect(actionBody('skip', 'touch:')).toContain("phase: 'locked'");
  });
});

describe('a choice made mid-verify wins over the in-flight result', () => {
  test('verify applies its outcome only while still verifying', () => {
    const body = actionBody('verifyAndUnlock', 'skip:');
    // Both the failure and the success path must bail out if the gate moved on
    // (operator skipped or logged out while the request was in flight).
    const guards = body.match(/if \(get\(\)\.phase !== 'verifying'\) return false;/g) ?? [];
    expect(guards).toHaveLength(2);
  });

  test('a failed verify returns to the state it was asked from', () => {
    // The dialog lives in two places: the sign-in dialog (idle) and the locked
    // banner's dialog (locked). Forcing `idle` on failure unmounted the banner's
    // dialog and popped the sign-in one instead, dropping the "wrong password"
    // message on the floor.
    const body = actionBody('verifyAndUnlock', 'skip:');
    expect(body).toContain('const previousPhase = get().phase;');
    expect(body).toContain("phase: previousPhase === 'verifying' ? 'idle' : previousPhase");
  });
});

describe('unlock state is the server’s answer about this session', () => {
  test('the gate no longer keeps its own copy of "verified"', () => {
    // A browser-side marker was the source of both reported bugs: it could survive
    // into a brand-new session (log out, log back in, no master password asked) and
    // it could be missing while the session really was unlocked (dialog on top of
    // working credentials). The server already knows; a second copy only disagrees
    // with it.
    expect(gateStore).not.toContain('SESSION_VERIFIED_KEY');
    expect(gateStore).not.toContain('sessionStorage.');
    expect(gateStore).not.toContain('markSessionVerified');
    expect(gateModal).not.toContain('isSessionVerified');
  });

  test('reload resumes verified only when the backend says so', () => {
    const probe = gateModal.slice(gateModal.indexOf('secretStoreApi'));
    expect(probe).toContain('status.unlocked');
    expect(probe).toContain("useSecretGateStore.setState({ phase: 'unlocked' })");
  });

  test('a skipped session stays locked until the server is asked again', () => {
    expect(actionBody('skip', 'touch:')).toContain("phase: 'locked'");
  });
});

describe('a management session carries the credential authorization', () => {
  const authStore = readFileSync(new URL('../src/stores/useAuthStore.ts', import.meta.url), 'utf8');
  const sessionApi = readFileSync(new URL('../src/services/api/session.ts', import.meta.url), 'utf8');
  const sessionToken = readFileSync(
    new URL('../src/services/api/sessionToken.ts', import.meta.url),
    'utf8'
  );
  const client = readFileSync(new URL('../src/services/api/client.ts', import.meta.url), 'utf8');

  test('the token is shared across tabs, so one unlock serves every tab', () => {
    // sessionStorage is per tab: unlocking in tab A would leave tab B asking for
    // the master password, which is the exact annoyance this replaces.
    expect(sessionToken).toContain('window.localStorage.setItem(SESSION_TOKEN_KEY');
    expect(sessionToken).toContain('window.localStorage.getItem(SESSION_TOKEN_KEY)');
    expect(sessionToken).not.toContain('sessionStorage.');
    expect(sessionToken).toContain("SESSION_HEADER = 'X-CPA-Session'");
  });

  test('every request carries the session token', () => {
    expect(client).toContain('readSessionToken()');
    expect(client).toContain('config.headers[SESSION_HEADER] = sessionToken');
  });

  test('creating a session does not present a stale token', () => {
    // The middleware rejects an expired token, so sending one while opening a new
    // session would make "expired" unrecoverable.
    expect(client).toContain('carriesSessionToken(config.method, config.url)');
    expect(client).toContain("path.endsWith('/session')");
  });

  test('login establishes a session before the panel reads anything', () => {
    const body = sourceActionBody(authStore, 'login', 'logout:');
    const establishAt = body.indexOf('await establishSession();');
    const authenticatedAt = body.indexOf('isAuthenticated: true');
    expect(establishAt).toBeGreaterThan(-1);
    expect(authenticatedAt).toBeGreaterThan(-1);
    expect(establishAt).toBeLessThan(authenticatedAt);
  });

  test('a session is reused when it is still alive, so F5 does not re-ask', () => {
    expect(sessionApi).toContain('export async function ensureManagementSession');
    expect(sessionApi).toContain('await sessionApi.describe()');
  });

  test('only real activity touches the session, and not on every event', () => {
    expect(sessionApi).toContain('TOUCH_INTERVAL_MS');
    const idleGuard = readFileSync(
      new URL('../src/features/sms/SecretGateIdleGuard.tsx', import.meta.url),
      'utf8'
    );
    expect(idleGuard).toContain('void touchSession()');
  });
});

describe('logging out ends the session for the store as well', () => {
  const authStore = readFileSync(new URL('../src/stores/useAuthStore.ts', import.meta.url), 'utf8');
  const idleGuard = readFileSync(
    new URL('../src/features/sms/SecretGateIdleGuard.tsx', import.meta.url),
    'utf8'
  );

  /** The implementation body of a store action (last occurrence, as in actionBody). */
  function authActionBody(name: string, endMarker: string): string {
    return sourceActionBody(authStore, name, endMarker);
  }

  test('logout ends the management session, which drops its credentials grant', () => {
    // Logging out IS "end the session". If the front end only forgot the session
    // while the backend kept the grant, logging out and back in would hand anyone
    // with the management key the credentials with no master password.
    const body = authActionBody('logout', 'checkAuth:');
    expect(body).toContain('sessionApi.end()');
    expect(body).toContain('reset()');
  });

  test('the end request is issued with the management key, before that key is cleared', () => {
    // /session is authenticated: calling it after clearing the management key
    // returns 401 "missing management key". The front-end state is cleared
    // synchronously, but `apiClient` only after the request settles.
    const body = authActionBody('logout', 'checkAuth:');
    const endAt = body.indexOf('sessionApi.end()');
    const clearAt = body.indexOf("apiClient.setConfig({ apiBase: '', managementKey: '' })");
    expect(endAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(endAt);
  });

  test('the front-end session ends synchronously, not when the request settles', () => {
    // Waiting for the backend left the operator on the protected page until it
    // resolved — indefinitely if the backend hung.
    const body = authActionBody('logout', 'checkAuth:');
    const sessionClearedAt = body.indexOf('isAuthenticated: false');
    const settleAt = body.indexOf('.then(settleClient, settleClient)');
    expect(sessionClearedAt).toBeGreaterThan(-1);
    expect(settleAt).toBeGreaterThan(-1);
    expect(sessionClearedAt).toBeLessThan(settleAt);
    expect(body).toContain("managementKey: ''");
  });

  test('a login that lands mid-logout is not clobbered by the late settle', () => {
    const body = authActionBody('logout', 'checkAuth:');
    expect(body).toContain('apiClient.getConnectionRevision()');
    expect(body).toContain('if (apiClient.getConnectionRevision() === revision)');
  });

  test('both logout paths end the session through logout()', () => {
    // Idle timeout must not end the session on its own path: the guard cancels its
    // timer when it logs out. One request, inside logout(), covers idle timeout and
    // manual logout alike.
    expect(idleGuard).not.toContain('sessionApi.end()');
    expect(idleGuard).toContain('logout()');
  });

  test('logout is re-entrant: a second call reuses the in-flight one', () => {
    // logout() issues an authenticated /session. If that 401s, the client
    // dispatches `unauthorized`, whose listener calls logout() again — without a
    // latch the second call fires another request.
    expect(authStore).toContain('let logoutPromise: Promise<void> | null = null;');
    const body = authActionBody('logout', 'checkAuth:');
    expect(body).toContain('if (logoutPromise) return logoutPromise;');
  });

  test('no request is issued once the session credentials are gone', () => {
    // apiClient's baseURL is empty by then, so the request would fall through to a
    // relative `/session` (no /v8/management prefix) and 404.
    const body = authActionBody('logout', 'checkAuth:');
    expect(body).toContain('apiBase && managementKey ? sessionApi.end() : Promise.resolve()');
  });
});

describe('idle expiry is shared across tabs and keeps the newest activity', () => {
  const idleGuard = readFileSync(
    new URL('../src/features/sms/SecretGateIdleGuard.tsx', import.meta.url),
    'utf8'
  );
  const idleActivity = readFileSync(
    new URL('../src/features/sms/idleActivity.ts', import.meta.url),
    'utf8'
  );

  test('the activity clock is origin-wide, not per tab', () => {
    // `lastActivityAt` is in-memory state, so a reload resets it to "now" — that
    // alone made "load the page, then touch nothing" impossible to time out.
    // sessionStorage is not the answer either: it is per tab, so two panels
    // cannot see each other's activity. localStorage is shared per origin.
    expect(idleActivity).toContain("SHARED_ACTIVITY_KEY = 'cpa.secret-gate.lastActivity'");
    expect(idleActivity).toContain('window.localStorage.setItem(SHARED_ACTIVITY_KEY');
    expect(idleActivity).toContain('window.localStorage.getItem(SHARED_ACTIVITY_KEY)');
    // No code may read or write sessionStorage: it is per tab. (The rationale is
    // named in a comment, so match the calls, not the word.)
    expect(idleActivity).not.toContain('sessionStorage.');
    expect(idleGuard).not.toContain('sessionStorage.');
  });

  test('the newest activity wins, so one active tab keeps the session alive', () => {
    // max(), not min(): min() would let an idle tab's stale stamp log out a tab
    // the operator is actively using. "Idle" means no tab has been touched.
    expect(idleGuard).toContain('Math.max(inMemory, shared ?? 0)');
  });

  test('activity is recorded when it happens', () => {
    expect(idleGuard).toContain('writeSharedActivity(now)');
  });

  test('ending a session clears the shared clock', () => {
    // Otherwise the next session inherits the previous session's stamp.
    expect(gateStore).toContain('clearSharedActivity()');
  });
});
