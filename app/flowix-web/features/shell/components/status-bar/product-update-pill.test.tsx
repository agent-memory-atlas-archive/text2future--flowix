import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ProductUpdatePill } from './product-update-pill';
import type { AppUpdaterState } from '../../store/app-updater-store';
vi.mock('@/lib/toast', () => ({toast:{error:vi.fn()}}));
vi.mock('@phosphor-icons/react', () => ({ArrowCircleUpIcon: () => null}));
vi.mock('@/lib/i18n', () => ({useI18n: () => ({t: (key: string) => key})}));
vi.mock('@shared/ui/tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
it('keeps discovery and download silent, and only offers installation when ready', async () => {
  const element=document.createElement('div');
  const root=createRoot(element);
  const updater: AppUpdaterState = {
    status:'available',update:{currentVersion:'1.0.0',version:'1.1.0',notify:true},
    progress:null,error:null,checkNow:vi.fn(),downloadNow:vi.fn(),installNow:vi.fn().mockResolvedValue(undefined),cancelNow:vi.fn(),
  };
  try {
    for (const status of ['available','downloading'] as const) {
      await act(async () => root.render(<ProductUpdatePill updater={{...updater,status}} />));
      expect(element.querySelector('button')).toBeNull();
    }
    await act(async () => root.render(<ProductUpdatePill updater={{...updater,status:'ready'}} />));
    expect(element.querySelector('button')).not.toBeNull();
    await act(async () => element.querySelector('button')!.click());
    expect(updater.installNow).toHaveBeenCalledTimes(1);
    expect(updater.downloadNow).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
