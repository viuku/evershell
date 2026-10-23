import { useSyncExternalStore } from 'react';
import { PersistentStore } from './storage';

export type AppearanceMode = 'system' | 'light' | 'dark';
export type Scheme = 'light' | 'dark';

const MODES: AppearanceMode[] = ['system', 'light', 'dark'];

/** 界面深浅色：跟随系统 / 浅色 / 深色 */
export const appearanceMode = new PersistentStore<AppearanceMode>('evershell.appearance-mode', 'system', (raw, fb) =>
  MODES.includes(raw as AppearanceMode) ? (raw as AppearanceMode) : fb,
);

export const sidebarOpen = new PersistentStore<boolean>('evershell.sidebar-open', true, (raw, fb) =>
  typeof raw === 'boolean' ? raw : fb,
);

export const closeManagerAfterConnect = new PersistentStore<boolean>('evershell.manager.close-after', true, (raw, fb) =>
  typeof raw === 'boolean' ? raw : fb,
);

export const followTerminalDir = new PersistentStore<boolean>('evershell.files.follow', true, (raw, fb) =>
  typeof raw === 'boolean' ? raw : fb,
);

/** 终端下面的底栏（文件 / 快捷命令 / 历史命令 / 传输）显示着没有，命令栏右边的箭头切换 */
export const bottomPanelOpen = new PersistentStore<boolean>('evershell.bottom-open', true, (raw, fb) =>
  typeof raw === 'boolean' ? raw : fb,
);

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function subscribeSystem(listener: () => void): () => void {
  darkQuery?.addEventListener('change', listener);
  return () => darkQuery?.removeEventListener('change', listener);
}

function getSystemScheme(): Scheme {
  return darkQuery?.matches ? 'dark' : 'light';
}

export function useSystemScheme(): Scheme {
  return useSyncExternalStore(subscribeSystem, getSystemScheme, getSystemScheme);
}

/** 当前实际生效的深浅色（“跟随系统”已解析） */
export function useEffectiveScheme(): Scheme {
  const mode = useSyncExternalStore(appearanceMode.subscribe, appearanceMode.get, appearanceMode.get);
  const system = useSystemScheme();
  return mode === 'system' ? system : mode;
}

export function appearanceClass(mode: AppearanceMode): string {
  return mode === 'light' ? 'ap-light' : mode === 'dark' ? 'ap-dark' : 'ap-auto';
}
