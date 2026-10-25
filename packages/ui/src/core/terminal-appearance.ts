import type { ITheme } from '@xterm/xterm';
import type { Scheme } from './settings';
import { PersistentStore, readText, writeText } from './storage';
import { Store } from './store';

/** 终端配色的最小集合，和设计稿“外观”面板里的预览一致 */
export interface Palette {
  dim: string;
  green: string;
  blue: string;
  red: string;
  amber: string;
  cyan: string;
  magenta: string;
}

export interface ResolvedScheme extends Palette {
  id: string;
  name: string;
  bg: string;
  fg: string;
  isLight: boolean;
}

interface Preset {
  id: string;
  name: string;
  /** 'system' 没有固定颜色，随界面深浅色切换 */
  bg: string | null;
  fg: string | null;
  palette: Palette | null;
}

export const DARK_PALETTE: Palette = {
  dim: '#8A8A8A',
  green: '#5FD068',
  blue: '#6CA8FF',
  red: '#FF6B6B',
  amber: '#E5B847',
  cyan: '#4FC8D8',
  magenta: '#D28BF0',
};

export const LIGHT_PALETTE: Palette = {
  dim: '#6A6A70',
  green: '#1D7F37',
  blue: '#0B5CC4',
  red: '#C62828',
  amber: '#9A5B00',
  cyan: '#0E7490',
  magenta: '#8E3FA8',
};

const SOLARIZED: Palette = {
  dim: '#6C8087',
  green: '#859900',
  blue: '#268BD2',
  red: '#DC322F',
  amber: '#B58900',
  cyan: '#2AA198',
  magenta: '#D33682',
};

/** 设计稿里的 8 个预设，顺序一致 */
export const PRESETS: Preset[] = [
  { id: 'system', name: '跟随系统', bg: null, fg: null, palette: null },
  { id: 'black', name: '经典黑', bg: '#000000', fg: '#E5E5E5', palette: DARK_PALETTE },
  { id: 'gray', name: '深灰', bg: '#1E1E1E', fg: '#D4D4D4', palette: DARK_PALETTE },
  { id: 'navy', name: '深海蓝', bg: '#0F1B2B', fg: '#CFD8E3', palette: DARK_PALETTE },
  { id: 'solar', name: 'Solarized 深色', bg: '#002B36', fg: '#93A1A1', palette: SOLARIZED },
  { id: 'paper', name: '纸张米白', bg: '#FBF7EC', fg: '#3B3A36', palette: LIGHT_PALETTE },
  { id: 'green', name: '护眼绿', bg: '#C7EDCC', fg: '#1E3A24', palette: { ...LIGHT_PALETTE, dim: '#4C6652' } },
  { id: 'white', name: '纯白', bg: '#FFFFFF', fg: '#1D1D1F', palette: LIGHT_PALETTE },
];

/** 跟随系统时的终端颜色：浅色是浅灰底，深色是黑底（见设计稿 --sys-t-*） */
const SYSTEM_SCHEMES: Record<Scheme, Omit<ResolvedScheme, 'id' | 'name'>> = {
  light: { bg: '#EEF0F3', fg: '#1D1D1F', isLight: true, ...LIGHT_PALETTE },
  dark: { bg: '#0C0C0C', fg: '#D0D0D0', isLight: false, ...DARK_PALETTE },
};

export const FONT_SIZES = [12, 12.5, 13, 14, 15];

export interface TerminalAppearance {
  preset: string;
  custom: { bg: string; fg: string };
  fontSize: number;
}

