import { describe, expect, it } from 'vitest';
import type { WorkColumnNavigationState, WorkColumnTarget } from '@features/workspace/store/work-column-target';
import { resolveWorkColumnPresentation } from './presentation';

function navigation(target: WorkColumnTarget): WorkColumnNavigationState {
  return {
    phase: 'committed',
    showWorkColumnLoading: false,
    requestId: 1,
    target,
    pendingTarget: null,
    previousTarget: null,
    failure: null,
    retryToken: null,
  };
}

describe('work column presentation', () => {
  it('gives indexed notebook Markdown note actions while external Markdown stays a file', () => {
    const path = '/notebook/note.md';
    const fileIdentity = { path, displayId: 'display:path-note' };
    const present = (indexable: boolean) => resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'external', path, scopePath: '/notebook', transitionId: null }),
      document: {
        identity: { kind: 'external', fileIdentity, scopePath: '/notebook', indexable, transitionId: null },
        instanceKey: fileIdentity.displayId,
        documentProps: {
          isExternalDocument: true,
          externalScopePath: '/notebook',
          transitionId: null,
        },
      },
      emptyMessage: 'Select a note',
    });
    expect(present(true).capabilities).toContain('memo-colors');
    expect(present(true).capabilities).toContain('version-history');
    expect(present(false).capabilities).not.toContain('memo-colors');
  });

  it('derives document header data and capabilities from the resolved surface', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({
        kind: 'external',
        path: '/notebook/note.md',
        scopePath: '/notebook',
        transitionId: null,
      }),
      document: {
        identity: {
          kind: 'external',
          fileIdentity: { path: '/notebook/note.md', displayId: 'display:note' },
          scopePath: '/notebook',
          indexable: true,
          transitionId: null,
        },
        instanceKey: 'display:note',
        documentProps: {
          isExternalDocument: true,
          externalScopePath: '/notebook',
          transitionId: null,
        },
      },
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({
      kind: 'document',
      document: {
        externalFilePath: '/notebook/note.md',
      },
    });
    expect(presentation.content).toMatchObject({ status: 'surface', surface: { kind: 'md' } });
    expect(presentation.capabilities).toContain('edit');
  });

  it('preserves the empty reason and uses the document header for the empty surface', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'empty' }),
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({
      kind: 'document',
      document: { externalFilePath: null },
    });
    expect(presentation.content).toEqual({
      status: 'empty',
      reason: 'no-target',
      message: 'Select a note',
      tone: 'document',
    });
  });

  it('selects the agent header from the surface definition', () => {
    const presentation = resolveWorkColumnPresentation({
      navigation: navigation({ kind: 'agent-conversation', instanceId: 'agent-1' }),
      emptyMessage: 'Select a note',
    });

    expect(presentation.header).toEqual({ kind: 'agent', instanceId: 'agent-1' });
    expect(presentation.capabilities).toEqual(['stream-conversation']);
  });
});
