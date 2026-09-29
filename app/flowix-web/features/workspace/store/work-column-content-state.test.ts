import { describe, expect, it } from 'vitest';

import type { WorkColumnNavigationState, WorkColumnTarget } from './work-column-target';
import { resolveWorkColumnContentState } from './work-column-content-state';

const emptyDocument = {
  activeExternalSession: null,
  activeAgentConversationId: null,
};

function navigation(
  target: WorkColumnTarget,
  overrides: Partial<WorkColumnNavigationState> = {},
): WorkColumnNavigationState {
  return {
    phase: target.kind === 'empty' ? 'idle' : 'committed',
    showWorkColumnLoading: false,
    requestId: 1,
    target,
    pendingTarget: null,
    previousTarget: null,
    failure: null,
    retryToken: null,
    ...overrides,
  };
}

const memoA: WorkColumnTarget = {
  kind: 'external',
  path: '/notes/a.md',
  scopePath: '/notes',
  transitionId: 1,
};

const memoB: WorkColumnTarget = { ...memoA, path: '/notes/b.md', transitionId: null };

const sessionA = {
  fileIdentity: { displayId: 'display-a', path: '/notes/a.md' },
  notebookId: null,
  notebookPath: null,
  scopePath: '/notes',
  openedAt: 1,
  transitionId: 1,
};

describe('work-column content state', () => {
  it('keeps the loaded A session while navigation to B is in progress', () => {
    const state = resolveWorkColumnContentState(
      navigation(memoA, { phase: 'loading', pendingTarget: memoB, previousTarget: memoA }),
      { ...emptyDocument, activeExternalSession: sessionA },
    );

    expect(state).toEqual({
      status: 'transitioning',
      from: memoA,
      to: memoB,
      session: { kind: 'external', session: sessionA },
    });
  });

  it('retains A as the active target and reports B after B fails', () => {
    const failure = {
      code: 'navigation-failed' as const,
      message: 'save refused',
      requestId: 2,
      retryToken: 'retry-b',
    };
    const state = resolveWorkColumnContentState(
      navigation(memoA, {
        phase: 'failed',
        requestId: 2,
        pendingTarget: memoB,
        previousTarget: memoA,
        failure,
        retryToken: 'retry-b',
      }),
      { ...emptyDocument, activeExternalSession: sessionA },
    );

    expect(state).toMatchObject({
      status: 'failed',
      target: memoA,
      attemptedTarget: memoB,
      session: { kind: 'external', session: sessionA },
      failure,
    });
  });

  it('returns ready only after the target and loaded session are committed', () => {
    expect(resolveWorkColumnContentState(
      navigation(memoA),
      { ...emptyDocument, activeExternalSession: sessionA },
    )).toEqual({
      status: 'ready',
      target: memoA,
      session: { kind: 'external', session: sessionA },
    });
  });
});
