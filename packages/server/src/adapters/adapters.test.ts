import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../config.js';
import { ClaudeCodeDetectorAdapter, CodexAdapter, createDefaultAdapters, OpenCodeDetectorAdapter, ProcessAdapter, T3Adapter } from './registry.js';
import { normalizeWindowsPath, withReadOnlyDb } from './sqlite.js';
import type { CollectorOutput } from './types.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orrery-adapters-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { ...loadConfig(), t3UserDataDir: path.join(dir, 't3', 'userdata'), t3CachesDir: path.join(dir, 't3', 'caches'),
    codexDir: path.join(dir, 'codex'), recentWindowHours: 24 };
  return { dir, config };
}

function database(file: string, schema: string, seed?: (db: DatabaseSync) => void) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(schema);
    seed?.(db);
  } finally {
    db.close();
  }
}

function insert(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function checkOutput(out: CollectorOutput) {
  assert.ok(out.adapterId && out.ok && Number.isFinite(Date.parse(out.collectedAt)));
  for (const list of [out.tasks, out.agents, out.alerts, out.events, out.scheduled, out.quotas]) assert.ok(Array.isArray(list));
  for (const task of out.tasks) {
    assert.ok(task.id && task.title && task.source && task.provider);
    assert.ok(Number.isFinite(Date.parse(task.startedAt)) && Number.isFinite(Date.parse(task.updatedAt)));
    assert.ok(task.durationMs >= 0 && task.recentSteps.length <= 15);
  }
  assert.equal(new Set(out.tasks.map(task => task.id)).size, out.tasks.length);
  assert.equal(new Set(out.events.map(event => event.id)).size, out.events.length);
}

test('Windows drive paths, UNC paths, whitespace and absent paths', () => {
  assert.equal(normalizeWindowsPath('  \\\\?\\C:\\Work Dir  '), 'C:\\Work Dir');
  assert.equal(normalizeWindowsPath('\\\\?\\UNC\\host\\share\\repo'), '\\\\host\\share\\repo');
  assert.equal(normalizeWindowsPath('\\\\host\\repo'), '\\\\host\\repo');
  assert.equal(normalizeWindowsPath(' /tmp/repo '), '/tmp/repo');
  for (const value of [undefined, null, '', '  ']) assert.equal(normalizeWindowsPath(value), undefined);
});

test('read-only handles reject writes, close after callbacks, and return null for missing or locked files', t => {
  const { dir } = fixture(t);
  const file = path.join(dir, 'test.sqlite');
  assert.equal(withReadOnlyDb(file, () => 'unexpected'), null);
  assert.equal(existsSync(file), false);
  database(file, 'CREATE TABLE sample (v INTEGER); INSERT INTO sample VALUES (7)');
  let handle: DatabaseSync | undefined;
  const value = withReadOnlyDb(file, db => {
    handle = db;
    assert.equal(db.prepare('PRAGMA query_only').get()?.query_only, 1);
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 1500);
    assert.throws(() => db.exec('INSERT INTO sample VALUES (8)'), /readonly|read-only/i);
    return db.prepare('SELECT v FROM sample').get()?.v;
  });
  assert.equal(value, 7);
  assert.throws(() => handle!.prepare('SELECT 1'), /not open|closed/i);
  assert.throws(() => withReadOnlyDb(file, db => { handle = db; throw new Error('callback failure'); }), /callback failure/);
  assert.throws(() => handle!.prepare('SELECT 1'), /not open|closed/i);
  database(file, 'BEGIN EXCLUSIVE', () => assert.equal(withReadOnlyDb(file, db => db.prepare('SELECT v FROM sample').get()), null));
  assert.equal(withReadOnlyDb(file, db => db.prepare('SELECT count(*) AS n FROM sample').get()?.n), 1);
});

