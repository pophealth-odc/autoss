import { describe, expect, it } from 'vitest';
import type { AutomationStatus } from '../api/contract';
import { isStaleStatus } from './app-context';

function status(patch: Partial<AutomationStatus> = {}): AutomationStatus {
  return {
    state: 'running', active: true, runId: 'run-a', startedAt: '2026-10-28T08:00:00.000Z', finishedAt: null, message: 'Running.', settings: null,
    total: 3, completed: 0, succeeded: 0, failed: 0, percent: 0, currentUrl: null, currentStep: null, discovering: false, failures: [], browserVersion: null,
    ...patch,
  };
}

describe('isStaleStatus: a late response must never overwrite newer information', () => {
  it('nothing known yet: accept anything', () => {
    expect(isStaleStatus(null, status())).toBe(false);
  });

  it('the response to Start arrives first: accepted, and the first event after it simply replaces it', () => {
    expect(isStaleStatus(status({ state: 'idle', active: false, runId: null }), status({ state: 'running' }))).toBe(false);
    expect(isStaleStatus(status({ state: 'starting', completed: 0 }), status({ state: 'running', completed: 1, succeeded: 1 }))).toBe(false);
  });

  it('the stream already delivered progress: a response with less progress is stale', () => {
    const current = status({ completed: 2, succeeded: 2, percent: 66 });
    expect(isStaleStatus(current, status({ completed: 0 }))).toBe(true);
    expect(isStaleStatus(current, status({ completed: 2, succeeded: 1 }))).toBe(true);
    expect(isStaleStatus(current, status({ completed: 2, succeeded: 2, failed: 0 }))).toBe(false); // same progress is fine
  });

  it('a failure count that has already gone up is not rolled back', () => {
    expect(isStaleStatus(status({ completed: 1, failed: 1 }), status({ completed: 1, failed: 0 }))).toBe(true);
  });

  it('a finished run is never brought back to "running" by a late response', () => {
    const finished = status({ state: 'completed', active: false, completed: 3, succeeded: 3 });
    expect(isStaleStatus(finished, status({ state: 'running', active: true, completed: 3, succeeded: 3 }))).toBe(true);
  });

  it('a different run id is a new run: it replaces the old one even though its counts are lower', () => {
    const old = status({ runId: 'run-a', state: 'completed', active: false, completed: 5, succeeded: 5 });
    expect(isStaleStatus(old, status({ runId: 'run-b', state: 'starting', completed: 0 }))).toBe(false);
  });

  it('a status without a run id (idle) cannot be judged stale', () => {
    expect(isStaleStatus(status({ completed: 3 }), status({ runId: null, state: 'idle', active: false }))).toBe(false);
    expect(isStaleStatus(status({ runId: null, state: 'idle', active: false }), status({ completed: 0 }))).toBe(false);
  });
});
