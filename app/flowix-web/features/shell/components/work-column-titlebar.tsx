import { isMac } from '@features/shortcuts';
import { WorkColumnTitlebarShell, type WorkColumnTitlebarShellProps } from './work-column-titlebar-shell';
import { WorkspaceColumnContextMenu } from './workspace-column-context-menu';

/** Main work-column menu coordinates host actions around the visual frame. */
export function WorkColumnTitlebar(props: WorkColumnTitlebarShellProps) {
  return (
    <WorkspaceColumnContextMenu isWindows={props.isWindows}>
      <WorkColumnTitlebarShell {...props}
        showTrafficLightSpacer={isMac() && props.showTrafficLightSpacer} />
    </WorkspaceColumnContextMenu>
  );
}
