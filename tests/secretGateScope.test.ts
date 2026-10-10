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
function actionBody(name: string, endMarker: string): string {
  // lastIndexOf: the state interface declares `name: (...) => ...;` earlier in
  // the file; the implementation is always the final occurrence.
  const start = gateStore.lastIndexOf(`${name}: `);
  expect(start).toBeGreaterThan(-1);
  const rest = gateStore.slice(start);
  const end = rest.indexOf(endMarker);
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
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
});

describe('verified state lives as long as the CPA session, not a page load', () => {
  test('a successful verify records a session marker', () => {
    const body = actionBody('verifyAndUnlock', 'skip:');
    expect(body).toContain('markSessionVerified()');
  });

  test('logging out clears the marker, so the next login re-verifies', () => {
    const body = actionBody('reset', 'setIdleTimeout:');
    expect(body).toContain('clearSessionVerified()');
  });

  test('the marker is session-scoped and never stores the passphrase', () => {
    // sessionStorage: survives F5 in the tab, dies with the tab. Storing the
    // passphrase itself would turn a UI convenience into a credential store.
    expect(gateStore).toContain('window.sessionStorage.setItem');
    expect(gateStore).toContain("const SESSION_VERIFIED_KEY = 'cpa.secret-gate.verified'");
    expect(gateStore).toContain("setItem(SESSION_VERIFIED_KEY, '1')");
  });

  test('reload resumes verified only when the backend is still unlocked', () => {
    // The marker alone must never grant access: the backend is the authority.
    const probe = gateModal.slice(gateModal.indexOf('isSessionVerified()'));
    expect(probe).toContain('isSessionVerified()');
    expect(probe).toContain('status.unlocked');
  });

  test('a skipped session is not marked verified', () => {
    expect(actionBody('skip', 'touch:')).not.toContain('markSessionVerified');
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
    const start = authStore.lastIndexOf(`${name}: `);
    expect(start).toBeGreaterThan(-1);
    const rest = authStore.slice(start);
    const end = rest.indexOf(endMarker);
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  test('logout locks the backend store with the own session key', () => {
    // Logging out IS "clear the session". If the front end only forgot the
    // session while the backend stayed unlocked, logging out and back in would
    // hand anyone with the management key the credentials with no master
    // password — the marker would be decoration.
    const body = authActionBody('logout', 'checkAuth:');
    expect(body).toContain('lockStore()');
    expect(body).toContain('reset()');
  });

  test('the lock is issued before the credential is cleared', () => {
    // /secrets/lock is authenticated: calling it after clearing the management
    // key returns 401 "missing management key" (verified against the running
    // backend). So the request must be captured first; cleanup follows inside
    // its `.then` callback.
    const body = authActionBody('logout', 'checkAuth:');
    const lockAt = body.indexOf('lockStore()');
    const clearAt = body.indexOf("apiClient.setConfig({ apiBase: '', managementKey: '' })");
    expect(lockAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(lockAt);
  });

  test('both logout paths lock the store through logout()', () => {
    // Idle timeout must not lock on its own path: the guard cancels its timer
    // when it logs out, so a lock issued after logout() would never fire.
    // One lock, inside logout(), covers idle timeout and manual logout alike.
    expect(idleGuard).not.toContain('lockStore()');
    expect(idleGuard).toContain('logout()');
  });
});
