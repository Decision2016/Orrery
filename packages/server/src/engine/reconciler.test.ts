import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_PRESETS, type AgentRuntime, type AttentionAlert, type EventEntry, type LayoutsPayload, type ModelUsageEntry, type QuotaWindow,
  type OrrerySnapshot, type ProcessMetric, type SubagentNode, type TaskItem, type TaskStep,
} from '@orrery/shared';
import type { CollectorAdapter, CollectorOutput } from '../adapters/types.js';
import { loadConfig } from '../config.js';
import { createRequestHandler } from '../routes/api.js';
import { LayoutStore, LayoutValidationError } from './layouts.js';
import { reconcileOutputs, type ReconcilerHistory } from './reconciler.js';
import { OrreryStore } from './store.js';
import { TodoStore, TodoValidationError } from './todos.js';

const now = new Date(2026, 7, 10, 12).getTime();
const at = (offset = 0) => new Date(now + offset).toISOString();
const options = { nowMs: now, staleThresholdMs: 300_000, serverVersion: 'test' };
const tokens = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });

function task(id: string, changes: Partial<TaskItem> = {}): TaskItem {
  return {
    id, externalIds: {}, source: 't3', sourceLabel: 'T3 Code', provider: 'codex', title: id, status: 'running',
    startedAt: at(-60_000), updatedAt: at(), durationMs: 60_000, pendingApprovals: 0, pendingInputs: 0,
    hasActionablePlan: false, recentSteps: [], subagents: [], ...changes,
  };
}

function output(adapterId: string, fields: Partial<CollectorOutput> = {}): CollectorOutput {
  return { adapterId, collectedAt: at(), ok: true, agents: [], tasks: [], events: [], alerts: [], scheduled: [], quotas: [], ...fields };
}

function agent(id: string): AgentRuntime {
  return { id, name: id, status: 'online', runningCount: 0, waitingCount: 0, queuedCount: 0, subagentCount: 0,
    cpuPercent: 0, memoryMb: 0, processCount: 0, pids: [], lastSeenAt: at() };
}

function proc(agentId: string, pid: number, cpuPercent = 1, memoryMb = 16): ProcessMetric {
  return { agentId, pid, ppid: 1, name: agentId, role: 'main', cpuPercent, memoryMb };
}

function event(id: string, offset = 0): EventEntry {
  return { id, timestamp: at(offset), source: 't3', level: 'info', summary: id };
}