test('absent data and malformed projections leave independent collectors usable', async t => {
  const { dir, config } = fixture(t);
  const detectors = [new ClaudeCodeDetectorAdapter(config, path.join(dir, 'absent-claude')),
    new OpenCodeDetectorAdapter(config, path.join(dir, 'absent-opencode'))];
  for (const adapter of [new T3Adapter(config), new CodexAdapter(config), ...detectors]) {
    const out = await adapter.collect();
    checkOutput(out);
    assert.equal(out.agents[0]?.status, 'offline');
    assert.equal(out.tasks.length, 0);
  }
  assert.equal(existsSync(config.codexDir), false);
  writeJson(path.join(config.t3UserDataDir, 'usage-scan-cache-v17.json'), null);
  writeFileSync(path.join(config.t3UserDataDir, 'server-runtime.json'), '{');
  database(path.join(config.t3UserDataDir, 'statev2.sqlite'), 'CREATE TABLE orchestration_v2_projection_threads (obsolete TEXT)');
  database(path.join(config.codexDir, 'state_5.sqlite'), "CREATE TABLE threads (id TEXT, title TEXT, created_at INTEGER, updated_at INTEGER); INSERT INTO threads VALUES ('legacy','Legacy',1700000000,1700000001)");
  database(path.join(config.codexDir, 'logs_2.sqlite'), 'CREATE TABLE logs (obsolete INTEGER)');
  const t3 = await new T3Adapter(config).collect(), codex = await new CodexAdapter(config).collect();
  checkOutput(t3);
  checkOutput(codex);
  assert.equal(t3.tasks.length, 0);
  assert.equal(codex.tasks[0]?.updatedAt, '2023-11-14T22:13:21.000Z');
});

