import { CreatedDocumentNoticeHost } from '../created-document-notice-host';
import { lazy, Suspense, useEffect } from 'react';
import { useMainWindowBusinessController } from './use-main-window-business-controller';
import { useMainWindowSystemController } from './use-main-window-system-controller';
import { ensureFileDisplayTrackingStarted } from '@features/workspace/public/app-api';
import { StartupEntryScreen } from '../startup-screen';
import { notifyWorkbenchMounted } from '@/lib/workbench-mount';

// Initialize before the first persisted surface is rendered.
if (typeof window !== 'undefined') ensureFileDisplayTrackingStarted();

const MainLayout = lazy(() =>
  import('@features/shell').then((module) => ({ default: module.MainLayout })),
);

export function MainWindow() {
  const business = useMainWindowBusinessController();
  const system = useMainWindowSystemController();
  return (
    <Suspense fallback={<StartupEntryScreen />}>
      <MainLayout business={business} system={system} />
      <WorkbenchMountedSignal />
      <CreatedDocumentNoticeHost />
    </Suspense>
  );
}

function WorkbenchMountedSignal() {
  useEffect(() => notifyWorkbenchMounted(), []);
  return null;
}
