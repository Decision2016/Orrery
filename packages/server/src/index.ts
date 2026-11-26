import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultAdapters } from './adapters/registry.js';
import { loadConfig, type OrreryConfig } from './config.js';
import { AppearanceStore } from './engine/appearance.js';
import { LayoutStore } from './engine/layouts.js';
import { OrreryStore } from './engine/store.js';
import { TodoStore } from './engine/todos.js';
import { TokenActivityStore } from './engine/tokenActivity.js';
import { createRequestHandler } from './routes/api.js';

export async function startServer(overrideConfig: Partial<OrreryConfig> = {}) {
  const config = { ...loadConfig(), ...overrideConfig };
  const layoutStore = new LayoutStore(config);
  const appearanceStore = new AppearanceStore(config);
  const todoStore = new TodoStore(config);
  const tokenActivityStore = new TokenActivityStore(config);
  const store = new OrreryStore(createDefaultAdapters(config), config, todoStore, tokenActivityStore);
  let closing: Promise<void> | undefined;
  let server: Server;
  function close() {
    if (closing) return closing;
    const httpClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closing = Promise.all([httpClosed, store.stop()]).then(() => {}).finally(() => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    });
    return closing;
  }
  function onSignal() {
    void close().catch(error => { console.error(error); process.exitCode = 1; });
  }
  server = createServer(createRequestHandler({ store, layoutStore, appearanceStore, todoStore, tokenActivityStore, config, onShutdown: onSignal }));
  server.listen(config.port, config.host);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const host = config.host.includes(':') ? '[' + config.host + ']' : config.host;
  console.log('Orrery Observatory listening on http://' + host + ':' + port);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await store.start();
  return { server, store, config, layoutStore, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch(error => { console.error(error); process.exitCode = 1; });
}