test('T3 joins v2 projections, keeps active and pending threads, and advances the event cursor', async t => {
  const { config } = fixture(t);
  const now = Date.now(), at = (offset = 0) => new Date(now + offset).toISOString();
  const file = path.join(config.t3UserDataDir, 'statev2.sqlite');
  const p = 'orchestration_v2_projection_';
  database(file, `
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT);
    CREATE TABLE ${p}threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, active_provider_thread_id TEXT, runtime_mode TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE ${p}runs (run_id TEXT, thread_id TEXT, requested_at TEXT, completed_at TEXT, provider TEXT, provider_thread_id TEXT, status TEXT, payload_json TEXT);
    CREATE TABLE ${p}provider_threads (provider_thread_id TEXT, thread_id TEXT, driver TEXT, provider TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE ${p}turn_items (turn_item_id TEXT, node_id TEXT, thread_id TEXT, run_id TEXT, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE ${p}nodes (node_id TEXT, thread_id TEXT, run_id TEXT, kind TEXT, status TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE ${p}subagents (subagent_id TEXT, parent_node_id TEXT, thread_id TEXT, child_thread_id TEXT, provider TEXT, status TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE ${p}runtime_requests (runtime_request_id TEXT, thread_id TEXT, kind TEXT, status TEXT, created_at TEXT, payload_json TEXT);
    CREATE TABLE ${p}plans (plan_id TEXT, thread_id TEXT, kind TEXT, status TEXT, payload_json TEXT);
    CREATE TABLE scheduled_tasks (task_id TEXT, title TEXT, enabled INTEGER, schedule_json TEXT, last_run_status TEXT, next_run_at TEXT, model_selection_json TEXT, run_count INTEGER);
    CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY, event_id TEXT, thread_id TEXT, event_type TEXT, occurred_at TEXT, payload_json TEXT);
  `, db => {
    insert(db, 'projection_projects', { project_id: 'p', title: 'Orrery', workspace_root: '\\\\?\\C:\\repo' });
    const thread = (id: string, updatedAt: string, payload = '{}', extra: Record<string, SQLInputValue> = {}) =>
      insert(db, p + 'threads', { thread_id: id, project_id: 'p', title: id, default_provider: 'codex',
        created_at: at(-3 * 86_400_000), updated_at: updatedAt, payload_json: payload, ...extra });
    Array.from({ length: 81 }, (_, i) => thread(`filler-${i}`, at(-60_000 - i)));
    thread('parent', at(), JSON.stringify({
      branch: 'feature/metrics', worktreePath: ' \\\\?\\C:\\worktree ', linkedPullRequest: { url: 'https://example.test/pr/1' },
      modelSelection: { model: 'unit-model', options: [{ id: 'reasoningEffort', value: 'high' }] }, createdBy: 'user',
    }), { active_provider_thread_id: 'bound', runtime_mode: 'full-access' });
    thread('plan-payload', at(-100), JSON.stringify({ proposedPlan: { status: 'active' } }));
    thread('draft-plan', at(-200), JSON.stringify({ proposedPlan: { status: 'draft' } }));
    thread('malformed', at(-300), '{broken');
    thread('old-active', at(-2 * 86_400_000));
    thread('old-pending', at(-2 * 86_400_000));
    thread('child-title', at(-3 * 86_400_000));
    thread('deleted', at(), '{}', { deleted_at: at() });
    for (const [id, tid, age, status, done] of [
      ['recent','parent',-50_000,'running',null], ['previous','parent',-70_000,'completed',at(-55_000)],
      ['ancient','old-active',-2*86_400_000,'queued',null], ['too-old','parent',-3*86_400_000,'completed',at(-2*86_400_000)],
    ] as const) insert(db, p + 'runs', { run_id: id, thread_id: tid, requested_at: at(age), completed_at: done, status, provider: 'codex' });
    for (const [id, nativeId, updated] of [['bound','native-1',at(-1000)], ['other','wrong-id',at()]] as const) {
      insert(db, p + 'provider_threads', { provider_thread_id: id, thread_id: 'parent', driver: 'codex', provider: 'custom-instance', updated_at: updated,
        payload_json: JSON.stringify({ nativeThreadRef: { nativeId }, contextUsage: { usedTokens: 50, maxTokens: 1000 } }) });
    }
    Array.from({ length: 17 }, (_, i) => insert(db, p + 'turn_items', { thread_id: 'parent', run_id: 'recent', node_id: `n-${i}`, turn_item_id: `i-${i}`,
      type: 'command_execution', status: i === 16 ? 'running' : 'completed', updated_at: at(-2000 + i * 50),
      payload_json: i === 1 ? 'bad' : JSON.stringify({ title: `Command ${i}` }) }));
    for (const id of ['only-node', 'n-16']) insert(db, p + 'nodes', { node_id: id, thread_id: 'parent', run_id: 'recent',
      kind: 'reasoning', status: 'completed', started_at: at(-600), completed_at: at(-400) });
    insert(db, p + 'subagents', { subagent_id: 'sub', parent_node_id: 'root', thread_id: 'parent', child_thread_id: 'child-title',
      provider: 'codex', status: 'completed', started_at: at(-5000), completed_at: at(-1000), payload_json: '{"model":"child-model","origin":"agent"}' });
    for (const [id, tid, kind, status] of [['a','parent','command','pending'],['b','parent','user_input','pending'],
      ['c','parent','user_input','resolved'],['d','old-pending','user_input','pending']] as const) {
      insert(db, p + 'runtime_requests', { runtime_request_id: id, thread_id: tid, kind, status, created_at: at(-1200), payload_json: '{' });
    }
    for (const [id, tid, kind, status] of [['plan','parent','proposed_plan','active'],['todo','malformed','todo_list','active'],
      ['done','malformed','proposed_plan','superseded']] as const) insert(db, p + 'plans', { plan_id: id, thread_id: tid, kind, status });
    insert(db, 'scheduled_tasks', { task_id: 'wake', title: 'Wake', enabled: 1, schedule_json: '{"type":"interval","everyMs":60000}',
      last_run_status: 'succeeded', next_run_at: at(60_000), run_count: 3, model_selection_json: '{"model":"timer"}' });
    for (let i = 1; i <= 85; i++) insert(db, 'orchestration_v2_events', { sequence: i, event_id: `e${i}`, thread_id: 'parent',
      event_type: 'run.completed', occurred_at: at(-1000), payload_json: i % 2 ? '{}' : '{bad' });
  });
  writeJson(path.join(config.t3UserDataDir, 'server-runtime.json'), { pid: 123, host: '127.0.0.1', port: 3773, startedAt: at(-1000), serverVersion: '1.2.3' });
  const usageRow = [now, 0, 0, 100, 20, 5, 8, 3, 'key'];
  writeJson(path.join(config.t3UserDataDir, 'usage-scan-cache-v17.json'), { version: 17, sessions: ['native-1'], files: { one: { r: [usageRow], t: [usageRow] } } });
  writeJson(path.join(config.t3CachesDir, 'instance.json'), { displayName: 'Unit provider', usageLimits: { checkedAt: at(),
    windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 25, resetsAt: at(1000) }, null] } });
  writeFileSync(path.join(config.t3CachesDir, 'malformed.json'), '[');
  const adapter = new T3Adapter(config);
  const out = await adapter.collect();
  checkOutput(out);
  const task = out.tasks.find(task => task.externalIds.t3ThreadId === 'parent')!;
  assert.equal(task.externalIds.codexThreadId, 'native-1');
  assert.equal(task.externalIds.t3RunId, 'recent');
  assert.equal(task.model, 'unit-model');
  assert.equal(task.reasoningEffort, 'high');
  assert.equal(task.gitBranch, 'feature/metrics');
  assert.equal(task.worktreePath, 'C:\\worktree');
  assert.equal(task.project, 'Orrery');
  assert.equal(task.linkedPrUrl, 'https://example.test/pr/1');
  assert.deepEqual(task.tokens, { inputTokens: 125, cachedInputTokens: 20, outputTokens: 8, reasoningTokens: 3, totalTokens: 133, contextWindow: 1000, contextPercent: 5 });
  assert.equal(task.currentStep, 'Command 16');
  assert.equal(task.recentSteps.length, 15);
  assert.ok(task.recentSteps.some(step => step.id === 'only-node'));
  assert.ok(!task.recentSteps.some(step => step.id === 'n-16'));
  assert.equal(task.subagents[0]?.title, 'child-title');
  assert.equal(task.subagents[0]?.durationMs, 4000);
  assert.equal(task.pendingApprovals, 1);
  assert.equal(task.pendingInputs, 1);
  assert.equal(task.status, 'waiting_approval');
  assert.equal(task.hasActionablePlan, true);
  assert.equal(out.tasks.find(task => task.title === 'malformed')?.hasActionablePlan, false);
  assert.equal(out.tasks.find(task => task.title === 'draft-plan')?.hasActionablePlan, false);
  assert.equal(out.tasks.find(task => task.title === 'old-pending')?.status, 'waiting_input');
  assert.equal(out.tasks.find(task => task.title === 'old-active')?.status, 'queued');
  assert.ok(!out.tasks.some(task => task.title === 'deleted'));
  assert.equal(out.alerts.filter(alert => alert.kind === 'proposed_plan').length, 2);
  assert.equal(out.alerts.filter(alert => alert.kind === 'approval').length, 1);
  assert.equal(out.alerts.filter(alert => alert.kind === 'user_input').length, 2);
  assert.deepEqual(out.timeline?.map(segment => segment.id).sort(), ['t3:run:ancient','t3:run:previous','t3:run:recent']);
  assert.equal(out.quotas.length, 1);
  assert.equal(out.quotas[0].usedPercent, 25);
  assert.equal(out.scheduled[0]?.scheduleText, 'Every 1 min');
  assert.equal(out.agents[0].endpointUrl, 'http://127.0.0.1:3773');
  assert.equal(out.agents[0].version, '1.2.3');
  assert.deepEqual(out.agents[0].pids, [123]);
  assert.equal(out.events.length, 80);
  assert.equal(out.events[0].id, 't3:event:e6');
  database(file, '', db => insert(db, 'orchestration_v2_events', { sequence: 86, event_id: 'new', event_type: 'tool.started', occurred_at: at() }));
  assert.deepEqual((await adapter.collect()).events.map(e => [e.id, e.level]), [['t3:event:new','tool']]);
  assert.equal((await adapter.collect()).events.length, 0);
});

