export interface SegmentOption<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  ariaLabel: string;
  /** 小号用于快捷命令分组和弹窗页签 */
  size?: 'normal' | 'small';
  /** 用作面板切换时是 tablist，用作筛选时是 group */
  role?: 'tablist' | 'group';
}

/** Mac 式分段控件，和设计稿里的底部面板切换一致 */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel, size = 'normal', role = 'tablist' }: Props<T>) {
  return (
    <div role={role} aria-label={ariaLabel} className={`seg seg--${size}`}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role={role === 'tablist' ? 'tab' : undefined}
            aria-selected={role === 'tablist' ? on : undefined}
            aria-pressed={role === 'group' ? on : undefined}
            className={`seg__item${on ? ' seg__item--on' : ''}`}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