test('native thread IDs join across sources, retaining T3 ownership and Codex telemetry', () => {
  const node: SubagentNode = { id: 't3:review', childThreadId: 'review', status: 'running', provider: 'codex',
    startedAt: at(), durationMs: 0, title: 'Review' };
  const step: TaskStep = { id: 'step', kind: 'command', label: 'Old label', status: 'running', startedAt: at() };
  const owner = task('t3:owner', {
    externalIds: { t3ThreadId: 'owner', t3RunId: 'run', codexThreadId: 'native' }, title: 'Orrery launch',
    cwd: 'C:/project', worktreePath: 'C:/worktrees/orrery', project: 'Observatory', linkedPrUrl: 'https://example.test/pr/7',
    tokens: { ...tokens(8), contextPercent: 42, contextWindow: 128_000 }, pendingApprovals: 2, pendingInputs: 1,
    subagents: [node], recentSteps: [step], currentStep: 'Starting', updatedAt: at(-500),
  });
  const native = task('codex:native', {
    externalIds: { codexThreadId: 'native', rolloutPath: 'session.jsonl' }, source: 'codex-cli', cwd: 'C:/another',
    startedAt: at(-600_000), tokens: { ...tokens(40), cachedInputTokens: 9 }, currentStep: 'Building', model: 'test-model',
    reasoningEffort: 'high', recentSteps: [{ ...step, label: 'Build' }],
    subagents: [{ ...node, id: 'native:review', title: 'Native duplicate' }, { ...node, id: 'other', childThreadId: 'other' }],
  });
  const inputAlert: AttentionAlert = { id: 'prompt', taskId: native.id, source: native.source, sourceLabel: 'Codex',
    title: 'Choose an option', kind: 'user_input', severity: 'warning', createdAt: at(), ageMs: 0 };
  const segment = { id: 't3:run', taskId: owner.id, label: 'run', source: owner.source, provider: 'codex',
    status: owner.status, startedAt: owner.startedAt, endedAt: owner.updatedAt, isActive: true };
  const snapshot = reconcileOutputs([
    output('t3', { tasks: [owner], todayTokens: 18, agents: [agent('t3')], timeline: [segment], events: [event('same', -500)] }),
    output('codex', { tasks: [native], todayTokens: 45, alerts: [inputAlert], events: [{ ...event('same'), taskId: native.id }],
      timeline: [{ ...segment, id: 'codex:session', taskId: native.id }] }),
  ], options);
  assert.equal(snapshot.tasks.length, 1);
  const [merged] = snapshot.tasks;
  assert.deepEqual([merged.id, merged.source, merged.sourceLabel, merged.title, merged.project, merged.worktreePath, merged.linkedPrUrl],
    [owner.id, 't3-codex', 'T3 → Codex', owner.title, owner.project, owner.worktreePath, owner.linkedPrUrl]);
  assert.deepEqual(merged.externalIds, { ...owner.externalIds, rolloutPath: 'session.jsonl' });
  assert.deepEqual(merged.tokens, { ...native.tokens, contextWindow: 128_000, contextPercent: 42 });
  assert.deepEqual([merged.pendingApprovals, merged.status, merged.currentStep, merged.model, merged.reasoningEffort],
    [2, 'waiting_approval', 'Building', 'test-model', 'high']);
  assert.deepEqual(merged.recentSteps.map(s => s.label), ['Build']);
  assert.deepEqual(merged.subagents.map(s => s.id), ['t3:review', 'other']);
  assert.equal(owner.status, 'running');
  assert.deepEqual(snapshot.events.map(e => [e.id, e.taskId, e.taskTitle]), [['same', owner.id, owner.title]]);
  assert.deepEqual(snapshot.timeline.map(s => [s.id, s.taskId, s.status]), [['t3:run', owner.id, 'waiting_approval']]);
  assert.deepEqual(snapshot.alerts.map(a => [a.kind, a.taskId]), [['approval', owner.id], ['user_input', owner.id]]);
  assert.equal(snapshot.agents[0].waitingCount, 1);
  assert.equal(snapshot.summary.activeSubagents, 2);
  assert.equal(snapshot.summary.todayTokens, 55);
});

test('origin fallback normalizes Windows cwd, enforces the 120-second window, and reserves exact matches first', () => {
  const common = { cwd: 'C:/Work/Orrery/', startedAt: at(-600_000) };
  const owner = task('fallback', common);
  const exact = task('reserved', { ...common, startedAt: at(-480_000), externalIds: { codexThreadId: 'exact' } });
  const native = task('rollout', { source: 't3-codex', externalIds: { codexThreadId: 'other' },
    cwd: '\\\\?\\c:\\work\\ORRERY', startedAt: at(-480_000), model: 'fallback-model' });
  const cases = [
    native, task('exact-rollout', { source: 'codex-app', externalIds: { codexThreadId: 'exact' }, model: 'exact-model' }),
    task('cli', { ...common, source: 'codex-cli' }), task('distant', { ...native, id: 'distant', startedAt: at(-479_999) }),
    task('other-cwd', { ...native, id: 'other-cwd', cwd: 'C:/unrelated' }),
  ];
  const snapshot = reconcileOutputs([output('codex', { tasks: cases }), output('t3', { tasks: [owner, exact] })], options);
  assert.deepEqual(snapshot.tasks.map(t => t.id).sort(), ['cli', 'distant', 'fallback', 'other-cwd', 'reserved']);
  assert.equal(snapshot.tasks.find(t => t.id === 'reserved')?.model, 'exact-model');
  assert.equal(snapshot.tasks.find(t => t.id === 'fallback')?.model, 'fallback-model');
  for (const change of [{ provider: 'claude' }, { cwd: undefined }, { startedAt: at(-600_001) }]) {
    const negative = reconcileOutputs([output('both', { tasks: [{ ...owner, ...change }, native] })], options);
    assert.equal(negative.tasks.length, 2);
  }
});

