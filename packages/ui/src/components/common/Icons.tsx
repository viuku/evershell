import type { SVGProps } from 'react';

// 设计稿里的线性图标，统一 24 视图框，颜色跟随 currentColor

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const FolderOutlineIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const NewFolderIcon = (p: P) => (
  <Svg strokeWidth={1.8} {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </Svg>
);

export const NewConnectionIcon = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <rect x="2.5" y="5" width="15" height="13" rx="2" />
    <path d="M6 10l2.5 2-2.5 2M10.5 14h3.5M19.5 3v6M16.5 6h6" />
  </Svg>
);

export const CloseIcon = (p: P) => (
  <Svg strokeWidth={3} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const PlusIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const SidebarIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);

export const MenuIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const PaletteIcon = (p: P) => (
  <Svg strokeWidth={1.8} {...p}>
    <path d="M12 3a9 9 0 1 0 0 18c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.3-4-7.8-9-7.8z" />
    <circle cx="7.5" cy="11" r="1" />
    <circle cx="10.5" cy="7" r="1" />
    <circle cx="15" cy="7" r="1" />
  </Svg>
);

export const UpIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);

export const DownIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);

export const ChevronUpIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M6 15l6-6 6 6" />
  </Svg>
);

export const ChevronDownIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const ChevronRightIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

/** 往上的箭头落在一条横线上：上传 */
export const UploadIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
  </Svg>
);

/** 实心闪电，颜色表示连接状态 */
export const BoltIcon = (p: P) => (
  <Svg {...p}>
    <path fill="currentColor" d="M13.5 2.5 5 13.5h6.5l-1 8 8.5-11H12.5z" />
  </Svg>
);

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.3 15.3l5.2 5.2" />
  </Svg>
);

export const GearIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9.93 5.31l.24-2.33h3.66l.24 2.33 1.2.5 1.81-1.48 2.59 2.59-1.48 1.81.5 1.2 2.33.24v3.66l-2.33.24-.5 1.2 1.48 1.81-2.59 2.59-1.81-1.48-1.2.5-.24 2.33h-3.66l-.24-2.33-1.2-.5-1.81 1.48-2.59-2.59 1.48-1.81-.5-1.2-2.33-.24v-3.66l2.33-.24.5-1.2-1.48-1.81 2.59-2.59 1.81 1.48z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

/** 回车键被划掉：快捷命令「不自动回车」 */
export const NoEnterIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M9 10l-4 4 4 4" />
    <path d="M19 5v5a4 4 0 0 1-4 4H5" />
    <path d="M4 4l16 16" />
  </Svg>
);

export const RefreshIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 5v6h-6" />
  </Svg>
);

export const EditIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Svg>
);

export const TrashIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" />
  </Svg>
);

export const CollapseAllIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8.5 12h7" />
  </Svg>
);

export const ExpandAllIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8.5 12h7M12 8.5v7" />
  </Svg>
);

export const ImportIcon = (p: P) => (
  <Svg strokeWidth={1.8} {...p}>
    <path d="M12 4v10M8 10l4 4 4-4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Svg>
);

export const ExportIcon = (p: P) => (
  <Svg strokeWidth={1.8} {...p}>
    <path d="M12 14V4M8 8l4-4 4 4" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Svg>
);

/** 文件夹实心图标；fill 默认跟随 --folder 变量 */
export function FolderFillIcon({ size = 16, fill = 'var(--folder)', ...rest }: P & { fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <path d="M2.5 6.5a2 2 0 0 1 2-2h4.6l2 2.2h8.4a2 2 0 0 1 2 2v9.8a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill={fill} />
    </svg>
  );
}

/** 服务器（终端窗口）图标 */
export function ServerIcon({ size = 16, fill = '#3A3A40', ...rest }: P & { fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <rect x="2.5" y="4" width="19" height="16" rx="3" fill={fill} />
      <path d="M7 9.5l3 2.5-3 2.5M12 15h5" fill="none" stroke="#FFFFFF" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const FileIcon = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);

/** 展开 / 折叠的小三角 */
export function DisclosureIcon({ open, size = 9 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s' }}
    >
      <path d="M8 4l10 8-10 8z" />
    </svg>
  );
}

export const SortIcon = () => (
  <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 6l8 10H4z" />
  </svg>
);

export const CheckIcon = (p: P) => (
  <Svg strokeWidth={2.4} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);

/** 黄色三角感叹号，和 Mac 警告框里的一样（主机密钥确认用） */
export function CautionIcon({ size = 32, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" {...rest}>
      <path d="M20 4 37 35H3Z" fill="#F5A524" stroke="#F5A524" strokeWidth={4} strokeLinejoin="round" />
      <rect x="18.1" y="13" width="3.8" height="13" rx="1.9" fill="#fff" />
      <circle cx="20" cy="30.4" r="2.2" fill="#fff" />
    </svg>
  );
}

/** 转圈的进度，转动在样式里（.spin） */
export const SpinnerIcon = (p: P) => (
  <Svg strokeWidth={2.6} className="spin" {...p}>
    <path d="M12 3a9 9 0 1 1-9 9" />
  </Svg>
);

/** 线性的三角感叹号，跟随文字颜色（行内警告用） */
export const WarnIcon = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M12 3l9.5 17h-19z" />
    <path d="M12 10v4M12 17.5v.5" />
  </Svg>
);

export const SuccessIcon = (p: P) => (
  <Svg strokeWidth={1.8} {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M7.5 12.5l3 3 6-6.5" />
  </Svg>
);

export const ComputerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 5h14v10H5zM3 19h18" />
  </Svg>
);

export const GlobeIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9" />
  </Svg>
);