const DEFAULT_APPEARANCE: TerminalAppearance = {
  preset: 'system',
  custom: { bg: '#1E2B24', fg: '#D5E4D9' },
  fontSize: 12.5,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function normalize(raw: unknown, fallback: TerminalAppearance): TerminalAppearance {
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<TerminalAppearance>;
  const presetOk = r.preset === 'custom' || PRESETS.some((p) => p.id === r.preset);
  const custom = r.custom && HEX.test(r.custom.bg) && HEX.test(r.custom.fg) ? r.custom : fallback.custom;
  return {
    preset: presetOk && r.preset ? r.preset : fallback.preset,
    custom,
    fontSize: FONT_SIZES.includes(r.fontSize as number) ? (r.fontSize as number) : fallback.fontSize,
  };
}

export const terminalAppearance = new PersistentStore<TerminalAppearance>(
  'evershell.terminal-appearance.v1',
  DEFAULT_APPEARANCE,
  normalize,
);

const BG_IMAGE_KEY = 'evershell.terminal-bg-image';

/** 背景图片的 data URL，单独存一个键，避免每次改字号都重写几 MB */
export const terminalBgImage = new Store<string | null>(readText(BG_IMAGE_KEY));
terminalBgImage.subscribe(() => writeText(BG_IMAGE_KEY, terminalBgImage.get()));

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function isLightColor(hex: string): boolean {
  const [r, g, b] = rgbOf(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

/** 标签栏底色，和 base.css 的 --strip 保持一致 */
const STRIP_COLORS: Record<Scheme, string> = { light: '#D7D8DC', dark: '#333336' };

/**
 * 选中的会话标签和终端同色。终端底色和标签栏太接近时（只会出现在自定义颜色上），
 * 选中标签要描一道细边，否则看不出哪个是选中的
 */
export function tabNeedsEdge(bg: string, scheme: Scheme): boolean {
  const a = rgbOf(bg);
  const b = rgbOf(STRIP_COLORS[scheme]);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 24;
}

/** 预设在当前深浅色下的实际颜色（给面板预览用） */
export function resolvePreset(preset: Preset, scheme: Scheme): ResolvedScheme {
  if (preset.id === 'system') return { id: preset.id, name: preset.name, ...SYSTEM_SCHEMES[scheme] };
  const bg = preset.bg ?? '#000000';
  return {
    id: preset.id,
    name: preset.name,
    bg,
    fg: preset.fg ?? '#FFFFFF',
    isLight: isLightColor(bg),
    ...(preset.palette ?? DARK_PALETTE),
  };
}

/** 自定义配色：提示符等颜色随背景深浅自动切换 */
export function resolveCustom(custom: TerminalAppearance['custom']): ResolvedScheme {
  const light = isLightColor(custom.bg);
  return {
    id: 'custom',
    name: '自定义',
    bg: custom.bg,
    fg: custom.fg,
    isLight: light,
    ...(light ? LIGHT_PALETTE : DARK_PALETTE),
  };
}

export function resolveScheme(appearance: TerminalAppearance, scheme: Scheme): ResolvedScheme {
  if (appearance.preset === 'custom') return resolveCustom(appearance.custom);
  const preset = PRESETS.find((p) => p.id === appearance.preset) ?? PRESETS[0]!;
  return resolvePreset(preset, scheme);
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 映射成 xterm 的主题，包括 ANSI 16 色。有背景图时底色半透明，让图片透出来 */
export function toXtermTheme(s: ResolvedScheme, hasBgImage: boolean): ITheme {
  const black = s.isLight ? '#1D1D1F' : '#2E2E32';
  const white = s.isLight ? '#8E8E93' : '#E5E5E5';
  return {
    background: hasBgImage ? withAlpha(s.bg, 0.72) : s.bg,
    foreground: s.fg,
    cursor: s.fg,
    cursorAccent: s.bg,
    selectionBackground: withAlpha(s.blue, s.isLight ? 0.22 : 0.32),
    selectionInactiveBackground: withAlpha(s.blue, s.isLight ? 0.12 : 0.18),
    black,
    red: s.red,
    green: s.green,
    yellow: s.amber,
    blue: s.blue,
    magenta: s.magenta,
    cyan: s.cyan,
    white,
    brightBlack: s.dim,
    brightRed: s.red,
    brightGreen: s.green,
    brightYellow: s.amber,
    brightBlue: s.blue,
    brightMagenta: s.magenta,
    brightCyan: s.cyan,
    brightWhite: s.isLight ? '#1D1D1F' : '#FFFFFF',
  };
}
