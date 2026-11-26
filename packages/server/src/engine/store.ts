import type { OrrerySnapshot } from '@orrery/shared';
import type { CollectorAdapter, CollectorOutput } from '../adapters/types.js';
import type { OrreryConfig } from '../config.js';
import { latestEvents, reconcileOutputs, type ReconcilerHistory } from './reconciler.js';

interface CollectorHealth {
  id: string;
  name: string;
  intervalMs: number;
  ok: boolean;
  lastOkAt?: string;
  lastError?: string;
  durationMs?: number;
}

export class OrreryStore {
  private readonly started = Date.now();
  private readonly history: ReconcilerHistory = {};
  private readonly outputs = new Map<string, CollectorOutput>();
  private readonly collectors: CollectorHealth[];
  private readonly listeners = new Map<(snapshot: OrrerySnapshot) => void, (() => void) | undefined>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private startup?: Promise<void>;
  private shutdown?: Promise<void>;
  private snapshot: OrrerySnapshot;

  constructor(private readonly adapters: CollectorAdapter[], private readonly config: OrreryConfig) {
    this.collectors = adapters.map(({ id, name, intervalMs }) => ({ id, name, intervalMs, ok: false }));
    this.snapshot = reconcileOutputs([], { staleThresholdMs: config.staleThresholdMs, serverVersion: config.version });
  }

  getSnapshot() {
    return this.snapshot;
  }

  getTask(id: string) {
    return this.history.tasksById?.get(id);
  }

  getHealth() {
    return {
      ok: true, version: this.config.version, uptimeSec: (Date.now() - this.started) / 1000,
      startedAt: new Date(this.started).toISOString(), collectors: this.collectors.map(health => ({ ...health })),
    };
  }

  subscribe(listener: (snapshot: OrrerySnapshot) => void, onStop?: () => void) {
    this.listeners.set(listener, onStop);
    return () => this.listeners.delete(listener);
  }

  private tick() {
    const outputs = this.adapters.flatMap(adapter => {
      const output = this.outputs.get(adapter.id);
      return output ? [output] : [];
    });
    this.snapshot = reconcileOutputs(outputs, {
      staleThresholdMs: this.config.staleThresholdMs, serverVersion: this.config.version, history: this.history,
    });
    this.listeners.forEach((_, listener) => listener(this.snapshot));
  }

  private poll(adapter: CollectorAdapter, health: CollectorHealth) {
    const pending = this.inFlight.get(adapter.id);
    if (pending) return pending;
    const run = (async () => {
      const start = performance.now();
      try {
        const output = await adapter.collect();
        // Some collectors advance a cursor and only return events since the previous poll.
        const previous = this.outputs.get(adapter.id);
        this.outputs.set(adapter.id, previous?.events.length
          ? { ...output, events: latestEvents([...output.events, ...previous.events]) }
          : output);
        health.ok = output.ok;
        if (output.ok) {
          health.lastOkAt = output.collectedAt;
          delete health.lastError;
        } else {
          health.lastError = output.error ?? 'Collection failed';
        }
      } catch (error) {
        health.ok = false;
        health.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        health.durationMs = Math.round(performance.now() - start);
      }
    })().finally(() => this.inFlight.delete(adapter.id));
    this.inFlight.set(adapter.id, run);
    return run;
  }

  start(): Promise<void> {
    if (this.shutdown) return this.shutdown.then(() => this.start());
    if (this.startup) return this.startup;
    const initial = this.adapters.map((adapter, i) => {
      const poll = () => this.poll(adapter, this.collectors[i]);
      this.timers.push(setInterval(poll, adapter.intervalMs));
      return poll();
    });
    this.timers.push(setInterval(() => this.tick(), this.config.pollIntervalMs));
    this.startup = Promise.all(initial).then(() => { if (this.timers.length) this.tick(); });
    return this.startup;
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.listeners.forEach(onStop => onStop?.());
    this.listeners.clear();
    if (!this.startup) return Promise.resolve();
    this.shutdown = Promise.all(this.inFlight.values())
      .then(() => Promise.all(this.adapters.map(async adapter => adapter.dispose?.())))
      .then(() => {})
      .finally(() => { this.startup = undefined; this.shutdown = undefined; });
    return this.shutdown;
  }
}
