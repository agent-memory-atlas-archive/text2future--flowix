'use client';

import type { ComponentPropsWithRef, CSSProperties, ReactNode } from 'react';

/** Shared titlebar fade used by the work column and browser column. */
export const WORK_COLUMN_TITLEBAR_GRADIENT =
  'var(--titlebar-gradient)';

export interface WorkColumnTitlebarShellProps extends ComponentPropsWithRef<'div'> {
  isWindows: boolean;
  reserveWindowsControls?: boolean;
  showTrafficLightSpacer?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Platform geometry only; host menus and commands belong to the container. */
export function WorkColumnTitlebarShell({
  isWindows,
  reserveWindowsControls = true,
  showTrafficLightSpacer = false,
  className = '',
  style,
  children,
  ...domProps
}: WorkColumnTitlebarShellProps) {
  return (
    <div {...domProps} data-tauri-drag-region
      className={`z-[50] flex shrink-0 select-none items-center pl-2 ${isWindows
        ? `h-9 ${reserveWindowsControls ? 'pr-[126px]' : 'pr-0'}` : 'h-12'} ${className}`}
      style={style}>
      {!isWindows && showTrafficLightSpacer && <div aria-hidden="true" className="h-full w-[88px] shrink-0" />}
      {children}
    </div>
  );
}
