'use client';

import { useEffect } from 'react';
import { useAgentEvents } from '@features/agent/hooks/use-agent-events';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
// Import the data modules directly. The `note-link` / `note-mention` /
// `tag-mention` barrels also re-export their TipTap Node views, which dragged
// ProseMirror into the desktop startup graph for two cache helpers.
import { invalidateNotebookCache, prewarmNotebookCache } from '@features/editor/extensions/note-link/memo-resolver';
import { invalidateMentionNotes } from '@features/editor/extensions/note-mention/note-mention-data';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention/tag-mention-data';
import { cloud, listenToAgentWorkspaceChanges } from '@platform/tauri/client';
import { refreshAgentModelCatalog } from '@features/agent/services/agent-catalog-service';
import { acquireMemoEventBridge } from '@/lib/memo-dispatcher';
import { runStartupStage3Task } from '@/lib/startup-stage3';
import { waitForWorkspaceRestoration } from './main-window-startup';

/**
 * Agent infrastructure shared by every content-capable Webview.
 *
 * Tauri content Webviews own their live Agent projection and backend hydration.
 * The browser column lives in the main Webview and therefore reuses this
 * infrastructure; preferences intentionally does not mount this component.
 */
export function AgentWindowEffects() {
  useAgentEvents(waitForWorkspaceRestoration);
  useEffect(() => acquireMemoEventBridge(), []);
  const refreshAgentRuntime = useAgentRuntimeStore((state) => state.refresh);
  useEffect(() => {
    void runStartupStage3Task('agent-runtime-status-refresh', () => {
      // The native status command owns the CLI-discovery dependency for every
      // consumer, including refreshes initiated by feature-specific views.
      return refreshAgentRuntime({ force: true });
    });
  }, [refreshAgentRuntime]);

  useEffect(() => {
    void runStartupStage3Task('pi-cloud-model-catalog-refresh', async () => {
      // Stage 3 releases low-priority work after the shell paints, while the
      // selected workspace may still be restoring its initial surface.
      await waitForWorkspaceRestoration();
      const connected = await cloud.refreshPiModelProviderAtStartup();
      if (connected) await refreshAgentModelCatalog('pi');
    });
  }, []);

  useEffect(() => {
    void runStartupStage3Task('agent-note-link-cache-prewarm', prewarmNotebookCache);
  }, []);

  useEffect(() => {
    return listenToAgentWorkspaceChanges(() => {
      invalidateNotebookCache();
      invalidateMentionNotes();
      invalidateMentionTags();
      void prewarmNotebookCache();
    });
  }, []);

  return null;
}
