import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';

/** Tiny read-only HTTP helpers: static files, JSON bodies, JSON responses. */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendHtml(res: import('node:http').ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

export function sendText(res: import('node:http').ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

export async function readBody(
  req: import('node:http').IncomingMessage,
  limitBytes = 6_000_000,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(req: import('node:http').IncomingMessage, limit = 6_000_000): Promise<T> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {} as T;
  return JSON.parse(buf.toString('utf8')) as T;
}

export function cors(res: import('node:http').ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}

/** Extremely small static file server for the viewer. */
export function serveStatic(
  rootDir: string,
  urlPath: string,
  res: import('node:http').ServerResponse,
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  extra?: { apiBase?: string; cfg?: Config },
): boolean {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('..')) return false;
  const file = path.join(rootDir, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  let body = fs.readFileSync(file);
  if (ext === '.js' || ext === '.css' || ext === '.html') {
    let text = body.toString('utf8');
    if (extra?.cfg) text = text.replaceAll('__CREATURE__', extra.cfg.creature.name);
    if (extra?.cfg) text = text.replaceAll('__TOWN__', extra.cfg.town.name);
    body = Buffer.from(text, 'utf8');
  }
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-length': body.length,
  });
  res.end(body);
  return true;
}

export type SseClient = {
  id: number;
  write: (event: string, data: unknown) => void;
  close: () => void;
};

export class SseHub {
  private clients = new Map<number, import('node:http').ServerResponse>();
  private nextId = 1;

  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, initial: unknown): SseClient {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const id = this.nextId++;
    this.clients.set(id, res);
    const client: SseClient = {
      id,
      write: (event, data) => {
        try {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          this.clients.delete(id);
        }
      },
      close: () => {
        this.clients.delete(id);
        try {
          res.end();
        } catch {
          /* already gone */
        }
      },
    };
    client.write('hello', initial);
    req.on('close', () => {
      this.clients.delete(id);
    });
    return client;
  }

  broadcast(event: string, data: unknown): void {
    for (const [id, res] of this.clients) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}

export function etag(body: string): string {
  return createHash('sha1').update(body).digest('hex').slice(0, 16);
}
