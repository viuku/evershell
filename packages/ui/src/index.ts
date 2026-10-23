import { lazy } from 'react';
export { HostKeyError } from './types';
export type {
  AuthConfig,
  ConnectOptions,
  EditorWindowHost,
  FileEntry,
  HostKeyInfo,
  HostKeyProblem,
  KnownHostEntry,
  ManagerWindowHost,
  MonitorDetail,
  MonitorSnapshot,
  SecretStore,
  ShellHandlers,
  SshBackend,
  SshSession,
  StorageSync,
  SystemInfo,
  TransferProgress,
  WindowLink,
} from './types';
export { App, type AppProps } from './App';
export type { EditorAppProps } from './components/editor/EditorApp';
/** 桌面端独立编辑窗口的界面，按需加载 */
export const EditorApp = lazy(() => import('./components/editor/EditorApp'));
export type { ManagerAppProps } from './components/manager/ManagerApp';
/** 桌面端独立连接管理器窗口的界面，按需加载 */
export const ManagerApp = lazy(() => import('./components/manager/ManagerApp'));
export { connectStorageSync } from './core/storage';
export { createMockBackend } from './mock/mock-backend';
export { browserDownload } from './core/browser-download';
export { isMac } from './core/platform';
export { Modal } from './components/common/Modal';
export type { MenuItem } from './components/common/Menu';
