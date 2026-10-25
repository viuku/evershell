// 底栏「命令」页的状态和发送逻辑：左边快捷命令、右边命令编辑器。界面在 components/panels/CommandsPanel.tsx。

import { PersistentStore } from './storage';
import { Store } from './store';

export type SendTarget = 'current' | 'all';

const isTarget = (raw: unknown): raw is SendTarget => raw === 'current' || raw === 'all';

/** 右边命令编辑器的宽度，拖中间的分隔条调 */
export const commandEditorWidth = new PersistentStore<number>('evershell.cmd-editor-width', 330, (raw, fb) =>
  typeof raw === 'number' && raw >= 160 && raw <= 2000 ? raw : fb,
);

/** 快捷命令发到哪：当前会话 / 全部会话 */
export const snippetSendTarget = new PersistentStore<SendTarget>('evershell.cmd-send-target', 'current', (raw, fb) =>
  isTarget(raw) ? raw : fb,
);

/** 命令编辑器发到哪，和快捷命令的分开记 */
export const editorSendTarget = new PersistentStore<SendTarget>('evershell.cmd-editor-target', 'current', (raw, fb) =>
  isTarget(raw) ? raw : fb,
);

/** 命令编辑器发送成功后清空 */
export const editorClearAfterSend = new PersistentStore<boolean>('evershell.cmd-editor-clear', true, (raw, fb) =>
  typeof raw === 'boolean' ? raw : fb,
);

/** 命令编辑器里的文字：只放内存，切页签、切会话都还在，重启不保留 */
export const commandEditorText = new Store<string>('');

/** 选中的分类名；null 表示第一个 */
export const selectedGroup = new Store<string | null>(null);

/** 最近发过的快捷命令，「发送」按钮重发它。不做高亮（所有者 2026-10-23 定：点过的不变色） */
export const lastSentSnippet = new Store<string | null>(null);

/**
 * 交给终端的文字：换行统一成回车（终端里回车才是“执行”），去掉首尾的空行。
 * 末尾的回车由 SessionManager.sendCommand / sendToAll 补，所以这里不带；不自动回车的命令就不补。
 */
export function toTerminalInput(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join('\r');
}

/** SessionManager 里发命令的两个方法，单独拿出来方便测试。enter 为 false 时末尾不按回车 */
export interface CommandSender {
  sendCommand(sessionId: string, cmd: string, enter?: boolean): boolean;
  sendToAll(cmd: string, enter?: boolean): number;
}

export interface SendResult {
  ok: boolean;
  /** 显示在命令页左下角的短提示 */
  text: string;
}

export interface SendOptions {
  /** 快捷命令的名字，提示里会带上；命令编辑器发的不带 */
  name?: string;
  /** 只把文字放进终端，不按回车 */
  noEnter?: boolean;
}

/** 发一条命令。内容是空的返回 null，什么都不发 */
export function sendTo(
  sender: CommandSender,
  sessionId: string,
  target: SendTarget,
  text: string,
  { name, noEnter = false }: SendOptions = {},
): SendResult | null {
  const cmd = toTerminalInput(text);
  if (!cmd.trim()) return null;
  if (target === 'all') {
    const n = sender.sendToAll(cmd, !noEnter);
    if (n === 0) return { ok: false, text: '没有已连接的会话' };
    return { ok: true, text: noEnter ? `已填入 ${n} 个会话，未发送回车` : `已发送到 ${n} 个会话` };
  }
  if (!sender.sendCommand(sessionId, cmd, !noEnter)) return { ok: false, text: '当前会话未连接' };
  if (noEnter) return { ok: true, text: name ? `已将「${name}」填入当前会话，未发送回车` : '已填入当前会话，未发送回车' };
  return { ok: true, text: name ? `已将「${name}」发送到当前会话` : '已发送到当前会话' };
}