test('child thread bindings join native subagent IDs to their T3 nodes', () => {
  const child: SubagentNode = { id: 'node', childThreadId: 'child-t3', title: 'Review', provider: 'codex',
    startedAt: at(), durationMs: 0, status: 'running' };
  const snapshot = reconcileOutputs([output('t3', { tasks: [
    task('parent', { externalIds: { codexThreadId: 'parent-native' }, subagents: [child] }),
    task('child', { externalIds: { t3ThreadId: 'child-t3', codexThreadId: 'child-native' } }),
  ] }), output('codex', { tasks: [task('native', { source: 'codex-app', externalIds: { codexThreadId: 'parent-native' },
    subagents: [{ ...child, id: 'edge', childThreadId: 'child-native' }] })] })], options);
  assert.deepEqual(snapshot.tasks.find(t => t.id === 'parent')?.subagents, [child]);
  assert.equal(snapshot.summary.activeSubagents, 1);
});

test('live processes, inactivity, and pending requests determine status; alerts sort by severity and time', () => {
  const tasks = [
    task('live'), task('idle', { updatedAt: at(-300_001) }), task('offline', { source: 'codex-app' }),
    task('input', { source: 'codex-app', pendingInputs: 1, updatedAt: at(-600_000) }),
    task('approval', { pendingApprovals: 1, pendingInputs: 1, hasActionablePlan: true, updatedAt: at(-100) }),
    task('failed', { status: 'failed', errorMessage: 'Build failed', completedAt: at(-20) }),
    task('older-failure', { status: 'failed', completedAt: at(-7 * 3_600_000) }),
    task('ancient-failure', { status: 'failed', completedAt: at(-25 * 3_600_000) }),
  ];
  const alert: AttentionAlert = { id: 'imported', taskId: 'background', source: 't3', sourceLabel: 'T3',
    kind: 'stale', title: 'Aged session', severity: 'warning', createdAt: at(-300), ageMs: 0 };
  const snapshot = reconcileOutputs([
    output('agents', { tasks, agents: [agent('t3'), agent('codex')], alerts: [alert, { ...alert, createdAt: at(-400) }] }),
    output('process', { processes: [proc('t3', 10, 2, 30), proc('t3', 11, 4, 60), proc('t3', 11, 4, 60),
      proc('claude-code', 20), proc('opencode', 21)] }),
  ], options);
  const t3 = snapshot.agents.find(a => a.id === 't3')!;
  assert.deepEqual([t3.cpuPercent, t3.memoryMb, t3.pids, t3.processCount], [6, 90, [10, 11], 2]);
  assert.deepEqual([t3.cpuHistory, t3.memoryHistory], [[6], [90]]);
  assert.ok(snapshot.agents.some(a => a.id === 'claude-code' && a.processCount === 1));
  assert.ok(snapshot.agents.some(a => a.id === 'opencode' && a.processCount === 1));
  assert.deepEqual(snapshot.tasks.filter(t => t.isStale).map(t => t.id), ['offline', 'idle']);
  assert.equal(snapshot.tasks.find(t => t.id === 'input')?.status, 'waiting_input');
  assert.equal(snapshot.tasks.find(t => t.id === 'approval')?.status, 'waiting_approval');
  assert.deepEqual(snapshot.summary, { runningCount: 1, waitingCount: 2, queuedCount: 0, failed24hCount: 2,
    completed24hCount: 0, todayTokens: 0, activeSubagents: 0 });
  assert.deepEqual(snapshot.alerts.filter(a => a.severity === 'critical').map(a => a.taskId), ['failed', 'approval']);
  assert.ok(snapshot.alerts.slice(2).every(a => a.severity === 'warning'));
  assert.deepEqual(snapshot.alerts.slice(2).map(a => a.createdAt), snapshot.alerts.slice(2).map(a => a.createdAt).sort().reverse());
  assert.equal(snapshot.alerts.filter(a => a.id === 'imported').length, 1);
  assert.deepEqual(snapshot.alerts.filter(a => a.kind === 'stale').map(a => a.taskId).sort(), ['background', 'idle', 'offline']);
  assert.ok(snapshot.alerts.some(a => a.kind === 'proposed_plan'));
});

