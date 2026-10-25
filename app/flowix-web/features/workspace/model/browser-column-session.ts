import type { BrowserColumnTarget } from './browser-column-target';

export interface BrowserColumnEntry {
  id: string;
  title: string;
  icon: string | null;
  target: BrowserColumnTarget;
}

export interface BrowserColumnSessionState {
  visible: boolean;
  splitRatio: number;
  current: BrowserColumnEntry | null;
  backStack: BrowserColumnEntry[];
  forwardStack: BrowserColumnEntry[];
}
