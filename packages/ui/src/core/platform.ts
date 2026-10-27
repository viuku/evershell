// 各系统的快捷键差异集中在这里，界面里不要写死 ⌘ 或 Ctrl。
//
// 应用级快捷键（连接管理器、新标签页、关闭标签）：
// - Mac 用 ⌘+键。Ctrl+W / Ctrl+T / Ctrl+O 在终端里是删词等控制键，要留给 shell。
// - 其他系统（Windows、Linux）用 Ctrl+Shift+键，同样是为了不抢终端的 Ctrl+字母。
// 输入框里的“修饰键+回车”不会进终端，Mac 显示 ⌘⏎，其他系统显示 Ctrl+Enter。

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** 按下的是不是应用级快捷键 key（小写字母） */
export function isAppShortcut(e: KeyboardEvent, key: string): boolean {
  if (e.altKey || e.key.toLowerCase() !== key) return false;
  return isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}

/** 应用级快捷键在界面上的写法：⌘O / Ctrl+Shift+O */
export function shortcutLabel(key: string): string {
  return isMac ? `⌘${key.toUpperCase()}` : `Ctrl+Shift+${key.toUpperCase()}`;
}

export const modEnterLabel = isMac ? '⌘⏎' : 'Ctrl+Enter';

/** 编辑器里的快捷键写法：⌘S / Ctrl+S（编辑器里没有终端，不用让着 Ctrl+字母） */
export function editorShortcutLabel(key: string): string {
  return isMac ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/** 编辑器里按的是不是“修饰键+key”：Mac ⌘，其他系统 Ctrl */
export function isEditorShortcut(e: Mods & { key: string }, key: string): boolean {
  if (e.altKey || e.shiftKey || e.key.toLowerCase() !== key) return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

type Mods = { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** 输入框里按的是不是“修饰键+回车”（文字见 modEnterLabel） */
export function isModEnter(e: Mods & { key: string }): boolean {
  if (e.key !== 'Enter' || e.altKey || e.shiftKey) return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

// 列表多选的按键照各系统的文件管理器：Mac 同访达，其他系统同资源管理器。

/** 单击时按住的是不是“加选/取消这一项”的键：Mac ⌘，其他系统 Ctrl */
export function isToggleSelect(e: Mods): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** 全选：Mac ⌘A，其他系统 Ctrl+A */
export function isSelectAllKey(e: Mods & { key: string }): boolean {
  if (e.altKey || e.shiftKey || e.key.toLowerCase() !== 'a') return false;
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** 删除所选：Mac ⌘⌫（访达的“移到废纸篓”），其他系统 Delete */
export function isDeleteSelectedKey(e: Mods & { key: string }): boolean {
  if (e.altKey || e.shiftKey) return false;
  return isMac ? e.metaKey && e.key === 'Backspace' : !e.metaKey && !e.ctrlKey && e.key === 'Delete';
}

// 文件区的快捷键：只在文件列表有焦点时生效，不和终端抢键。Mac 照访达，其他系统照资源管理器；
// 列表见 docs/design/README.md。上下移动、全选、Esc、Home / End 这类各系统一样的键由列表自己处理

export type FileKeyAction = 'open' | 'up' | 'rename' | 'delete' | 'newFolder' | 'refresh' | 'copyPath' | 'focusPath';

/** 文件列表里按下的是哪个快捷键；不是快捷键时返回 null */
export function fileKeyAction(e: Mods & { key: string; code?: string }): FileKeyAction | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (bare && k === 'Enter') return 'open';
  if (isMac && mod && !e.altKey && !e.shiftKey && k === 'ArrowDown') return 'open';
  if (bare && k === 'Backspace') return 'up';
  if (isMac ? mod && !e.altKey && !e.shiftKey && k === 'ArrowUp' : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && k === 'ArrowUp') return 'up';
  if (bare && k === 'F2') return 'rename';
  // Mac 上单独的 Delete 是 fn+⌫（向后删除）
  if (isDeleteSelectedKey(e) || (bare && k === 'Delete')) return 'delete';
  if (mod && e.shiftKey && !e.altKey && k === 'n') return 'newFolder';
  if ((mod && !e.shiftKey && !e.altKey && k === 'r') || (!isMac && bare && k === 'F5')) return 'refresh';
  // ⌥⌘C 时 key 是 ç，按物理键位认
  if (isMac ? mod && e.altKey && !e.shiftKey && e.code === 'KeyC' : mod && e.shiftKey && !e.altKey && k === 'c') return 'copyPath';
  if (mod && !e.shiftKey && !e.altKey && k === 'l') return 'focusPath';
  return null;
}

/** 文件区快捷键在右键菜单上的写法 */
export const fileKeyLabels: Record<FileKeyAction, string> = isMac
  ? { open: '⏎', up: '⌘↑', rename: 'F2', delete: '⌘⌫', newFolder: '⇧⌘N', refresh: '⌘R', copyPath: '⌥⌘C', focusPath: '⌘L' }
  : {
      open: 'Enter',
      up: 'Alt+↑',
      rename: 'F2',
      delete: 'Delete',
      newFolder: 'Ctrl+Shift+N',
      refresh: 'F5',
      copyPath: 'Ctrl+Shift+C',
      focusPath: 'Ctrl+L',
    };

/**
 * 标记“按住能拖动窗口”的空白处。桌面端 Mac 隐藏了系统标题栏，窗口靠标签栏、状态栏顶部的空白拖动；
 * 只对元素本身生效，里面的按钮照常点击。网页端没有这回事，属性留着也无影响。
 */
export const dragRegion = { 'data-tauri-drag-region': '' } as const;
