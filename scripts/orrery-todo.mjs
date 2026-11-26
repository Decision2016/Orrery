#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const host = process.env.ORRERY_HOST ?? '127.0.0.1';
const port = Number(process.env.ORRERY_PORT ?? 4318);
const baseUrl = `http://${host}:${port}/api/todos`;
const dataDir = process.env.ORRERY_DATA_DIR ?? path.join(os.homedir(), '.orrery');
const todosFile = path.join(dataDir, 'todos.json');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[token.slice(2)] = next;
          i++;
        } else {
          flags[token.slice(2)] = 'true';
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

async function tryHttp(pathname, options) {
  try {
    const res = await fetch(pathname, { ...options, signal: AbortSignal.timeout(1500) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return { ok: true, body };
  } catch (error) {
    if (error instanceof TypeError || error?.name === 'TimeoutError' || error?.cause?.code === 'ECONNREFUSED') {
      return { ok: false };
    }
    throw error;
  }
}

async function readLocalTodos() {
  try {
    const parsed = JSON.parse(await readFile(todosFile, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeLocalTodos(items) {
  await mkdir(path.dirname(todosFile), { recursive: true });
  const temp = `${todosFile}.${randomUUID()}.tmp`;
  const payload = { updatedAt: new Date().toISOString(), items };
  try {
    await writeFile(temp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(temp, todosFile);
  } finally {
    await rm(temp, { force: true });
  }
}

function usage() {
  console.log(`Usage:
  node scripts/orrery-todo.mjs list
  node scripts/orrery-todo.mjs add "<title>" [--id <id>] [--status pending|in_progress|blocked|done] [--priority low|normal|high|critical] [--agent <name>] [--project <name>] [--cwd <dir>] [--note <text>]
  node scripts/orrery-todo.mjs status <id> <pending|in_progress|blocked|done> [--note <text>]
  node scripts/orrery-todo.mjs start <id>
  node scripts/orrery-todo.mjs done <id>
  node scripts/orrery-todo.mjs block <id> [--note <text>]
  node scripts/orrery-todo.mjs rm <id>
  node scripts/orrery-todo.mjs clear-done`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? 'list';

  if (cmd === 'help' || flags.help) {
    usage();
    return;
  }

  if (cmd === 'list' || cmd === 'ls') {
    const remote = await tryHttp(baseUrl, { method: 'GET' });
    const items = remote.ok ? remote.body.items : await readLocalTodos();
    if (flags.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (!items.length) {
      console.log('No todo items.');
      return;
    }
    for (const item of items) {
      const agent = item.agent ? ` [${item.agent}]` : '';
      const prio = item.priority && item.priority !== 'normal' ? ` (${item.priority})` : '';
      console.log(`${item.id}  [${item.status}]${prio}${agent}  ${item.title}${item.note ? ' — ' + item.note : ''}`);
    }
    return;
  }

  if (cmd === 'add' || cmd === 'upsert') {
    const title = positional.slice(1).join(' ').trim() || flags.title;
    if (!title) {
      console.error('Error: todo title is required.');
      process.exitCode = 1;
      return;
    }
    const payload = {
      ...(flags.id ? { id: flags.id } : {}),
      title,
      status: flags.status ?? 'pending',
      priority: flags.priority ?? 'normal',
      ...(flags.agent ? { agent: flags.agent } : {}),
      ...(flags.project ? { project: flags.project } : {}),
      ...(flags.cwd ? { cwd: flags.cwd } : {}),
      ...(flags.note ? { note: flags.note } : {}),
    };
    const remote = await tryHttp(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (remote.ok) {
      console.log(JSON.stringify(remote.body.item));
      return;
    }
    const now = new Date().toISOString();
    const items = await readLocalTodos();
    const id = payload.id ?? randomUUID();
    const existingIdx = items.findIndex(i => i.id === id);
    const nextItem = {
      ...(existingIdx >= 0 ? items[existingIdx] : { createdAt: now }),
      ...payload,
      id,
      updatedAt: now,
      ...(payload.status === 'done' ? { completedAt: now } : {}),
    };
    if (existingIdx >= 0) items[existingIdx] = nextItem;
    else items.push(nextItem);
    await writeLocalTodos(items);
    console.log(JSON.stringify(nextItem));
    return;
  }

  if (cmd === 'status' || cmd === 'start' || cmd === 'done' || cmd === 'block') {
    const id = positional[1];
    const nextStatus = cmd === 'start' ? 'in_progress' : cmd === 'done' ? 'done' : cmd === 'block' ? 'blocked' : positional[2];
    if (!id || !nextStatus) {
      console.error('Error: expected <id> and status.');
      process.exitCode = 1;
      return;
    }
    const patch = { status: nextStatus, ...(flags.note !== undefined ? { note: flags.note } : {}) };
    const remote = await tryHttp(`${baseUrl}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (remote.ok) {
      console.log(JSON.stringify(remote.body.item));
      return;
    }
    const now = new Date().toISOString();
    const items = await readLocalTodos();
    const target = items.find(i => i.id === id);
    if (!target) {
      console.error(`Error: todo "${id}" not found.`);
      process.exitCode = 1;
      return;
    }
    target.status = nextStatus;
    if (flags.note !== undefined) target.note = flags.note || undefined;
    target.updatedAt = now;
    if (nextStatus === 'done') target.completedAt = now;
    else delete target.completedAt;
    await writeLocalTodos(items);
    console.log(JSON.stringify(target));
    return;
  }

  if (cmd === 'rm' || cmd === 'delete') {
    const id = positional[1];
    if (!id) {
      console.error('Error: expected <id>.');
      process.exitCode = 1;
      return;
    }
    const remote = await tryHttp(`${baseUrl}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (remote.ok) {
      console.log(`Removed ${id}`);
      return;
    }
    const items = await readLocalTodos();
    const next = items.filter(i => i.id !== id);
    await writeLocalTodos(next);
    console.log(`Removed ${id}`);
    return;
  }

  if (cmd === 'clear-done' || cmd === 'clear') {
    const all = flags.all === 'true';
    const remote = await tryHttp(`${baseUrl}${all ? '?all=true' : ''}`, { method: 'DELETE' });
    if (remote.ok) {
      console.log(`Cleared ${remote.body.removed} todo(s).`);
      return;
    }
    const items = await readLocalTodos();
    const next = all ? [] : items.filter(i => i.status !== 'done');
    await writeLocalTodos(next);
    console.log(`Cleared ${items.length - next.length} todo(s).`);
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
