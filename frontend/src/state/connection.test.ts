import { describe, expect, it } from 'vitest';
import { isSignInRequired } from './connection';

describe('telling the sign-in wall from a wrong pairing token', () => {
  it('recognises the wall by its error code', () => {
    expect(isSignInRequired({ code: 'sign_in_required' })).toBe(true);
  });

  it('leaves the service\'s own refusals about the pairing token alone', () => {
    expect(isSignInRequired({ code: 'unauthorized' })).toBe(false);
    expect(isSignInRequired({ code: 'forbidden' })).toBe(false);
    expect(isSignInRequired({ code: 'rate_limited' })).toBe(false);
    expect(isSignInRequired({ code: 'unknown' })).toBe(false);
  });

  it('does not depend on what the message says', () => {
    // A proxy that happens to use the same words in its own 401 must not be taken for the sign-in wall.
    expect(isSignInRequired({ code: 'unauthorized', message: 'Sign in with the access password first.' } as { code: string })).toBe(false);
  });
});