test('Codex joins active turns, projects, spawn edges and schedules, then tails only appended complete records', async t => {
  const { config, dir } = fixture(t);
  const now = Date.now(), at = new Date(now).toISOString();
  const old = now - 3 * 86_400_000;
  const rollout = path.join(dir, 'active.jsonl'), idle = path.join(dir, 'idle.jsonl');
  const message = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: at, payload }) + '\n';
  const tokens = message('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 90, cached_input_tokens: 20,
    output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 100 }, last_token_usage: { total_tokens: 20 }, model_context_window: 200 } });
  writeFileSync(rollout, 'malformed\n' + message('event_msg', { type: 'task_started', started_at: now }) +
    message('turn_context', { cwd: '\\\\?\\C:\\Repo\\sub', model: 'rollout-model', effort: 'high' }) + tokens +
    message('response_item', { type: 'reasoning', encrypted_content: 'unused' }) +
    message('response_item', { type: 'custom_tool_call', call_id: 'tool', name: 'exec_command' }));
  writeFileSync(idle, tokens);
  const threads = path.join(config.codexDir, 'state_5.sqlite');
  database(threads, `CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
    originator TEXT, source TEXT, rollout_path TEXT, cwd TEXT, model TEXT, tokens_used INTEGER, archived INTEGER, project_id TEXT, git_branch TEXT);
    CREATE TABLE projects (id TEXT, name TEXT); CREATE TABLE project_roots (project_id TEXT, path TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);`, db => {
    insert(db, 'projects', { id: 'p1', name: 'Primary project' });
    insert(db, 'project_roots', { project_id: 'p1', path: 'C:\\repo' });
    const thread = (id: string, updated: number, extra: Record<string, SQLInputValue> = {}) =>
      insert(db, 'threads', { id, title: id, source: 'vscode', created_at_ms: old, updated_at_ms: updated, archived: 0, tokens_used: 0, ...extra });
    thread('parent', now, { created_at_ms: now, originator: 'T3 Code', rollout_path: rollout, tokens_used: 15, git_branch: 'main' });
    thread('idle-cli', now - 50 * 60_000, { source: 'cli', rollout_path: idle, tokens_used: 7, cwd: '\\\\?\\C:\\repo\\other' });
    thread('child', old, { originator: 'Codex Desktop', archived: 1 });
    thread('old-active', old, { archived: 1, originator: 'Codex Desktop' });
    thread('archived-today', now, { created_at_ms: now, archived: 1, tokens_used: 12 });
    insert(db, 'thread_spawn_edges', { parent_thread_id: 'parent', child_thread_id: 'child', status: 'closed' });
  });
  const app = path.join(config.codexDir, 'sqlite', 'codex.db');
  database(app, `CREATE TABLE active_chat_turns (thread_id TEXT, observed_at_ms INTEGER);
    CREATE TABLE automations (id TEXT, name TEXT, status TEXT, next_run_at INTEGER, last_run_at INTEGER, rrule TEXT, model TEXT, cwds TEXT);
    CREATE TABLE automation_runs (automation_id TEXT, status TEXT, thread_title TEXT, created_at INTEGER, updated_at INTEGER);`, db => {
    insert(db, 'active_chat_turns', { thread_id: 'parent', observed_at_ms: now });
    insert(db, 'active_chat_turns', { thread_id: 'old-active', observed_at_ms: now });
    insert(db, 'active_chat_turns', { thread_id: 'before-state-write', observed_at_ms: now });
    insert(db, 'automations', { id: 'cron', name: 'Nightly', status: 'ACTIVE', next_run_at: now + 1000, rrule: 'FREQ=DAILY',
      model: 'timer', cwds: JSON.stringify(['\\\\?\\C:\\repo']) });
    insert(db, 'automation_runs', { automation_id: 'cron', status: 'FAILED', thread_title: 'Nightly run', created_at: now - 1000, updated_at: now });
  });
  database(path.join(config.codexDir, 'queue_1.sqlite'), 'CREATE TABLE queued_items (id TEXT, thread_id TEXT, payload_json TEXT, queue_order INTEGER)',
    db => insert(db, 'queued_items', { id: 'queue', thread_id: 'parent', payload_json: '{"text":"Follow up"}', queue_order: 0 }));
  const logs = path.join(config.codexDir, 'logs_2.sqlite');
  database(logs, 'CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, feedback_log_body TEXT, target TEXT, thread_id TEXT)', db => {
    for (let i = 1; i <= 70; i++) insert(db, 'logs', { id: i, ts: Math.floor(now / 1000), level: 'WARN', feedback_log_body: `Warning ${i}`, thread_id: 'parent' });
    insert(db, 'logs', { id: 71, ts: now, level: 'INFO' });
  });
  const adapter = new CodexAdapter(config);
  const out = await adapter.collect();
  checkOutput(out);
  const parent = out.tasks.find(task => task.externalIds.codexThreadId === 'parent')!;
  assert.equal(parent.source, 't3-codex');
  assert.equal(parent.status, 'running');
  assert.equal(parent.currentStep, 'exec_command');
  assert.equal(parent.model, 'rollout-model');
  assert.equal(parent.reasoningEffort, 'high');
  assert.equal(parent.cwd, 'C:\\Repo\\sub');
  assert.equal(parent.project, 'Primary project');
  assert.deepEqual(parent.tokens, { inputTokens: 90, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 3,
    totalTokens: 100, contextWindow: 200, contextPercent: 10 });
  assert.equal(parent.subagents[0]?.childThreadId, 'child');
  assert.equal(parent.subagents[0]?.title, 'child');
  assert.equal(parent.subagents[0]?.status, 'completed');
  const cli = out.tasks.find(task => task.title === 'idle-cli');
  assert.equal(cli?.source, 'codex-cli');
  assert.equal(cli?.cwd, 'C:\\repo\\other');
  assert.equal(cli?.tokens?.totalTokens, 7);
  assert.equal(cli?.recentSteps.length, 0);
  assert.equal(out.tasks.find(task => task.title === 'old-active')?.status, 'running');
  assert.equal(out.tasks.find(task => task.title === 'old-active')?.source, 'codex-app');
  assert.equal(out.tasks.find(task => task.externalIds.codexThreadId === 'before-state-write')?.status, 'running');
  assert.ok(out.timeline?.some(segment => segment.taskId === parent.id && segment.isActive));
  assert.equal(out.todayTokens, 112);
  assert.equal(out.agents[0]?.status, 'online');
  assert.equal(out.scheduled.find(item => item.kind === 'automation')?.runCount, 1);
  assert.equal(out.scheduled.find(item => item.kind === 'automation')?.lastRunStatus, 'FAILED');
  assert.equal(out.scheduled.find(item => item.kind === 'automation')?.cwd, 'C:\\repo');
  assert.deepEqual(out.scheduled.filter(item => item.kind === 'queued_item').map(item => [item.title, item.status]), [['Follow up','queued']]);
  const warnings = out.events.filter(event => event.level === 'warn');
  assert.equal(warnings.length, 60);
  assert.ok(warnings.some(event => event.id === 'codex:log:11'));
  assert.equal((await adapter.collect()).events.length, 0);
  renameSync(threads, threads + '.away');
  try {
    checkOutput(await adapter.collect());
  } finally {
    renameSync(threads + '.away', threads);
  }
  assert.equal((await adapter.collect()).events.length, 0);
  const unicode = Buffer.from(message('response_item', { type: 'custom_tool_call', call_id: 'utf8', name: 'check 🔭' }));
  const cut = unicode.indexOf(Buffer.from('🔭')) + 1;
  appendFileSync(rollout, unicode.subarray(0, cut));
  assert.equal((await adapter.collect()).events.length, 0);
  appendFileSync(rollout, unicode.subarray(cut));
  database(logs, '', db => {
    insert(db, 'logs', { id: 72, ts: now, level: 'INFO' });
    insert(db, 'logs', { id: 73, ts: now, level: 'ERROR', feedback_log_body: 'New error' });
  });
  const next = await adapter.collect();
  assert.equal(next.events.length, 2);
  assert.ok(next.events.some(event => event.summary === 'check 🔭'));
  assert.ok(next.events.some(event => event.id === 'codex:log:73'));
  assert.equal(parent.recentSteps.length, 2);
  appendFileSync(rollout, message('response_item', { type: 'custom_tool_call_output', call_id: 'utf8' }) +
    message('event_msg', { type: 'task_complete', completed_at: now }));
  database(app, "DELETE FROM active_chat_turns WHERE thread_id='parent'");
  const done = (await adapter.collect()).tasks.find(task => task.id === parent.id)!;
  assert.equal(done.status, 'completed');
  assert.ok(done.recentSteps.every(step => step.status === 'completed'));
  writeFileSync(rollout, message('response_item', { type: 'reasoning' }));
  const reset = await adapter.collect();
  assert.equal(reset.tasks.find(task => task.id === parent.id)?.recentSteps.length, 1);
  assert.equal(reset.events.length, 1);
  adapter.dispose();
});

