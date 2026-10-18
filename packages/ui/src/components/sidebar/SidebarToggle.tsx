import { SidebarIcon } from '../common/Icons';

/**
 * 显示或隐藏状态栏的开关。状态栏展开时放在它顶部，收起时放在标签栏最前面，
 * 两种情况下都紧挨着左上角的红绿灯，屏幕上的位置不变
 */
export function SidebarToggle({ onToggle }: { onToggle(): void }) {
  return (
    <button type="button" className="tb sidebar-toggle" aria-label="显示或隐藏状态栏" title="显示或隐藏状态栏" onClick={onToggle}>
      <SidebarIcon size={16} />
    </button>
  );
}
