import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let timestamp = Date.now();
let timer: number;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timestamp = Date.now();
    timer = window.setInterval(() => {
      timestamp = Date.now();
      listeners.forEach(update => update());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.clearInterval(timer);
  };
}

export const useNow = () => useSyncExternalStore(subscribe, () => timestamp);
