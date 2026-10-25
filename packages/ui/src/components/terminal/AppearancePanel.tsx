import { useRef, useState, type ChangeEvent } from 'react';
import type { Scheme } from '../../core/settings';
import { useStore } from '../../core/store';
import {
  FONT_SIZES,
  PRESETS,
  resolveCustom,
  resolvePreset,
  terminalAppearance,
  terminalBgImage,
  type ResolvedScheme,
} from '../../core/terminal-appearance';
import { CloseIcon } from '../common/Icons';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** “终端外观”浮层：8 个预设 + 自定义颜色、字号、背景图片。改动立刻生效并持久化 */
export function AppearancePanel({ scheme, onClose }: { scheme: Scheme; onClose(): void }) {
  const appearance = useStore(terminalAppearance);
  const bgImage = useStore(terminalBgImage);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isCustom = appearance.preset === 'custom';

  const pickImage = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setImageError('请选择图片文件');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError('图片不能超过 4 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      terminalBgImage.set(typeof reader.result === 'string' ? reader.result : null);
      setImageError(null);
    };
    reader.onerror = () => setImageError('读取图片失败');
    reader.readAsDataURL(file);
  };

  return (
    <div role="dialog" aria-label="终端外观" className="look" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="look__head">
        <strong>终端外观</strong>
        <button type="button" className="tb look__close" aria-label="关闭" onClick={onClose}>
          <CloseIcon size={10} />
        </button>
      </div>
      <div className="look__grid">
        {PRESETS.map((p) => (
          <PresetCard
            key={p.id}
            scheme={resolvePreset(p, scheme)}
            selected={appearance.preset === p.id}
            onPick={() => terminalAppearance.set((a) => ({ ...a, preset: p.id }))}
          />
        ))}
      </div>
      <div className="look__custom">
        <span className={`look__customLabel${isCustom ? ' look__customLabel--on' : ''}`}>自定义</span>
        <label className="look__color">
          背景色
          <input
            type="color"
            value={appearance.custom.bg}
            onChange={(e) => terminalAppearance.set((a) => ({ ...a, preset: 'custom', custom: { ...a.custom, bg: e.target.value } }))}
          />
        </label>
        <label className="look__color">
          文字色
          <input
            type="color"
            value={appearance.custom.fg}
            onChange={(e) => terminalAppearance.set((a) => ({ ...a, preset: 'custom', custom: { ...a.custom, fg: e.target.value } }))}
          />
        </label>
        <span className="look__size">
          <label htmlFor="tsize">字号</label>
          <select
            id="tsize"
            className="field"
            value={String(appearance.fontSize)}
            onChange={(e) => terminalAppearance.set((a) => ({ ...a, fontSize: Number(e.target.value) }))}
          >
            {FONT_SIZES.map((s) => (
              <option key={s} value={String(s)}>
                {s}
              </option>
            ))}
          </select>
        </span>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          背景图片…
        </button>
        {bgImage && (
          <button type="button" className="btn" onClick={() => terminalBgImage.set(null)}>
            清除图片
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} onChange={pickImage} />
      </div>
      <span className="look__hint">
        {imageError ?? '设置对所有会话生效。「跟随系统」在浅色模式下为浅灰色背景，在深色模式下为黑色背景。'}
      </span>
      {isCustom && <CustomPreview scheme={resolveCustom(appearance.custom)} />}
    </div>
  );
}

function PresetCard({ scheme, selected, onPick }: { scheme: ResolvedScheme; selected: boolean; onPick(): void }) {
  return (
    <button type="button" className="preset" aria-pressed={selected} onClick={onPick}>
      <span className={`preset__swatch${selected ? ' preset__swatch--on' : ''}`} style={{ background: scheme.bg, color: scheme.fg }}>
        <span className="preset__line">
          <span style={{ color: scheme.green }}>root@web</span>:<span style={{ color: scheme.blue }}>~</span>$ ls
        </span>
        <span className="preset__line">
          app logs <span style={{ color: scheme.red }}>error</span>
        </span>
      </span>
      <span className={`preset__name${selected ? ' preset__name--on' : ''}`}>{scheme.name}</span>
    </button>
  );
}

/** 自定义配色的即时预览：看一眼提示符颜色对不对 */
function CustomPreview({ scheme }: { scheme: ResolvedScheme }) {
  return (
    <span className="preset__swatch look__preview" style={{ background: scheme.bg, color: scheme.fg }}>
      <span className="preset__line">
        <span style={{ color: scheme.green }}>root@web</span>:<span style={{ color: scheme.blue }}>~</span>$ ls
      </span>
      <span className="preset__line">
        app logs <span style={{ color: scheme.red }}>error</span> <span style={{ color: scheme.amber }}>warn</span>{' '}
        <span style={{ color: scheme.cyan }}>notice</span>
      </span>
    </span>
  );
}
