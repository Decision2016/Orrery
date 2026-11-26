import { useRef, useState } from 'react';
import { Image as ImageIcon, RotateCcw, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { AppearanceSettings, BackgroundKind, BackgroundPresetId, WallpaperFit, WallpaperPosition } from '@orrery/shared';

const PRESETS: { id: BackgroundPresetId; name: string; swatch: string }[] = [
  { id: 'nebula', name: '深空星云', swatch: 'linear-gradient(115deg, #0b1938 0%, #16244d 38%, #1e1b4b 68%, #0c334a 100%)' },
  { id: 'aurora', name: '极光幕布', swatch: 'linear-gradient(115deg, #07222b 0%, #0d4a4f 35%, #164e63 65%, #1e1b4b 100%)' },
  { id: 'sunset', name: '日落海平', swatch: 'linear-gradient(115deg, #27122b 0%, #5b2149 42%, #9a3412 75%, #1e293b 100%)' },
  { id: 'grid', name: '星轨网格', swatch: 'linear-gradient(115deg, #0f172a 0%, #1e293b 50%, #0f2942 100%)' },
];

const KINDS: { id: BackgroundKind; label: string }[] = [
  { id: 'none', label: '纯色默认' },
  { id: 'preset', label: '内置超宽壁纸' },
  { id: 'image', label: '自定义图片' },
];

const FITS: { id: WallpaperFit; label: string }[] = [
  { id: 'cover', label: '铺满裁剪' },
  { id: 'contain', label: '完整适应' },
  { id: 'fill', label: '拉伸填充' },
];

const POSITIONS: { id: WallpaperPosition; label: string }[] = [
  { id: 'top', label: '靠上' },
  { id: 'center', label: '居中' },
  { id: 'bottom', label: '靠下' },
];

interface Props {
  appearance: AppearanceSettings;
  uploading: boolean;
  onUpdate: (patch: Partial<AppearanceSettings>) => void;
  onUpload: (file: File) => Promise<void>;
  onClearWallpaper: () => Promise<void>;
  onReset: () => void;
  onClose: () => void;
}

export function AppearancePanel({ appearance, uploading, onUpdate, onUpload, onClearWallpaper, onReset, onClose }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void onUpload(file);
  };

  return (
    <aside className="appearance-panel" role="dialog" aria-label="背景与界面透明度设置">
      <div className="dialog-head">
        <h2 className="inline-group"><ImageIcon size={15} /><span>自定义背景与透明度</span></h2>
        <button className="icon-button" aria-label="关闭外观面板" onClick={onClose}><X size={15} /></button>
      </div>
      <div className="appearance-body widget-scroll">
        <section className="appearance-section">
          <div className="section-label"><span>背景模式</span></div>
          <div className="segments appearance-segments">
            {KINDS.map(k => (
              <button key={k.id} aria-pressed={appearance.backgroundKind === k.id}
                onClick={() => onUpdate({ backgroundKind: k.id })}>{k.label}</button>
            ))}
          </div>
        </section>

        {appearance.backgroundKind === 'preset' && (
          <section className="appearance-section">
            <div className="section-label"><Sparkles size={13} /><span>内置 3840×1100 广角背景</span></div>
            <div className="preset-swatches">
              {PRESETS.map(p => (
                <button key={p.id} className={`swatch-card ${appearance.backgroundPreset === p.id ? 'chosen' : ''}`}
                  onClick={() => onUpdate({ backgroundKind: 'preset', backgroundPreset: p.id })}>
                  <span className="swatch-preview" style={{ background: p.swatch }} />
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {appearance.backgroundKind === 'image' && (
          <section className="appearance-section">
            <div className="section-label"><span>本地图片背景</span><span>≤ 25 MB</span></div>
            <div
              className={`upload-dropzone ${dragging ? 'is-dragging' : ''}`}
              onClick={() => fileInput.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
            >
              <Upload size={16} />
              <div>
                <strong>{uploading ? '正在保存背景图…' : appearance.wallpaperName ? `当前：${appearance.wallpaperName}` : '点击选择或拖拽图片到此处'}</strong>
                <small>支持 PNG / JPG / WebP / GIF / AVIF，推荐 3840×1100 横图</small>
              </div>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden
                onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
            </div>
            <div className="appearance-row">
              <div className="segments">
                {FITS.map(f => (
                  <button key={f.id} aria-pressed={appearance.wallpaperFit === f.id}
                    onClick={() => onUpdate({ wallpaperFit: f.id })}>{f.label}</button>
                ))}
              </div>
              <div className="segments">
                {POSITIONS.map(pos => (
                  <button key={pos.id} aria-pressed={appearance.wallpaperPosition === pos.id}
                    onClick={() => onUpdate({ wallpaperPosition: pos.id })}>{pos.label}</button>
                ))}
              </div>
            </div>
            {appearance.wallpaperVersion && (
              <button className="action-button tone-rose" onClick={() => void onClearWallpaper()}>
                <Trash2 size={13} />清除自定义图片
              </button>
            )}
          </section>
        )}

        <section className="appearance-section">
          <div className="section-label"><span>界面透明度与毛玻璃</span><span>实时预览</span></div>
          <label className="slider-field">
            <div className="between"><span>面板不透明度</span><b className="mono">{Math.round(appearance.panelOpacity * 100)}%</b></div>
            <input type="range" min={12} max={100} step={1} value={Math.round(appearance.panelOpacity * 100)}
              onChange={e => onUpdate({ panelOpacity: Number(e.target.value) / 100 })} />
          </label>
          <label className="slider-field">
            <div className="between"><span>顶栏不透明度</span><b className="mono">{Math.round(appearance.hudOpacity * 100)}%</b></div>
            <input type="range" min={20} max={100} step={1} value={Math.round(appearance.hudOpacity * 100)}
              onChange={e => onUpdate({ hudOpacity: Number(e.target.value) / 100 })} />
          </label>
          <label className="slider-field">
            <div className="between"><span>毛玻璃模糊强度</span><b className="mono">{appearance.panelBlurPx} px</b></div>
            <input type="range" min={0} max={28} step={1} value={appearance.panelBlurPx}
              onChange={e => onUpdate({ panelBlurPx: Number(e.target.value) })} />
          </label>
          <label className="slider-field">
            <div className="between"><span>背景遮罩浓度</span><b className="mono">{Math.round(appearance.scrimOpacity * 100)}%</b></div>
            <input type="range" min={0} max={75} step={1} value={Math.round(appearance.scrimOpacity * 100)}
              onChange={e => onUpdate({ scrimOpacity: Number(e.target.value) / 100 })} />
          </label>
        </section>

        <div className="appearance-foot">
          <button className="action-button" onClick={onReset}><RotateCcw size={13} />恢复默认外观</button>
        </div>
      </div>
    </aside>
  );
}