test('rolling histories count unique process samples and actual token deltas without charging old sessions on discovery', () => {
  const history: ReconcilerHistory = {};
  const sample = (i: number, counter = 100 + 15 * i) => {
    const offset = i * 15_000;
    return reconcileOutputs([output('t3', {
      collectedAt: at(offset), agents: [agent('t3')], processes: [proc('t3', 10, i, i + 5)],
      tasks: [task('measured', { tokens: tokens(counter), updatedAt: at(offset) }),
        ...(i ? [task('yesterday', { tokens: tokens(8000), startedAt: at(-86_400_000), updatedAt: at(offset) })] : [])],
    })], { ...options, nowMs: now + offset, history });
  };
  const first = sample(0);
  sample(0);
  let last = first;
  for (let i = 1; i <= 64; i++) last = sample(i);
  assert.deepEqual(first.agents[0].cpuHistory, [0]);
  assert.equal(first.tokenHistory.length, 1);
  assert.equal(last.agents[0].cpuHistory?.length, 30);
  assert.equal(last.agents[0].cpuHistory?.[0], 35);
  assert.equal(last.agents[0].memoryHistory?.at(-1), 69);
  assert.equal(last.tokenHistory.length, 60);
  assert.ok(last.tokenHistory.every(p => p.tokensPerMin === 60 && p.activeTasks === 2));
  assert.equal(last.summary.todayTokens, 1060);
  assert.equal(sample(65, 10).tokenHistory.at(-1)?.tokensPerMin, 0);
});

test('daily usage survives eviction, joins sessions lacking native IDs, and resets at local midnight', () => {
  const history: ReconcilerHistory = {};
  const t3 = task('owner', { cwd: 'C:/project', tokens: tokens(25) });
  const orphan = task('rollout', { cwd: 'C:/project', source: 't3-codex', tokens: tokens(40) });
  const inputs = [output('t3', { tasks: [t3] }), output('codex', { tasks: [orphan] })];
  const joined = reconcileOutputs(inputs, { ...options, history });
  assert.equal(joined.summary.todayTokens, 40);
  assert.equal(reconcileOutputs([], { ...options, history }).summary.todayTokens, 40);
  assert.equal(reconcileOutputs([], { ...options, nowMs: now + 86_400_000, history }).summary.todayTokens, 0);
});

test('model usage prefers native reports, sorts by both totals, and counts each source once in daily usage and history', () => {
  const model = (providerId: string, id: string, todayTokens: number, tokens24h: number): ModelUsageEntry => ({
    providerId, providerName: providerId, model: id, todayTokens, tokens24h, inputTokens24h: tokens24h,
    cachedTokens24h: 0, outputTokens24h: 0, calls24h: 1, sessions24h: 1, lastUsedAt: at(),
  });
  const codex = model('codex', 'gpt-test', 70, 100), gemini = model('antigravity', 'gemini-test', 20, 120);
  const pi = model('pi', 'shared-name', 40, 200), grok = model('grok', 'shared-name', 30, 200);
  const t3 = output('t3', { modelUsage: [
    { ...codex, todayTokens: 500, tokens24h: 500 }, { ...gemini, todayTokens: 800, tokens24h: 1000 }, grok, pi,
  ], tasks: [task('wrapped', { provider: 'antigravity', tokens: tokens(800) }),
    task('pi-task', { provider: 'pi', model: pi.model, tokens: tokens(90) }), task('other', { provider: 'other', tokens: tokens(9) })] });
  const reports = [t3, output('codex', { modelUsage: [codex], todayTokens: 75 }),
    output('antigravity', { modelUsage: [gemini], todayTokens: 20 }),
    output('mirror', { modelUsage: [{ ...pi, tokens24h: 150 }] })];
  const history: ReconcilerHistory = {};
  const snapshot = reconcileOutputs(reports, { ...options, history });
  assert.deepEqual(snapshot.modelUsage, [pi, grok, gemini, codex]);
  assert.equal(snapshot.summary.todayTokens, 174);
  const updated = [...reports];
  updated[2] = output('antigravity', { collectedAt: at(15_000), modelUsage: [{ ...gemini, todayTokens: 30, tokens24h: 130 }], todayTokens: 30 });
  const next = reconcileOutputs(updated, { ...options, history, nowMs: now + 15_000 });
  assert.equal(next.summary.todayTokens, 184);
  assert.equal(next.tokenHistory.at(-1)?.tokensPerMin, 40);
  const tomorrow = reconcileOutputs(updated, { ...options, history, nowMs: now + 86_400_000 });
  assert.ok(tomorrow.modelUsage.every(entry => entry.todayTokens === 0));
  assert.equal(tomorrow.summary.todayTokens, 0);
});

