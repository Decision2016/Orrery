import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
  type BackgroundKind,
  type BackgroundPresetId,
  type WallpaperFit,
  type WallpaperPosition,
} from '@orrery/shared';

const ALLOWED_KINDS = new Set<BackgroundKind>(['none', 'preset', 'image']);
const ALLOWED_PRESETS = new Set<BackgroundPresetId>(['nebula', 'aurora', 'sunset', 'grid']);
const ALLOWED_FITS = new Set<WallpaperFit>(['cover', 'contain', 'fill']);
const ALLOWED_POSITIONS = new Set<WallpaperPosition>(['center', 'top', 'bottom']);

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

export const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;

export class AppearanceValidationError extends Error {}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.min(max, Math.max(min, num)) * 1000) / 1000;
}

function sanitizeSettings(raw: unknown, current: AppearanceSettings = DEFAULT_APPEARANCE): AppearanceSettings {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const backgroundKind = ALLOWED_KINDS.has(obj.backgroundKind as BackgroundKind)
    ? (obj.backgroundKind as BackgroundKind)
    : current.backgroundKind;
  const backgroundPreset = ALLOWED_PRESETS.has(obj.backgroundPreset as BackgroundPresetId)
    ? (obj.backgroundPreset as BackgroundPresetId)
    : current.backgroundPreset;
  const wallpaperFit = ALLOWED_FITS.has(obj.wallpaperFit as WallpaperFit)
    ? (obj.wallpaperFit as WallpaperFit)
    : current.wallpaperFit;
  const wallpaperPosition = ALLOWED_POSITIONS.has(obj.wallpaperPosition as WallpaperPosition)
    ? (obj.wallpaperPosition as WallpaperPosition)
    : current.wallpaperPosition;
  const wallpaperVersion =
    typeof obj.wallpaperVersion === 'number' && Number.isFinite(obj.wallpaperVersion)
      ? obj.wallpaperVersion
      : current.wallpaperVersion;
  const wallpaperName =
    typeof obj.wallpaperName === 'string' && obj.wallpaperName.trim()
      ? obj.wallpaperName.trim().slice(0, 140)
      : current.wallpaperName;

  return {
    backgroundKind,
    backgroundPreset,
    wallpaperVersion,
    wallpaperName,
    wallpaperFit,
    wallpaperPosition,
    panelOpacity: clamp(obj.panelOpacity, 0.12, 1, current.panelOpacity),
    hudOpacity: clamp(obj.hudOpacity, 0.2, 1, current.hudOpacity),
    panelBlurPx: Math.round(clamp(obj.panelBlurPx, 0, 32, current.panelBlurPx)),
    scrimOpacity: clamp(obj.scrimOpacity, 0, 0.8, current.scrimOpacity),
  };
}

export class AppearanceStore {
  private readonly filePath: string;
  private readonly dirPath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: { appearanceFilePath: string }) {
    this.filePath = config.appearanceFilePath;
    this.dirPath = path.dirname(config.appearanceFilePath);
  }

  private async findWallpaperFile(): Promise<{ fullPath: string; ext: string } | null> {
    try {
      const entries = await readdir(this.dirPath);
      for (const name of entries) {
        if (!name.startsWith('wallpaper.')) continue;
        const ext = path.extname(name).toLowerCase();
        if (ext in EXT_TO_MIME) {
          return { fullPath: path.join(this.dirPath, name), ext };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async removeAllWallpapers() {
    try {
      const entries = await readdir(this.dirPath);
      await Promise.all(
        entries
          .filter(name => name.startsWith('wallpaper.'))
          .map(name => unlink(path.join(this.dirPath, name)).catch(() => {})),
      );
    } catch {
      // Directory may not exist yet.
    }
  }

  async load(): Promise<AppearanceSettings> {
    let settings = { ...DEFAULT_APPEARANCE };
    try {
      const text = await readFile(this.filePath, 'utf8');
      settings = sanitizeSettings(JSON.parse(text), DEFAULT_APPEARANCE);
    } catch {
      // Missing or malformed appearance file falls back to defaults.
    }
    const wallpaper = await this.findWallpaperFile();
    if (!wallpaper && settings.backgroundKind === 'image') {
      settings.backgroundKind = 'none';
      settings.wallpaperVersion = undefined;
      settings.wallpaperName = undefined;
    } else if (wallpaper && !settings.wallpaperVersion) {
      settings.wallpaperVersion = 1;
    }
    return settings;
  }

  private async writeSettingsAtomic(next: AppearanceSettings): Promise<AppearanceSettings> {
    await mkdir(this.dirPath, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    await rename(tmp, this.filePath);
    return next;
  }

  save(raw: unknown): Promise<AppearanceSettings> {
    const task = this.writeQueue.then(async () => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AppearanceValidationError('Expected an appearance settings object.');
      }
      const current = await this.load();
      const next = sanitizeSettings(raw, current);
      if (next.backgroundKind === 'image' && !(await this.findWallpaperFile())) {
        next.backgroundKind = 'none';
      }
      return this.writeSettingsAtomic(next);
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  saveWallpaper(bytes: Buffer, contentType: string, filename?: string): Promise<AppearanceSettings> {
    const task = this.writeQueue.then(async () => {
      const mime = contentType.split(';', 1)[0].trim().toLowerCase();
      const ext = MIME_TO_EXT[mime];
      if (!ext) {
        throw new AppearanceValidationError('仅支持 PNG / JPG / WebP / GIF / AVIF 图片格式。');
      }
      if (!bytes.length || bytes.length > MAX_WALLPAPER_BYTES) {
        throw new AppearanceValidationError('图片大小需在 1 字节至 25 MB 之间。');
      }
      await mkdir(this.dirPath, { recursive: true });
      await this.removeAllWallpapers();
      const target = path.join(this.dirPath, `wallpaper${ext}`);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, target);

      const current = await this.load();
      const cleanName = filename ? path.basename(filename).slice(0, 140) : `wallpaper${ext}`;
      const next: AppearanceSettings = {
        ...current,
        backgroundKind: 'image',
        wallpaperVersion: Date.now(),
        wallpaperName: cleanName,
      };
      return this.writeSettingsAtomic(next);
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  clearWallpaper(): Promise<AppearanceSettings> {
    const task = this.writeQueue.then(async () => {
      await this.removeAllWallpapers();
      const current = await this.load();
      const next: AppearanceSettings = {
        ...current,
        backgroundKind: current.backgroundKind === 'image' ? 'none' : current.backgroundKind,
        wallpaperVersion: undefined,
        wallpaperName: undefined,
      };
      return this.writeSettingsAtomic(next);
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async readWallpaper(): Promise<{ bytes: Buffer; contentType: string } | null> {
    const found = await this.findWallpaperFile();
    if (!found) return null;
    try {
      const bytes = await readFile(found.fullPath);
      return { bytes, contentType: EXT_TO_MIME[found.ext] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }
}
