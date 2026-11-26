import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PRESETS, WIDGET_CATALOG, type LayoutPreset, type LayoutsPayload } from '@orrery/shared';
import type { OrreryConfig } from '../config.js';

export class LayoutValidationError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPreset(preset: unknown): preset is LayoutPreset {
  const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;
  if (!record(preset) || typeof preset.id !== 'string' || !preset.id.trim() ||
      typeof preset.name !== 'string' || !preset.name.trim() || typeof preset.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(preset.updatedAt)) || !positiveInteger(preset.columns) || !positiveInteger(preset.rows) ||
      (preset.builtIn !== undefined && typeof preset.builtIn !== 'boolean') ||
      (preset.description !== undefined && typeof preset.description !== 'string') || !Array.isArray(preset.items)) return false;
  const ids = new Set<string>();
  return preset.items.every((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
        typeof item.type !== 'string' || !Object.hasOwn(WIDGET_CATALOG, item.type)) return false;
    ids.add(item.id);
    return ['x', 'y', 'w', 'h'].every(key => typeof item[key] === 'number' && Number.isFinite(item[key]) &&
      (key === 'x' || key === 'y' ? item[key] >= 0 : item[key] > 0)) &&
      ['minW', 'minH', 'maxW', 'maxH'].every(key => item[key] === undefined || positiveInteger(item[key])) &&
      (item.title === undefined || typeof item.title === 'string');
  });
}

function mergeLayouts(value: unknown, strict: boolean): LayoutsPayload {
  const presets = new Map(structuredClone(DEFAULT_PRESETS).map(preset => [preset.id, preset]));
  let activePresetId = DEFAULT_PRESETS[0].id;
  if (record(value) && Array.isArray(value.presets)) {
    const seen = new Set<string>();
    for (const preset of value.presets) {
      if (!validPreset(preset) || seen.has(preset.id)) {
        if (strict) throw new LayoutValidationError('Invalid layout preset, grid dimensions, or widget.');
        continue;
      }
      seen.add(preset.id);
      presets.set(preset.id, presets.has(preset.id) ? { ...preset, builtIn: true } : preset);
    }
    if (typeof value.activePresetId === 'string' && presets.has(value.activePresetId)) activePresetId = value.activePresetId;
    else if (strict) throw new LayoutValidationError('Choose an existing active preset.');
  } else if (strict) {
    throw new LayoutValidationError('Expected an activePresetId and a presets array.');
  }
  return { activePresetId, presets: [...presets.values()] };
}

export class LayoutStore {
  private readonly filePath: string;
  private pendingWrite = Promise.resolve();

  constructor(config: Pick<OrreryConfig, 'layoutsFilePath'> | string) {
    this.filePath = typeof config === 'string' ? config : config.layoutsFilePath;
  }

  async load(): Promise<LayoutsPayload> {
    try {
      return mergeLayouts(JSON.parse(await readFile(this.filePath, 'utf8')), false);
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return mergeLayouts(null, false);
      throw error;
    }
  }

  async save(payload: unknown): Promise<LayoutsPayload> {
    const layouts = mergeLayouts(payload, true);
    const write = this.pendingWrite.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = this.filePath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify(layouts, null, 2) + '\n', 'utf8');
        await rename(temp, this.filePath);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.pendingWrite = write.catch(() => {});
    await write;
    return layouts;
  }
}
