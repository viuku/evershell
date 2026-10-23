import { createContext, useContext } from 'react';
import type { RemoteEdit } from '../../core/remote-edit';

/** 主窗口里管远程编辑的那个对象，文件区双击文件时用 */
export const RemoteEditContext = createContext<RemoteEdit | null>(null);

export function useRemoteEdit(): RemoteEdit | null {
  return useContext(RemoteEditContext);
}