test('quota reconciliation uses measurement time and drops local placeholders once a measured window exists', () => {
  const quota = (windowId: string, sourceMode: QuotaWindow['sourceMode'], usedPercent: number, age: number): QuotaWindow => ({
    providerId: 'codex', providerName: 'Codex', windowId, label: windowId, usedPercent, sourceMode, checkedAt: at(age),
  });
  const local = { ...quota('local-safe', 'local-only', 0, 0), providerId: 'antigravity', unavailableReason: 'Local usage only' };
  const snapshot = reconcileOutputs([
    output('t3', { quotas: [quota('primary', 'official-cache', 1, -50), quota('secondary', 'official-cache', 10, -10), local] }),
    output('codex', { collectedAt: at(-20), quotas: [quota('primary', 'passive-log', 25, -20), quota('secondary', 'passive-log', 50, -30)] }),
    output('other', { quotas: [quota('primary', 'local-only', 0, 0), quota('local-safe', 'local-only', 0, 0),
      { ...local, checkedAt: at(-100) }] }),
  ], options);
  assert.deepEqual(snapshot.quotas.map(q => [q.providerId, q.windowId, q.sourceMode, q.remainingPercent]), [
    ['codex', 'secondary', 'official-cache', 90], ['codex', 'primary', 'passive-log', 75], ['antigravity', 'local-safe', 'local-only', undefined],
  ]);
  assert.equal(snapshot.quotas[2].unavailableReason, 'Local usage only');
});

test('summary includes tasks outside display limits and queue entries, while timeline and event lists stay bounded', () => {
  const done = Array.from({ length: 90 }, (_, i) => task('done-' + i, {
    status: 'completed', startedAt: at(-60_000 - i), completedAt: at(-i), updatedAt: at(-i), tokens: tokens(2),
  }));
  const events = Array.from({ length: 205 }, (_, i) => event('e-' + i, -i));
  const scheduled = { id: 'queue-message', kind: 'queued_item', status: 'queued', title: 'Later', source: 'codex' } as const;
  const snapshot = reconcileOutputs([output('t3', { tasks: [...done, task('now'), task('queue', { status: 'queued' }),
    task('yesterday', { status: 'completed', startedAt: at(-100_000_000), updatedAt: at(-90_000_000) })],
    events: [...events, event('e-0', -1000)], scheduled: [scheduled, scheduled] })], options);
  assert.equal(snapshot.tasks.length, 80);
  assert.deepEqual(snapshot.tasks.slice(0, 3).map(t => t.id), ['now', 'queue', 'done-0']);
  assert.equal(snapshot.summary.completed24hCount, 90);
  assert.equal(snapshot.summary.todayTokens, 180);
  assert.equal(snapshot.summary.queuedCount, 2);
  assert.equal(snapshot.timeline.length, 40);
  assert.ok(snapshot.timeline.every(s => s.taskId !== 'yesterday'));
  assert.deepEqual(snapshot.events.map(e => e.id), events.slice(0, 200).map(e => e.id));
});

