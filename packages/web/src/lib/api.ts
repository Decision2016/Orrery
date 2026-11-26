import type { AttentionAlert, TodoItem, TodoPriority, TodoStatus } from '@orrery/shared';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
  }
}

export function apiPath(path: string) {
  const bundledDesktop = window.__TAURI_INTERNALS__ && (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost');
  return (bundledDesktop ? 'http://127.0.0.1:4318' : '') + '/api/' + path;
}

export async function openTarget(action: 'open-folder' | 'open-url', target: string) {
  const response = await fetch(apiPath('actions/' + action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'open-folder' ? { path: target } : { url: target }),
  });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error('操作失败 · ' + message);
  }
}

export async function hideDesktopWindow() {
  if (window.__TAURI_INTERNALS__) {
    await window.__TAURI_INTERNALS__.invoke('hide_window');
  }
}

export async function quitOrreryProcess() {
  if (window.__TAURI_INTERNALS__) {
    await window.__TAURI_INTERNALS__.invoke('quit_app');
    return;
  }
  const response = await fetch(apiPath('actions/shutdown'), { method: 'POST' });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error('关闭失败 · ' + message);
  }
  window.setTimeout(() => window.close(), 150);
}

export async function killAgentProcess(pid: number) {
  const response = await fetch(apiPath('actions/kill-process'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid }),
  });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error('结束进程失败 · ' + message);
  }
}

export async function createTodo(input: {
  id?: string;
  title: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  agent?: string;
  project?: string;
  cwd?: string;
  note?: string;
}): Promise<TodoItem> {
  const response = await fetch(apiPath('todos'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error('保存待办失败 · ' + message);
  }
  return (result as { item: TodoItem }).item;
}

export async function updateTodo(id: string, patch: Partial<Pick<TodoItem, 'title' | 'status' | 'priority' | 'agent' | 'project' | 'cwd' | 'note'>>): Promise<TodoItem> {
  const response = await fetch(apiPath('todos/' + encodeURIComponent(id)), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error('更新待办失败 · ' + message);
  }
  return (result as { item: TodoItem }).item;
}

export async function deleteTodo(id: string): Promise<void> {
  const response = await fetch(apiPath('todos/' + encodeURIComponent(id)), { method: 'DELETE' });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error('删除待办失败 · ' + message);
  }
}

export async function clearCompletedTodos(): Promise<number> {
  const response = await fetch(apiPath('todos'), { method: 'DELETE' });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`;
    throw new Error('清理待办失败 · ' + message);
  }
  return result && typeof result === 'object' && 'removed' in result && typeof result.removed === 'number' ? result.removed : 0;
}

export async function requestAlerts() {
  const native = window.__TAURI_INTERNALS__;
  if (native) {
    const permission = await native.invoke<string>('plugin:notification|request_permission').catch(() => undefined);
    if (permission) return permission === 'granted';
  }
  if (typeof Notification !== 'undefined') {
    return Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted';
  }
  return false;
}

export async function notifyAlert(alert: AttentionAlert, selectTask?: (id: string) => void) {
  const title = `Orrery · ${alert.sourceLabel}`;
  const body = [alert.title, alert.detail].filter(Boolean).join('\n');
  if (window.__TAURI_INTERNALS__) {
    const delivered = await window.__TAURI_INTERNALS__.invoke('plugin:notification|notify', { options: { title, body } }).then(() => true, () => false);
    if (delivered) return;
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const notice = new Notification(title, { body, tag: alert.id });
    notice.onclick = () => {
      window.focus();
      selectTask?.(alert.taskId);
      notice.close();
    };
  }
}
