import { describe, expect, it } from 'vitest';

import { resolveActiveAgentConversationInstanceId } from './active-conversation-api';

describe('active agent conversation resolution', () => {
  it('follows the focused host when both surfaces show a conversation', () => {
    expect(resolveActiveAgentConversationInstanceId({
      focusedHostId: 'browser-column',
      workInstanceId: 'conversation-work',
      browserInstanceId: 'conversation-browser',
    })).toBe('conversation-browser');

    expect(resolveActiveAgentConversationInstanceId({
      focusedHostId: 'main-third',
      workInstanceId: 'conversation-work',
      browserInstanceId: 'conversation-browser',
    })).toBe('conversation-work');
  });

  it('falls back to the other surface when the focused one has no conversation', () => {
    expect(resolveActiveAgentConversationInstanceId({
      focusedHostId: 'browser-column',
      workInstanceId: 'conversation-work',
      browserInstanceId: null,
    })).toBe('conversation-work');

    expect(resolveActiveAgentConversationInstanceId({
      focusedHostId: 'main-third',
      workInstanceId: null,
      browserInstanceId: 'conversation-browser',
    })).toBe('conversation-browser');
  });

  it('reports nothing when neither surface shows a conversation', () => {
    expect(resolveActiveAgentConversationInstanceId({
      focusedHostId: 'main-third',
      workInstanceId: null,
      browserInstanceId: null,
    })).toBeNull();
  });
});