test('LayoutStore merges clean overrides, persists atomically, and preserves valid data after a rejected save', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orrery-layout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'layouts.json');
  const store = new LayoutStore(file);
  const initial = await store.load();
  assert.deepEqual(initial.presets, DEFAULT_PRESETS);
  const custom = { ...initial.presets[0], id: 'custom', name: 'Work', builtIn: false };
  const overridden = { ...initial.presets[1], name: 'Edited wallboard', builtIn: false };
  const saved = await store.save({ activePresetId: custom.id, presets: [custom, overridden] });
  assert.equal(saved.presets.length, DEFAULT_PRESETS.length + 1);
  assert.ok(saved.presets.find(p => p.id === overridden.id)?.builtIn);
  assert.equal(saved.presets.find(p => p.id === overridden.id)?.name, 'Edited wallboard');
  assert.deepEqual(await new LayoutStore({ layoutsFilePath: file }).load(), saved);
  for (const change of [{ rows: 0 }, { columns: 0.5 }, { items: [{ ...custom.items[0], x: NaN }] },
    { items: [{ ...custom.items[0], type: 'constructor' }] }, { items: [{ ...custom.items[0], h: Infinity }] }]) {
    await assert.rejects(store.save({ activePresetId: 'custom', presets: [{ ...custom, ...change }] }), LayoutValidationError);
  }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
  const alternatives = await Promise.all(Array.from({ length: 12 }, (_, i) => 'Board ' + i).map(name => store.save({
    activePresetId: custom.id, presets: [{ ...custom, name }],
  })));
  const persisted = await store.load();
  assert.deepEqual(persisted, alternatives.at(-1));
  assert.deepEqual(await readdir(path.dirname(file)), ['layouts.json']);
  await writeFile(file, JSON.stringify({ activePresetId: 'missing', presets: [custom, { id: overridden.id }] }));
  assert.deepEqual((await store.load()).presets, [...DEFAULT_PRESETS, custom]);
  assert.equal((await store.load()).activePresetId, DEFAULT_PRESETS[0].id);
  await writeFile(file, '{');
  assert.deepEqual(await store.load(), initial);
});

test('polling isolates slow collectors, retains incremental events, recovers health, and drains before disposal', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release: (value: CollectorOutput) => void;
  let calls = 0, fastCalls = 0, disposals = 0;
  const slow: CollectorAdapter = { id: 'slow', name: 'Slow', intervalMs: 100, collect: async () => {
    calls++;
    if (calls === 2) throw new Error('Temporarily unavailable');
    if (calls === 3) return output('slow');
    return new Promise<CollectorOutput>(resolve => { release = resolve; });
  }, dispose: () => { disposals++; } };
  const fast: CollectorAdapter = { id: 'fast', name: 'Fast', intervalMs: 25, collect: async () => { fastCalls++; return output('fast'); } };
  const store = new OrreryStore([slow, fast], { ...loadConfig(), pollIntervalMs: 25 });
  const updates: OrrerySnapshot[] = [];
  const unsubscribe = store.subscribe(snapshot => updates.push(snapshot));
  const start = store.start();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.ok(fastCalls >= 2);
  release!(output('slow', { events: [event('cursor-event')] }));
  await start;
  assert.ok(store.getHealth().collectors[0].lastOkAt);
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getHealth().collectors[0].lastError, 'Temporarily unavailable');
  t.mock.timers.tick(100);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(25);
  assert.equal(store.getHealth().collectors[0].ok, true);
  assert.equal(store.getHealth().collectors[0].lastError, undefined);
  assert.deepEqual(store.getSnapshot().events.map(e => e.id), ['cursor-event']);
  assert.ok(updates.length > 1);
  unsubscribe();
  t.mock.timers.tick(75);
  assert.equal(calls, 4);
  const stopping = store.stop();
  assert.equal(disposals, 0);
  t.mock.timers.tick(1000);
  assert.equal(calls, 4);
  release!(output('slow'));
  await stopping;
  await store.stop();
  assert.equal(disposals, 1);
});

