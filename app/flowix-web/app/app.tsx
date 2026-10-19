'use client';

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CenteredLoadingSpinner } from "@shared/ui/centered-loading-spinner";
import { useWorkspaceStartupStore, applyNativeStartupStatus } from "@/lib/store/workspace-startup-store";
import { ErrorBoundary } from "@shared/error-boundary";
import { Toaster, toast } from "sonner";
import { useAppPreferencesViewModel } from "@features/preferences/public/app-api";
import { useAppAgentRuntimeViewModel } from "@features/agent/public/app-api";
import { useApplyFontSettings } from "@features/preferences/public/app-api";
import { ThemeProvider } from "@features/theme";
import { NativeEditMenuBridge, ShortcutsProvider } from "@features/shortcuts";
import { I18nProvider, useI18n, type I18nKey } from "@/lib/i18n";
import { TooltipProvider } from "@shared/ui/tooltip";
import "@features/shortcuts/actions";
import { boot, listenToUserConfigChanges, windows } from "@platform/tauri/client";
import { syncUserConfigChange } from "./user-config-sync";
import { useAgentWorkspaceWindowLifecycle } from "./use-agent-workspace-window-lifecycle";
import { invalidateDshModelConfigs } from "@features/agent/public/app-api";
import { createLogger } from "@/lib/logger";
import { ActionableNoticeHost } from "@features/notifications/actionable-notice-host";
import { NotebookSetupNoticeHost } from "@features/memo/components/notebook-setup-notice-host";
import { NotebookSetupCoordinator } from "@features/memo/components/notebook-setup-coordinator";
import { useAgentPersistenceError } from "@features/agent/public/app-api";
import { translate, type AppLanguage } from "@/lib/i18n";

const DocumentSaveNotifications = lazy(() => import('@features/document/public/app-api')
  .then(module => ({ default: module.DocumentSaveNotifications })));

const logger = createLogger("app");

function removeAppLoading() {
  document.getElementById("app-loading")?.remove();
}

const MainWindow = lazy(() =>
  import("./main-window/main-window")
    .then((module) => ({ default: module.MainWindow }))
    .catch((error) => {
      // A packaged Tauri WebView can fail to resolve a lazy chunk while the
      // root document itself has already loaded. Do not leave the static
      // startup spinner covering the error boundary forever in that case.
      removeAppLoading();
      throw error;
    })
);

const PreferencesView = lazy(() =>
  import("@features/preferences").then((module) => ({ default: module.PreferencesView }))
);

const MainWindowEffects = lazy(() =>
  import("./main-window-effects").then((module) => ({ default: module.MainWindowEffects }))
);

const AgentWindowEffects = lazy(() =>
  import("./agent-window-effects").then((module) => ({ default: module.AgentWindowEffects }))
);

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

const startupProgressLabels: Record<string, I18nKey> = {
  prepareDatabasePaths: 'startup.progress.prepareDatabasePaths',
  prepareThreadDatabase: 'startup.progress.prepareThreadDatabase',
  prepareSyncDatabase: 'startup.progress.prepareSyncDatabase',
  prepareNotebookRegistry: 'startup.progress.prepareNotebookRegistry',
  runMigrations: 'startup.progress.runMigrations',
  config_dsh_layout_v2: 'startup.progress.migrateAgentLayout',
  config_local_migrations_v1: 'startup.progress.migrateLocalConfiguration',
  config_watcher_exclusions_v1: 'startup.progress.migrateWatcherSettings',
  templates_v1: 'startup.progress.prepareTemplates',
  prepareRuntimeStorage: 'startup.progress.prepareRuntimeStorage',
  activateRuntime: 'startup.progress.activateRuntime',
  completeInitialization: 'startup.progress.completeInitialization',
};

function startupProgressLabel(task: string): I18nKey {
  if (task.startsWith('deferred:')) return 'startup.progress.deferredNotebookJobs';
  if (task.includes(':notebook:')) return 'startup.progress.migrateNotebookStorage';
  return startupProgressLabels[task] ?? 'startup.progress.runMigrations';
}

