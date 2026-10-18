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

/**
 * 标记“按住能拖动窗口”的空白处。桌面端 Mac 隐藏了系统标题栏，窗口靠标签栏、状态栏顶部的空白拖动；
 * 只对元素本身生效，里面的按钮照常点击。网页端没有这回事，属性留着也无影响。
 */
export const dragRegion = { 'data-tauri-drag-region': '' } as const;
