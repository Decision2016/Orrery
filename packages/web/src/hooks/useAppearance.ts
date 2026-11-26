import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_APPEARANCE, type AppearanceSettings } from '@orrery/shared';
import { apiPath } from '../lib/api';
import { readLocal, writeLocal } from '../lib/storage';

const STORAGE_KEY = 'orrery.appearance';

function loadInitialAppearance(): AppearanceSettings {
  const cached = readLocal(STORAGE_KEY);
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
    return { ...DEFAULT_APPEARANCE, ...(cached as Partial<AppearanceSettings>) };
  }
  return { ...DEFAULT_APPEARANCE };
}

export function useAppearance(onNotice?: (message: string) => void) {
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadInitialAppearance);
  const [uploading, setUploading] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void fetch(apiPath('appearance'))
      .then(r => (r.ok ? (r.json() as Promise<AppearanceSettings>) : null))
      .then(remote => {
        if (!active || !remote) return;
        setAppearance(remote);
        writeLocal(STORAGE_KEY, remote);
      })
      .catch(() => {});
    return () => {
      active = false;
      window.clearTimeout(saveTimer.current);
    };
  }, []);

  const persist = useCallback((next: AppearanceSettings) => {
    writeLocal(STORAGE_KEY, next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void fetch(apiPath('appearance'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => {});
    }, 140);
  }, []);

  const updateAppearance = useCallback(
    (patch: Partial<AppearanceSettings>) => {
      setAppearance(prev => {
        const next = { ...prev, ...patch };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const uploadWallpaper = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        onNotice?.('请选择图片文件（PNG / JPG / WebP / GIF / AVIF）');
        return;
      }
      if (file.size > 25 * 1024 * 1024) {
        onNotice?.('图片大小不能超过 25 MB');
        return;
      }
      setUploading(true);
      try {
        const response = await fetch(apiPath('appearance/wallpaper'), {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'image/png',
            'X-Filename': encodeURIComponent(file.name),
          },
          body: file,
        });
        if (!response.ok) {
          const err = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(err?.error ?? `HTTP ${response.status}`);
        }
        const saved = (await response.json()) as AppearanceSettings;
        setAppearance(saved);
        writeLocal(STORAGE_KEY, saved);
        onNotice?.(`已应用自定义背景：${file.name}`);
      } catch (error) {
        onNotice?.(error instanceof Error ? `背景上传失败 · ${error.message}` : '背景上传失败');
      } finally {
        setUploading(false);
      }
    },
    [onNotice],
  );

  const clearWallpaper = useCallback(async () => {
    try {
      const response = await fetch(apiPath('appearance/wallpaper'), { method: 'DELETE' });
      if (response.ok) {
        const saved = (await response.json()) as AppearanceSettings;
        setAppearance(saved);
        writeLocal(STORAGE_KEY, saved);
        onNotice?.('已清除自定义背景图片');
        return;
      }
    } catch {
      // Fallback to local update if offline.
    }
    updateAppearance({ backgroundKind: 'none', wallpaperVersion: undefined, wallpaperName: undefined });
  }, [onNotice, updateAppearance]);

  const resetAppearance = useCallback(() => {
    const next: AppearanceSettings = {
      ...DEFAULT_APPEARANCE,
      wallpaperVersion: appearance.wallpaperVersion,
      wallpaperName: appearance.wallpaperName,
    };
    setAppearance(next);
    persist(next);
    onNotice?.('已恢复默认外观与透明度');
  }, [appearance.wallpaperName, appearance.wallpaperVersion, onNotice, persist]);

  const wallpaperUrl =
    appearance.backgroundKind === 'image' && appearance.wallpaperVersion
      ? `${apiPath('appearance/wallpaper')}?v=${appearance.wallpaperVersion}`
      : undefined;

  return {
    appearance,
    wallpaperUrl,
    uploading,
    updateAppearance,
    uploadWallpaper,
    clearWallpaper,
    resetAppearance,
  };
}
