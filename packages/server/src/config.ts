import os from 'node:os';
import path from 'node:path';

export interface OrreryConfig {
  host: string;
  port: number;
  pollIntervalMs: number;
  processPollIntervalMs: number;
  staleThresholdMs: number;
  recentWindowHours: number;
  t3UserDataDir: string;
  t3CachesDir: string;
  codexDir: string;
  orreryDataDir: string;
  layoutsFilePath: string;
  appearanceFilePath: string;
  webDistDir: string;
  version: string;
}

export function loadConfig(): OrreryConfig {
  const home = os.homedir();
  const t3Root = process.env.ORRERY_T3_DIR ?? path.join(home, '.t3');
  const codexDir = process.env.ORRERY_CODEX_DIR ?? path.join(home, '.codex');
  const orreryDataDir = process.env.ORRERY_DATA_DIR ?? path.join(home, '.orrery');

  // Resolve packages/web/dist relative to packages/server/dist or packages/server/src
  const webDistDir =
    process.env.ORRERY_WEB_DIST ??
    path.resolve(import.meta.dirname, '..', '..', 'web', 'dist');

  return {
    host: process.env.ORRERY_HOST ?? '127.0.0.1',
    port: Number(process.env.ORRERY_PORT ?? 4318),
    pollIntervalMs: Number(process.env.ORRERY_POLL_MS ?? 1000),
    processPollIntervalMs: Number(process.env.ORRERY_PROCESS_POLL_MS ?? 3000),
    staleThresholdMs: Number(process.env.ORRERY_STALE_MS ?? 5 * 60 * 1000),
    recentWindowHours: Number(process.env.ORRERY_RECENT_HOURS ?? 24),
    t3UserDataDir: path.join(t3Root, 'userdata'),
    t3CachesDir: path.join(t3Root, 'caches'),
    codexDir,
    orreryDataDir,
    layoutsFilePath: path.join(orreryDataDir, 'layouts.json'),
    appearanceFilePath: path.join(orreryDataDir, 'appearance.json'),
    webDistDir,
    version: '1.0.0',
  };
}
