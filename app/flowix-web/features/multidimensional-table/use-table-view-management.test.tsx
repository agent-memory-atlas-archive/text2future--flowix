import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { addTableView, createTableDocument } from './model';
import { useTableViewManagement } from './use-table-view-management';
import { toast } from '@/lib/toast';
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

it('rejects duplicate view names and keeps active selection when deletion fails', async () => {
  const original = createTableDocument();
  const added = addTableView(original, 'gallery');
  const session = { document: added.document, saving: false, loadSequenceRef: { current: 1 }, isCurrentSession: () => true };
  const save = vi.fn().mockResolvedValue(false);
  const activate = vi.fn();
  let controller!: ReturnType<typeof useTableViewManagement>;
  function Probe() {
    controller = useTableViewManagement({ session, save, editable: true, canDeleteViews: true, activeViewId: added.view.id, activateView: activate });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => controller.renameView(added.view, original.views.items[0].name));
    expect(toast.error).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await act(async () => controller.requestDeleteView(added.view));
    await act(async () => controller.confirmDeleteView());
    expect(save).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
    save.mockResolvedValue(true);
    await act(async () => controller.requestDeleteView(added.view));
    await act(async () => controller.confirmDeleteView());
    expect(activate).toHaveBeenCalledWith(original.views.items[0].id);
  } finally { await act(async () => root.unmount()); }
});

it.each(['cancel', 'blur-first', 'close-first'] as const)('handles %s without duplicate rename submissions', async (order) => {
  const original = createTableDocument();
  const added = addTableView(original, 'gallery');
  const session = { document: added.document, saving: false, loadSequenceRef: { current: 1 }, isCurrentSession: () => true };
  const save = vi.fn().mockResolvedValue(true);
  let controller!: ReturnType<typeof useTableViewManagement>;
  function Probe() {
    controller = useTableViewManagement({ session, save, editable: true, canDeleteViews: true, activeViewId: added.view.id, activateView: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => controller.beginManageViewRename(added.view));
    await act(async () => controller.setManagingViewName('Renamed gallery'));
    await act(async () => {
      if (order === 'cancel') {
        controller.cancelManageViewRename();
        await controller.finishManageViewRename(added.view, 'Renamed gallery');
        await controller.closeViewManagement();
      } else if (order === 'blur-first') {
        await controller.finishManageViewRename(added.view, 'Renamed gallery');
        await controller.closeViewManagement();
      } else {
        await controller.closeViewManagement();
        await controller.finishManageViewRename(added.view, 'Renamed gallery');
      }
    });
    expect(controller.managingViewId).toBeNull();
    expect(controller.managingViewName).toBe('');
    if (order === 'cancel') expect(save).not.toHaveBeenCalled();
    else {
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0][0].views.items.find((view: { id: string }) => view.id === added.view.id).name).toBe('Renamed gallery');
    }
    await act(async () => controller.requestDeleteView(added.view));
    await act(async () => controller.cancelDeleteView());
    expect(controller.viewPendingDelete).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