function StartupLoadingOverlay() {
  const nativePhase = useWorkspaceStartupStore((state) => state.nativePhase);
  const nativeStage = useWorkspaceStartupStore((state) => state.nativeStage);
  const nativeStep = useWorkspaceStartupStore((state) => state.nativeStep);
  const nativeProgress = useWorkspaceStartupStore((state) => state.nativeProgress);
  const workspaceStatus = useWorkspaceStartupStore((state) => state.status);
  const workbenchMounted = useWorkspaceStartupStore((state) => state.workbenchMounted);
  const { t } = useI18n();
  const visible = nativePhase === 'pending' || nativePhase === 'running'
    || (nativePhase === 'ready' && (
      workspaceStatus === 'idle'
      || workspaceStatus === 'running'
      || (workspaceStatus === 'ready' && !workbenchMounted)
    ));
  if (!visible) return null;
  return (
    <div data-window-material-overlay className="fixed inset-0 z-[2147483646] flex items-center justify-center bg-[var(--frame-bg)]">
      {nativePhase === 'running' && nativeStage === 'initialization' && nativeProgress ? (
        <div className="flex w-72 flex-col items-center gap-3 text-sm text-[var(--muted-foreground)]">
          <CenteredLoadingSpinner label={t('memo.navigation.preparingVersion')} />
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]" role="progressbar"
            aria-label={t('memo.navigation.preparingVersion')}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={nativeProgress.percent}>
            <div className="h-full rounded-full bg-[var(--brand)] transition-[width] duration-300 ease-out"
              style={{ width: `${nativeProgress.percent}%` }} />
          </div>
          <span className="text-xs">
            {t(startupProgressLabel(nativeProgress.task))}
            {(!['prepareDatabasePaths', 'prepareThreadDatabase', 'prepareSyncDatabase', 'prepareNotebookRegistry',
              'prepareRuntimeStorage', 'activateRuntime', 'completeInitialization'].includes(nativeProgress.task))
              ? ` (${nativeProgress.completed}/${nativeProgress.total})`
              : ''}
          </span>
        </div>
      ) : (
        <CenteredLoadingSpinner
          label={nativePhase === 'running'
            && nativeStage === 'initialization'
            && nativeStep === 'versionInitialization'
            ? t('memo.navigation.preparingVersion')
            : undefined}
        />
      )}
    </div>
  );
}

function AppToaster({ language }: { language: AppLanguage }) {
  const persistenceError = useAgentPersistenceError();
  const lastPersistenceError = useRef<string | null>(null);

  useEffect(() => {
    if (!persistenceError) {
      lastPersistenceError.current = null;
      return;
    }
    if (lastPersistenceError.current === persistenceError) return;
    lastPersistenceError.current = persistenceError;
    toast.error(translate(language, "preferences.agents.cacheWriteFailed"));
  }, [language, persistenceError]);

  return (
    <>
    <Toaster
      className="flowix-toaster"
      position="top-center"
      richColors={false}
      closeButton={false}
    />
    <Suspense fallback={null}><DocumentSaveNotifications /></Suspense>
    <NotebookSetupCoordinator />
    <NotebookSetupNoticeHost />
    <ActionableNoticeHost />
    </>
  );
}

function AppReadySignal() {
  useEffect(() => {
    removeAppLoading();
  }, []);

  return null;
}

function MainWindowReadySignal() {
  useEffect(() => {
    removeAppLoading();
    void windows.showMain().catch((error) => {
      logger.error("show main window failed", { error });
    });
  }, []);

  return null;
}

function useUnexpectedControlInputGuard() {
  useEffect(() => {
    const controlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
    const handleBeforeInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (inputEvent.isComposing) return;
      if (
        inputEvent.inputType !== "insertText" &&
        inputEvent.inputType !== "insertReplacementText"
      ) return;

      const data = inputEvent.data;
      if (!data || !controlCharacters.test(data)) return;

      // macOS WebKit can turn ArrowRight into an insertText event containing
      // U+001D. Block accidental ASCII control text across native fields and
      // contenteditable surfaces while leaving IME composition untouched.
      inputEvent.preventDefault();
    };

    document.addEventListener("beforeinput", handleBeforeInput, true);
    return () => document.removeEventListener("beforeinput", handleBeforeInput, true);
  }, []);
}

