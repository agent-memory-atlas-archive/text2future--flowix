import { createLogger } from '@/lib/logger';
import { invoke } from '@platform/tauri/core';
import { getCurrentWindow } from '@platform/tauri/window';
import { subscribe } from '@platform/tauri/event-bus';
import { isTauriDesktopRuntime } from '@platform/tauri/runtime';
import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';
import { toast } from '@/lib/toast';
import { flushAllDocumentSessions } from './document-session-service';

let installed: Promise<void> | null = null;
let preparing: Promise<boolean> | null = null;
function prepare(): Promise<boolean> {
  if (preparing) return preparing;
  preparing = (async () => {
    const ready = await flushAllDocumentSessions()
      && await invoke<boolean>('flush_document_background')
      && await flushAllDocumentSessions();
    if (!ready) toast.error(translate(getCurrentAppLanguage(), 'document.save.closeFailed'));
    return ready;
  })().catch(() => {
    toast.error(translate(getCurrentAppLanguage(), 'document.save.closeFailed'));
    return false;
  }).finally(() => { preparing = null; });
  return preparing;
}

/** Install once for the lifetime of a desktop window, including detached tabs. */
const persistenceLog = createLogger('document:shutdown');

export function installDocumentShutdown(): void {
  if (installed || !isTauriDesktopRuntime()) return;
  installed = (async () => {
    const window = getCurrentWindow();
    let closing = false;
    let exitRequest: number | null = null;
    await window.onCloseRequested(async event => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        if (await prepare()) { document.body.inert = true; await window.destroy(); }
      } catch { toast.error(translate(getCurrentAppLanguage(), 'document.save.closeFailed')); }
      finally { closing = false; document.body.inert = false; }
    });
    subscribe<number>('document:exit-cancelled', request => {
      if (exitRequest === request) { exitRequest = null; document.body.inert = false; }
    });
    subscribe<number>('document:prepare-exit', request => {
      exitRequest = request;
      void prepare().then(async ready => {
        if (exitRequest !== request) return;
        if (ready) document.body.inert = true;
        try { await invoke('finish_document_shutdown', { request, ready }); }
        catch { document.body.inert = false; }
      });
    }, { onListenerReady: () => { void invoke('register_document_window'); } });
  })().catch(error => {
    installed = null;
    persistenceLog.error('listener installation failed', { errorType: error instanceof Error ? error.name : typeof error });
  });
}