test('HTTP API, streaming, local actions, and static wallboard routes', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orrery-http-'));
  const webDistDir = path.join(dir, 'dist');
  await mkdir(webDistDir);
  await writeFile(path.join(webDistDir, 'index.html'), '<main>Orrery</main>');
  await writeFile(path.join(webDistDir, 'app.js'), 'export default 42');
  const config = {
    ...loadConfig(),
    webDistDir,
    layoutsFilePath: path.join(dir, 'data', 'layouts.json'),
    todosFilePath: path.join(dir, 'data', 'todos.json'),
    pollIntervalMs: 40,
  };
  const archived = Array.from({ length: 85 }, (_, i) => task('detail:' + i, { status: 'completed', updatedAt: at(-i) }));
  const fixture: CollectorAdapter = { id: 'fixture', name: 'Fixture', intervalMs: 60_000,
    collect: async () => output('fixture', { tasks: archived }) };
  const todoStore = new TodoStore(config);
  const store = new OrreryStore([fixture], config, todoStore);
  await store.start();
  const server = createServer(createRequestHandler({ store, layoutStore: new LayoutStore(config), todoStore, config }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    await store.stop();
    server.closeAllConnections();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port;

  await t.test('health, CORS, snapshot and task details', async () => {
    const res = await fetch(base + '/api/health', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
    const health = await res.json() as ReturnType<OrreryStore['getHealth']>;
    assert.ok(health.ok && health.startedAt && health.uptimeSec >= 0);
    assert.equal(health.collectors[0].ok, true);
    assert.equal(typeof health.collectors[0].durationMs, 'number');
    const preflight = await fetch(base + '/api/layouts', { method: 'OPTIONS', headers: { Origin: base } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), base);
    assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'http://localhost.example.test' } })).status, 403);
    const snapshot = await (await fetch(base + '/api/snapshot')).json() as OrrerySnapshot;
    assert.equal(snapshot.tasks.length, 80);
    const detail = await (await fetch(base + '/api/tasks/detail%3A84')).json() as TaskItem;
    assert.equal(detail.id, 'detail:84');
    assert.equal((await fetch(base + '/api/tasks/unknown')).status, 404);
  });

  await t.test('layout GET/PUT, malformed JSON and bounded request bodies', async () => {
    const layouts = await (await fetch(base + '/api/layouts')).json() as LayoutsPayload;
    const put = (body: string) => fetch(base + '/api/layouts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    const custom = { ...layouts.presets[0], id: 'operator', name: 'Operator' };
    const saved = await put(JSON.stringify({ activePresetId: custom.id, presets: [custom] }));
    assert.equal(saved.status, 200);
    const payload = await saved.json() as LayoutsPayload;
    assert.equal(payload.activePresetId, custom.id);
    assert.deepEqual(await (await fetch(base + '/api/layouts')).json(), payload);
    assert.equal((await put('{')).status, 400);
    assert.equal((await put('{"presets":false}')).status, 400);
    assert.equal((await put('x'.repeat(1024 * 1024 + 1))).status, 413);
    const chunked = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + '/api/layouts', { method: 'PUT' }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.write(Buffer.alloc(1024 * 1024));
      req.end('x');
    });
    assert.equal(chunked, 413);
  });

  await t.test('SSE sends the initial snapshot, updates, and heartbeats', async sub => {
    sub.mock.timers.enable({ apis: ['setInterval'] });
    const res = await fetch(base + '/api/stream', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const reader = res.body!.getReader();
    let buffered = '';
    const decoder = new TextDecoder();
    const next = async (name: string) => {
      while (true) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (frame.startsWith('event: ' + name + '\n')) return JSON.parse(frame.split('\ndata: ')[1]);
        } else {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          buffered += decoder.decode(chunk.value, { stream: true });
        }
      }
    };
    try {
      const initial: OrrerySnapshot = await next('snapshot');
      assert.equal(initial.tasks[0].id, archived[0].id);
      const update: OrrerySnapshot = await next('snapshot');
      assert.ok(update.generatedAt >= initial.generatedAt);
      sub.mock.timers.tick(15_000);
      const heartbeat: { timestamp: string } = await next('heartbeat');
      assert.ok(Number.isFinite(Date.parse(heartbeat.timestamp)));
    } finally {
      await reader.cancel();
    }
  });

  await t.test('static MIME types and SPA fallback, with validation of asset paths and OS actions', async () => {
    const js = await fetch(base + '/app.js?v=1');
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await js.text(), 'export default 42');
    assert.equal(await (await fetch(base + '/wallboard/inspector')).text(), '<main>Orrery</main>');
    assert.equal((await fetch(base + '/api/unknown')).status, 404);
    assert.equal((await fetch(base + '/..%5Cprivate')).status, 403);
    assert.equal((await fetch(base + '/%00')).status, 400);
    const action = (name: string, body: unknown) => fetch(base + '/api/actions/' + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const url of ['file:///test', 'javascript:void(0)', 'https://example.test/?a=1&b=2', 'not a URL']) {
      assert.equal((await action('open-url', { url })).status, 400);
    }
    assert.equal((await action('open-folder', { path: path.join(webDistDir, 'app.js') })).status, 400);
    assert.equal((await action('open-folder', { path: path.join(dir, 'missing') })).status, 400);
  });

  await t.test('valid actions pass separate arguments to detached Windows launchers', async sub => {
    const launches: unknown[][] = [];
    let detached = 0;
    const mock = sub.mock.method(childProcess, 'spawn', (...args: unknown[]) => {
      launches.push(args);
      const child = Object.assign(new EventEmitter(), { unref: () => detached++ });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    syncBuiltinESMExports();
    sub.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const url = 'https://example.test/thread/1';
    for (const [route, body] of [['open-folder', { path: path.toNamespacedPath(webDistDir) }], ['open-url', { url }]] as const) {
      const res = await fetch(base + '/api/actions/' + route, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 200);
    }
    const launchOptions = { detached: true, stdio: 'ignore', windowsHide: true };
    assert.deepEqual(launches, [['explorer.exe', [await realpath(webDistDir)], launchOptions],
      ['cmd.exe', ['/c', 'start', '', url], launchOptions]]);
    assert.equal(detached, 2);
  });

  await t.test('Todo API supports Agent upsert, status patching, batch sync, SSE updates, and direct file writes', async () => {
    const initial = await (await fetch(base + '/api/todos')).json() as { items: unknown[]; filePath: string };
    assert.deepEqual(initial.items, []);
    assert.equal(initial.filePath, config.todosFilePath);

    const createdRes = await fetch(base + '/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'agent-step-1', title: 'Write release notes', status: 'running', priority: 'p1', agent: 'Codex', description: 'v0.0.1' }),
    });
    assert.equal(createdRes.status, 201);
    const created = await createdRes.json() as { created: boolean; item: { id: string; status: string; priority: string; note?: string } };
    assert.equal(created.created, true);
    assert.deepEqual([created.item.id, created.item.status, created.item.priority, created.item.note], ['agent-step-1', 'in_progress', 'high', 'v0.0.1']);
    assert.equal(store.getSnapshot().todos[0]?.id, 'agent-step-1');

    const patchedRes = await fetch(base + '/api/todos/agent-step-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(patchedRes.status, 200);
    const patched = await patchedRes.json() as { item: { status: string; completedAt?: string } };
    assert.equal(patched.item.status, 'done');
    assert.ok(patched.item.completedAt);

    assert.equal((await fetch(base + '/api/todos/missing', { method: 'PATCH', body: '{}' })).status, 404);
    assert.equal((await fetch(base + '/api/todos', { method: 'POST', body: '{"title":""}' })).status, 400);

    const batchRes = await fetch(base + '/api/todos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: 't-done', title: 'Done item', status: 'done' }, { id: 't-active', title: 'Active item', status: 'in_progress', priority: 'critical' }]),
    });
    assert.equal(batchRes.status, 200);
    const batch = await batchRes.json() as { items: { id: string }[] };
    assert.deepEqual(batch.items.map(i => i.id), ['t-active', 't-done']);

    const cleared = await (await fetch(base + '/api/todos', { method: 'DELETE' })).json() as { removed: number; items: { id: string }[] };
    assert.equal(cleared.removed, 1);
    assert.deepEqual(cleared.items.map(i => i.id), ['t-active']);

    await writeFile(config.todosFilePath, JSON.stringify([{ title: 'Direct file todo', status: 'pending', agent: 'Antigravity' }]));
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(store.getSnapshot().todos[0]?.title, 'Direct file todo');

    await assert.rejects(todoStore.upsert({ title: 'Bad', status: 'unknown' }), TodoValidationError);
  });
});
