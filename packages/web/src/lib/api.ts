import type { AttentionAlert } from '@orrery/shared';

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