test('detectors return recent local sessions and can use the shared process sample', async t => {
  const { dir, config } = fixture(t);
  const now = Date.now();
  const claude = path.join(dir, '.claude'), opencode = path.join(dir, '.opencode');
  mkdirSync(claude);
  writeFileSync(path.join(claude, 'history.jsonl'), [
    { sessionId: 'old', timestamp: now - 3 * 86_400_000, display: 'old' },
    { sessionId: 'current', timestamp: now - 1000, display: 'First prompt', project: 'C:\\work' },
    { sessionId: 'current', timestamp: now, display: 'Recent prompt', project: 'C:\\work' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  writeJson(path.join(claude, 'sessions', '123.json'), { sessionId: 'live', pid: 123, startedAt: now, cwd: 'C:\\work' });
  const live = async () => [{ pid: 123, ppid: 1, agentId: 'claude-code', name: 'claude', role: 'CLI', cpuPercent: 2, memoryMb: 16 }];
  const a = await new ClaudeCodeDetectorAdapter(config, claude, live).collect();
  checkOutput(a);
  assert.equal(a.agents[0]?.status, 'online');
  assert.equal(a.tasks.length, 2);
  assert.ok(a.tasks.some(task => task.title === 'Recent prompt'));
  assert.ok(a.tasks.some(task => task.status === 'running'));
  database(path.join(opencode, 'opencode.db'), 'CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)',
    db => insert(db, 'session', { id: 's1', title: 'SQLite session', directory: 'C:\\work', time_created: now - 1000, time_updated: now }));
  writeJson(path.join(opencode, 'storage', 'session', 'p1', 's2.json'), { id: 's2', title: 'Legacy session', time: { created: now, updated: now } });
  const b = await new OpenCodeDetectorAdapter(config, opencode).collect();
  checkOutput(b);
  assert.deepEqual(b.tasks.map(task => task.title).sort(), ['Legacy session','SQLite session']);
});

test('default registry exposes all five distinct adapters in collection order', () => {
  const adapters = createDefaultAdapters(loadConfig());
  assert.deepEqual(adapters.map(adapter => adapter.id), ['t3','codex','process','claude-code','opencode']);
  assert.deepEqual(adapters.map(adapter => adapter.constructor), [T3Adapter, CodexAdapter, ProcessAdapter, ClaudeCodeDetectorAdapter, OpenCodeDetectorAdapter]);
  assert.ok(adapters.every(adapter => adapter.intervalMs > 0 && typeof adapter.collect === 'function'));
});

test('live read-only T3 and Codex smoke', async t => {
  const config = loadConfig();
  const [t3, codex] = await Promise.all([new T3Adapter(config).collect(), new CodexAdapter(config).collect()]);
  [t3, codex].forEach(checkOutput);
  const codexIds = new Set(codex.tasks.map(task => task.externalIds.codexThreadId));
  const joins = t3.tasks.filter(task => task.externalIds.codexThreadId && codexIds.has(task.externalIds.codexThreadId));
  for (const sample of [t3, codex]) {
    t.diagnostic(JSON.stringify({ adapter: sample.adapterId, tasks: sample.tasks.length, timeline: sample.timeline?.length,
      scheduled: sample.scheduled.length, events: sample.events.length, quotas: sample.quotas.length, alerts: sample.alerts.length,
      subagents: sample.tasks.reduce((n, task) => n + task.subagents.length, 0), tasksWithSteps: sample.tasks.filter(task => task.recentSteps.length).length,
      todayTokens: sample.todayTokens }));
  }
  t.diagnostic(`Exact native thread ID matches: ${joins.length}`);
});

test('live host and process sampling shares an in-flight CIM query and caches its result', async t => {
  const adapter = new ProcessAdapter({ ...loadConfig(), processPollIntervalMs: 60_000 });
  const [first, second] = await Promise.all([adapter.sampleProcesses(), adapter.sampleProcesses()]);
  assert.equal(first, second);
  const out = await adapter.collect();
  checkOutput(out);
  assert.ok(out.host && out.host.memoryTotalGb > 0 && out.host.uptimeSec >= 0);
  assert.ok(out.host.cpuPercent >= 0 && out.host.cpuPercent <= 100);
  assert.ok(out.host.memoryUsedGb >= 0 && out.host.memoryUsedGb <= out.host.memoryTotalGb);
  assert.ok(out.host.memoryPercent >= 0 && out.host.memoryPercent <= 100);
  assert.equal(out.processes, first);
  assert.equal(out.host.agentProcessCount, first.length);
  assert.ok(first.every(p => p.pid > 0 && p.ppid >= 0 && p.name && p.role && p.cpuPercent === 0 && p.memoryMb >= 0));
  const groups = first.reduce<Record<string, number>>((counts, proc) => ({ ...counts, [proc.agentId]: (counts[proc.agentId] ?? 0) + 1 }), {});
  t.diagnostic(JSON.stringify({ processes: first.length, byAgent: groups }));
  const refresh = new ProcessAdapter({ ...loadConfig(), processPollIntervalMs: 0 });
  await refresh.collect();
  const next = await refresh.collect();
  assert.ok(next.host && next.host.cpuPercent >= 0 && next.host.cpuPercent <= 100);
  assert.ok(next.processes?.every(proc => proc.cpuPercent >= 0 && proc.cpuPercent <= 100));
});
