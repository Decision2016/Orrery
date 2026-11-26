import { useEffect, useRef, useState } from 'react';
import type { OrrerySnapshot } from '@orrery/shared';
import { apiPath, notifyAlert } from '../lib/api';

export type ConnectionState = 'connected' | 'reconnecting' | 'offline';

export function useOrreryStream(notifications: boolean, onSelect: (id: string) => void) {
  const [snapshot, setSnapshot] = useState<OrrerySnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(navigator.onLine ? 'reconnecting' : 'offline');
  const preferences = useRef({ notifications, onSelect });
  useEffect(() => { preferences.current = { notifications, onSelect }; }, [notifications, onSelect]);

  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | undefined;
    let retry: number | undefined;
    let backoff = 1000;
    let latest = -Infinity;
    const seen = new Set<string>();
    let initialized = false;

    function receive(next: OrrerySnapshot) {
      const time = Date.parse(next.generatedAt);
      if (controller.signal.aborted || !Number.isFinite(time) || time < latest) return;
      latest = time;
      next.alerts.forEach(alert => {
        if (initialized && preferences.current.notifications && !seen.has(alert.id)
          && (alert.kind === 'approval' || alert.kind === 'user_input' || alert.kind === 'failed')) {
          void notifyAlert(alert, preferences.current.onSelect).catch(() => {});
        }
        seen.add(alert.id);
      });
      initialized = true;
      setSnapshot(next);
    }

    function scheduleRetry() {
      stream?.close();
      window.clearTimeout(retry);
      if (controller.signal.aborted) return;
      setConnection(navigator.onLine && backoff < 8000 ? 'reconnecting' : 'offline');
      if (navigator.onLine) {
        retry = window.setTimeout(connect, backoff);
        backoff = Math.min(30000, backoff * 2);
      }
    }

    function connect() {
      window.clearTimeout(retry);
      stream?.close();
      if (!navigator.onLine) { setConnection('offline'); return; }
      setConnection('reconnecting');
      stream = new EventSource(apiPath('stream'));
      stream.onopen = () => { backoff = 1000; setConnection('connected'); };
      stream.addEventListener('snapshot', (event: MessageEvent<string>) => {
        try {
          receive(JSON.parse(event.data) as OrrerySnapshot);
        } catch {
          scheduleRetry();
        }
      });
      stream.addEventListener('heartbeat', () => setConnection('connected'));
      stream.onerror = scheduleRetry;
    }

    void fetch(apiPath('snapshot'), { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<OrrerySnapshot> : undefined)
      .then(data => { if (data) receive(data); })
      .catch(() => {});
    connect();
    window.addEventListener('online', connect);
    window.addEventListener('offline', scheduleRetry);
    return () => {
      controller.abort();
      stream?.close();
      window.clearTimeout(retry);
      window.removeEventListener('online', connect);
      window.removeEventListener('offline', scheduleRetry);
    };
  }, []);

  return { snapshot, connection };
}
