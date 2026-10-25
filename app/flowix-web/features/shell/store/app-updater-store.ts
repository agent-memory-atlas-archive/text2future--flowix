import { create } from 'zustand';
import {
  checkAppUpdate, downloadAppUpdate, installAppUpdate, cancelAppUpdate,
  type AppUpdate, type AppUpdateDownloadProgress,
} from '@platform/tauri/client/updater';

export type AppUpdaterStatus = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

export interface AppUpdaterState {
  status: AppUpdaterStatus;
  update: AppUpdate | null;
  progress: AppUpdateDownloadProgress | null;
  error: unknown;
  checkNow: () => Promise<AppUpdate | null>;
  downloadNow: () => Promise<void>;
  installNow: () => Promise<void>;
  cancelNow: () => Promise<void>;
}

let checkPromise: Promise<AppUpdate | null> | null = null;
let installPromise: Promise<void> | null = null;

function isCancellationError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes('cancelled');
}

// All update entry points in this window observe the same operation, including
// preferences reopened while a download or installation is already running.
export const useAppUpdaterStore = create<AppUpdaterState & { checkStarted: boolean }>((set, get) => ({
  status: 'idle', update: null, progress: null, error: null, checkStarted: false,
  checkNow: () => {
    if (checkPromise) return checkPromise;
    if (installPromise) return Promise.reject(new Error('An application update is currently being installed.'));
    const previous = get();
    set({ checkStarted: true, status: 'checking', error: null, progress: null });
    const pending = Promise.resolve().then(checkAppUpdate).then((update) => {
      set({ update, status: update ? (previous.status === 'ready' && previous.update?.version === update.version ? 'ready' : 'available') : 'none' });
      return update;
    }).catch((error: unknown) => {
      set({ update: previous.update, status: previous.update ? previous.status : 'error', error });
      throw error;
    }).finally(() => { if (checkPromise === pending) checkPromise = null; });
    checkPromise = pending;
    return pending;
  },
  downloadNow: () => {
    if (installPromise) return installPromise;
    if (checkPromise) return Promise.reject(new Error('An application update check is currently in progress.'));
    const update = get().update;
    if (!update || get().status === 'ready') return Promise.resolve();
    set({ status: 'downloading', error: null, progress: null });
    const pending = Promise.resolve().then(() => downloadAppUpdate(update.version, (progress) => {
      set({ progress });
    })).then(() => {
      set({ status: 'ready', progress: null });
    }).catch((error: unknown) => {
      set({ status: 'available', progress: null, error: isCancellationError(error) ? null : error });
      throw error;
    }).finally(() => { if (installPromise === pending) installPromise = null; });
    installPromise = pending;
    return pending;
  },
  installNow: () => {
    if (installPromise) return installPromise;
    if (checkPromise) return Promise.reject(new Error('An application update check is currently in progress.'));
    const update = get().update;
    if (!update) return Promise.resolve();
    const prepared = get().status === 'ready';
    set({ status: prepared ? 'installing' : 'downloading', error: null, progress: null });
    const pending = Promise.resolve().then(() => installAppUpdate(update.version, (progress) => {
      set({ progress, status: progress.phase === 'installing' ? 'installing' : 'downloading' });
    })).catch((error: unknown) => {
      set({ status: prepared ? 'ready' : 'available', progress: null, error: isCancellationError(error) ? null : error });
      throw error;
    }).finally(() => { if (installPromise === pending) installPromise = null; });
    installPromise = pending;
    return pending;
  },
  cancelNow: async () => {
    const pending = installPromise;
    if (!pending || !await cancelAppUpdate()) return;
    // Native cancellation is asynchronous. Keep the controls busy until the
    // install command settles and releases its operation lock.
    try { await pending; }
    catch (error) { if (!isCancellationError(error)) throw error; }
  },
}));