function App() {
  useUnexpectedControlInputGuard();
  const [hash, setHash] = useState(() => window.location.hash);
  useAgentWorkspaceWindowLifecycle({ deferUntilStage3: !hash.startsWith('#preferences') });
  const {
    language,
    format,
    shortcutOverrides,
    loadInitial,
    flushPending,
  } = useAppPreferencesViewModel();
  const { refreshAgentRuntime } = useAppAgentRuntimeViewModel();
  useApplyFontSettings(format);

  useEffect(() => {
    const root = document.documentElement;
    if (!isTauriRuntime() || hash.startsWith('#preferences')) {
      delete root.dataset.windowMaterial;
      return;
    }

    let active = true;
    void windows.getWindowMaterial().then((material) => {
      if (!active) return;
      if (material === 'none') {
        delete root.dataset.windowMaterial;
      } else {
        root.dataset.windowMaterial = material;
      }
      try {
        if (material === 'none') localStorage.removeItem('flowix-window-material');
        else localStorage.setItem('flowix-window-material', material);
      } catch {
        // The live IPC result still applies when storage is unavailable.
      }
    }).catch((error) => {
      logger.error('get native window material failed', { error });
    });

    return () => {
      active = false;
      delete root.dataset.windowMaterial;
    };
  }, [hash]);

  useEffect(() => {
    const setNativeReady = () => useWorkspaceStartupStore.setState((state) => (
      state.nativePhase === 'ready'
        && state.nativeStage === 'workspacePreparation'
        && state.nativeStep === 'ready'
        && state.nativeError === null
        && state.nativeProgress === null
        ? state
        : { ...state, nativePhase: 'ready', nativeStage: 'workspacePreparation', nativeStep: 'ready', nativeError: null, nativeProgress: null }
    ));
    if (hash.startsWith("#preferences") || !isTauriRuntime()) {
      setNativeReady();
      return;
    }
    let active = true;
    const refresh = async () => {
      try {
        let status = await boot.getStartupStatus();
        while (active) {
          applyNativeStartupStatus(status);
          if (status.phase === 'ready' || status.phase === 'failed') break;
          status = await boot.waitForStartupStatusChange(status);
        }
      } catch {
        if (active) setNativeReady();
      }
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [hash]);

  useEffect(() => {
    const root = document.documentElement;
    const handleFocus = () => { root.dataset.windowFocused = "true"; };
    const handleBlur = () => { root.dataset.windowFocused = "false"; };
    root.dataset.windowFocused = String(document.hasFocus());
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      delete root.dataset.windowFocused;
    };
  }, []);

  useEffect(() => {
    void windows.applyMenuLanguage(language).catch((error) => {
      logger.error("apply native menu language failed", { error });
    });
  }, [language]);

  useEffect(() => {
    // The static loading screen is only a first-paint fallback. It must not
    // depend on a lazy route resolving: if a packaged chunk is unavailable,
    // ErrorBoundary should be visible instead of an endless spinner.
    removeAppLoading();

    const isAuxiliaryWindow = hash.startsWith("#preferences");
    if (!isAuxiliaryWindow) {
      void windows.showMain().catch((error) => {
        logger.error("show main window failed during app bootstrap", { error });
      });
    }
  }, [hash]);

  useEffect(() => {
    loadInitial();
    return () => {
      void flushPending();
    };
  }, [loadInitial, flushPending]);

  useEffect(() => {
    return listenToUserConfigChanges((kind) => {
      if (kind === "dsh_config") invalidateDshModelConfigs();
      syncUserConfigChange(kind, {
        reloadPreferences: loadInitial,
        refreshAgentRuntime: () => refreshAgentRuntime({ force: true }),
      });
    });
  }, [loadInitial, refreshAgentRuntime]);

  useEffect(() => {
    const handleHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const isPreferencesWindow = hash.startsWith("#preferences");

  if (isPreferencesWindow) {
    const tab = hash.split("/")[1] || undefined;
    return (
      <ErrorBoundary language={language}>
        <I18nProvider language={language}>
          <AppToaster language={language} />
          <ThemeProvider>
            <TooltipProvider>
              <ShortcutsProvider overrides={shortcutOverrides}>
              <NativeEditMenuBridge />
              <Suspense fallback={null}>
                <PreferencesView initialTab={tab} />
                <AppReadySignal />
              </Suspense>
              </ShortcutsProvider>
            </TooltipProvider>
          </ThemeProvider>
        </I18nProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary language={language}>
      <I18nProvider language={language}>
        <AppToaster language={language} />
        <ThemeProvider>
          <StartupLoadingOverlay />
          <Suspense fallback={null}>
            <AgentWindowEffects />
          </Suspense>
          <Suspense fallback={null}>
            <MainWindowEffects />
          </Suspense>
          <TooltipProvider>
            <ShortcutsProvider overrides={shortcutOverrides}>
              <NativeEditMenuBridge />
              {/* The root startup overlay stays mounted while this code loads. */}
              <Suspense fallback={null}>
                <MainWindow />
                <MainWindowReadySignal />
              </Suspense>
            </ShortcutsProvider>
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}

export default App;
