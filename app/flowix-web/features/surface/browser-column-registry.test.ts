import { describe, expect, it } from 'vitest';
import { browserColumnSurfaceRegistry } from './browser-column-registry';

describe('browserColumnSurfaceRegistry', () => {
  it('assigns semantic chrome to conversation and media surfaces', () => {
    expect(browserColumnSurfaceRegistry['agent-conversation'].chrome).toBe('agent');
    expect(browserColumnSurfaceRegistry.media.chrome).toBe('media');
    expect(browserColumnSurfaceRegistry['file-browser'].chrome).toBe('document');
    expect(browserColumnSurfaceRegistry.web.chrome).toBe('document');
  });
});
