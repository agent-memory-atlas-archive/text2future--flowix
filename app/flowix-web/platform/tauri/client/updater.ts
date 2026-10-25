import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface AppUpdate {
  currentVersion: string;
  version: string;
  notify: boolean;
  date?: string;
  body?: string;
}

export interface AppUpdateInstallResult {
  status: 'success' | 'failed';
  message?: string;
}

export type AppUpdateDownloadProgress =
  | { phase: 'started'; contentLength?: number }
  | { phase: 'progress'; downloadedBytes: number; contentLength?: number }
  | { phase: 'finished'; downloadedBytes: number }
  | { phase: 'installing'; downloadedBytes: number; contentLength?: number };

let checkPromise: Promise<AppUpdate | null> | null = null;
let installPromise: Promise<void> | null = null;
let installingVersion: string | null = null;
let activeCommand: string | null = null;
let latestProgress: AppUpdateDownloadProgress | null = null;
const progressListeners = new Set<(progress: AppUpdateDownloadProgress) => void>();

function isTauriDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/**
 * Check the trusted HTTPS latest.json manifest configured for the platform.
 * Non-desktop callers deliberately return null instead of trying to call the
 * desktop updater plugin.
 */
export async function checkAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauriDesktopRuntime()) return null;
  if (installPromise) throw new Error('An application update is currently being installed.');
  if (checkPromise) return checkPromise;

  const pending = (async () => {
    const update = await invoke<AppUpdate | null>('check_app_update');
    if (!update) return null;

    return {
      currentVersion: update.currentVersion,
      version: update.version,
      notify: update.notify !== false,
      date: update.date,
      body: update.body,
    };
  })();
  checkPromise = pending;
  try {
    return await pending;
  } finally {
    if (checkPromise === pending) checkPromise = null;
  }
}

export async function consumeAppUpdateResult(): Promise<AppUpdateInstallResult | null> {
  if (!isTauriDesktopRuntime()) return null;
  return await invoke<AppUpdateInstallResult | null>('consume_app_update_result');
}

export function downloadAppUpdate(
  version: string,
  onProgress?: (progress: AppUpdateDownloadProgress) => void,
): Promise<void> {
  return runPackageOperation('download_app_update', version, onProgress);
}

export function installAppUpdate(
  version: string,
  onProgress?: (progress: AppUpdateDownloadProgress) => void,
): Promise<void> {
  return runPackageOperation('install_app_update', version, onProgress);
}

async function runPackageOperation(
  command: 'download_app_update' | 'install_app_update',
  version: string,
  onProgress?: (progress: AppUpdateDownloadProgress) => void,
): Promise<void> {
  if (installPromise) {
    if (version !== installingVersion || command !== activeCommand) throw new Error('A different application update is currently being installed.');
    if (onProgress) {
      progressListeners.add(onProgress);
      if (latestProgress) onProgress(latestProgress);
    }
    try { await installPromise; }
    finally { if (onProgress) progressListeners.delete(onProgress); }
    return;
  }
  if (checkPromise) throw new Error('An application update check is currently in progress.');
  installingVersion = version;
  activeCommand = command;
  latestProgress = null;
  if (onProgress) progressListeners.add(onProgress);

  const pending = (async () => {
    const unlisten = await listen<AppUpdateDownloadProgress>('app-update-progress', (event) => {
      latestProgress = event.payload;
      for (const listener of progressListeners) listener(event.payload);
    });
    try {
      await invoke(command, { version });
      if (command === 'install_app_update') await relaunch();
    } finally {
      await unlisten();
    }
  })();
  installPromise = pending;
  try {
    await pending;
  } finally {
    if (installPromise === pending) {
      installPromise = null;
      installingVersion = null;
      activeCommand = null;
      latestProgress = null;
      progressListeners.clear();
    }
  }
}

export async function cancelAppUpdate(): Promise<boolean> {
  return await invoke<boolean>('cancel_app_update');
}

export { relaunch };
