import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { OrreryConfig } from '../config.js';
import { AppearanceStore, AppearanceValidationError, MAX_WALLPAPER_BYTES } from '../engine/appearance.js';
import { LayoutStore, LayoutValidationError } from '../engine/layouts.js';
import type { OrreryStore } from '../engine/store.js';

const MAX_BODY = 1024 * 1024;
const LOCAL_ORIGIN = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|tauri\.localhost)(?::\d{1,5})?|tauri:\/\/localhost)$/i;
const SHELL_CHARACTERS = /[\u0000-\u0020\u007f"&|<>^()%!]/;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    throw new HttpError(413, 'Payload exceeds size limit.');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes) {
      req.resume();
      throw new HttpError(413, 'Payload exceeds size limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(req, MAX_BODY);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Expected a JSON body.');
  }
}

function missing(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function requireInside(root: string, file: string) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new HttpError(403, 'Path outside the web directory.');
  }
}

async function serveStatic(res: ServerResponse, webDistDir: string, pathname: string) {
  if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('\\') ||
      pathname.includes(':') || pathname.split('/').includes('..')) throw new HttpError(403, 'Invalid asset path.');
  const root = await realpath(webDistDir);
  const candidate = await realpath(path.resolve(root, '.' + pathname)).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return undefined;
  });
  if (candidate) requireInside(root, candidate);
  const file = candidate && (await stat(candidate)).isFile() ? candidate : await realpath(path.join(root, 'index.html'));
  requireInside(root, file);
  const bytes = await readFile(file);
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}

async function launch(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  await once(child, 'spawn');
  child.unref();
}

export function createRequestHandler({ store, layoutStore, appearanceStore, config, onShutdown }: {
  store: Pick<OrreryStore, 'getHealth' | 'getSnapshot' | 'getTask' | 'subscribe'>;
  layoutStore: LayoutStore;
  appearanceStore?: AppearanceStore;
  config: Pick<OrreryConfig, 'webDistDir'> & Partial<Pick<OrreryConfig, 'appearanceFilePath'>>;
  onShutdown?: () => void;
}) {
  const appearance = appearanceStore ?? (config.appearanceFilePath ? new AppearanceStore({ appearanceFilePath: config.appearanceFilePath }) : undefined);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      res.setHeader('Vary', 'Origin');
      const origin = req.headers.origin;
      if (origin) {
        if (!LOCAL_ORIGIN.test(origin)) throw new HttpError(403, 'Local origins only.');
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Filename' });
        res.end();
        return;
      }
      const pathname = decodeURIComponent((req.url ?? '/').split('?', 1)[0]);
      if (pathname.includes('\0')) throw new HttpError(400, 'Invalid path.');
      if (req.method === 'GET') {
        if (pathname === '/api/health') return json(res, 200, store.getHealth());
        if (pathname === '/api/snapshot') return json(res, 200, store.getSnapshot());
        if (pathname === '/api/layouts') return json(res, 200, await layoutStore.load());
        if (pathname === '/api/appearance' && appearance) return json(res, 200, await appearance.load());
        if (pathname === '/api/appearance/wallpaper' && appearance) {
          const wallpaper = await appearance.readWallpaper();
          if (!wallpaper) throw new HttpError(404, 'Wallpaper not configured.');
          res.writeHead(200, {
            'Content-Type': wallpaper.contentType,
            'Content-Length': wallpaper.bytes.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(wallpaper.bytes);
          return;
        }
        if (pathname.startsWith('/api/tasks/')) {
          const task = store.getTask(pathname.slice('/api/tasks/'.length));
          if (!task) throw new HttpError(404, 'Task not found.');
          return json(res, 200, task);
        }
        if (pathname === '/api/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          const send = (event: string, data: unknown) => {
            if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) {
              res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
            }
          };
          send('snapshot', store.getSnapshot());
          const unsubscribe = store.subscribe(snapshot => send('snapshot', snapshot), () => res.end());
          const heartbeat = setInterval(() => send('heartbeat', { timestamp: new Date().toISOString() }), 15_000);
          const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
          req.once('close', cleanup);
          res.once('close', cleanup);
          return;
        }
        if (pathname !== '/api' && !pathname.startsWith('/api/')) return await serveStatic(res, config.webDistDir, pathname);
      }
      if (req.method === 'PUT' && pathname === '/api/layouts') return json(res, 200, await layoutStore.save(await readJson(req)));
      if (req.method === 'PUT' && pathname === '/api/appearance' && appearance) {
        return json(res, 200, await appearance.save(await readJson(req)));
      }
      if (req.method === 'POST' && pathname === '/api/appearance/wallpaper' && appearance) {
        const contentType = String(req.headers['content-type'] ?? '');
        const rawName = req.headers['x-filename'];
        const filename = typeof rawName === 'string' ? decodeURIComponent(rawName) : undefined;
        const bytes = await readBytes(req, MAX_WALLPAPER_BYTES);
        return json(res, 200, await appearance.saveWallpaper(bytes, contentType, filename));
      }
      if (req.method === 'DELETE' && pathname === '/api/appearance/wallpaper' && appearance) {
        return json(res, 200, await appearance.clearWallpaper());
      }
      if (req.method === 'POST' && pathname === '/api/actions/open-folder') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || !('path' in body) || typeof body.path !== 'string' ||
            !body.path.trim() || body.path.includes('\0')) throw new HttpError(400, 'Expected a directory path.');
        const input = body.path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
        const directory = await realpath(path.resolve(input)).catch((error: unknown) => {
          if (missing(error)) throw new HttpError(400, 'Directory does not exist.');
          throw error;
        });
        if (!(await stat(directory)).isDirectory()) throw new HttpError(400, 'Expected a directory.');
        await launch('explorer.exe', [directory]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/actions/open-url') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || !('url' in body) || typeof body.url !== 'string') {
          throw new HttpError(400, 'Expected an HTTP or HTTPS URL.');
        }
        const url = URL.parse(body.url);
        if (!url || !['http:', 'https:'].includes(url.protocol) || SHELL_CHARACTERS.test(body.url) || SHELL_CHARACTERS.test(url.href)) {
          throw new HttpError(400, 'Expected an HTTP or HTTPS URL without shell metacharacters.');
        }
        await launch('cmd.exe', ['/c', 'start', '', url.href]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/api/actions/shutdown') {
        json(res, 200, { ok: true });
        if (onShutdown) setTimeout(() => onShutdown(), 80).unref();
        return;
      }
      if (req.method === 'POST' && pathname === '/api/actions/kill-process') {
        const body = await readJson(req);
        const pid = body && typeof body === 'object' && 'pid' in body ? Number(body.pid) : NaN;
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
          throw new HttpError(400, 'Expected a valid monitored agent PID.');
        }
        const monitored = store.getSnapshot().processes.find(p => p.pid === pid);
        if (!monitored) {
          throw new HttpError(403, 'PID is not a currently monitored agent process.');
        }
        try {
          process.kill(pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            return json(res, 200, { ok: true, alreadyExited: true });
          }
          throw new HttpError(500, 'Failed to terminate process.');
        }
        return json(res, 200, { ok: true, pid });
      }
      throw new HttpError(404, 'Route not found.');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      if (error instanceof LayoutValidationError || error instanceof AppearanceValidationError || error instanceof URIError) return json(res, 400, { error: error.message });
      if (missing(error)) return json(res, 404, { error: 'File not found.' });
      return json(res, 500, { error: 'Orrery could not complete the request.' });
    }
  };
}
