// A tiny static file server that behaves like GitHub Pages: it serves a folder under a sub-path, has NO single-page-app
// fallback, and answers 404 for anything that is not a real file. Used by the end-to-end tests and by
// "start-dev.bat" style previews. It listens on 127.0.0.1 only.
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/**
 * @param {{ dir: string, basePath: string, port?: number, host?: string }} options
 * @returns {Promise<{ port: number, url: string, requests: string[], close(): Promise<void> }>}
 */
export function startStaticServer({ dir, basePath, port = 0, host = '127.0.0.1' }) {
  const base = '/' + basePath.replace(/^\/+|\/+$/g, '');
  const prefix = base === '/' ? '/' : base + '/';
  const root = path.resolve(dir);
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url} referer=${req.headers.referer ?? '-'}`);
    const url = new URL(req.url ?? '/', 'http://static');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (pathname === base && base !== '/') {
      res.writeHead(301, { location: prefix }).end();
      return;
    }
    if (!pathname.startsWith(prefix)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let relative = pathname.slice(prefix.length);
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://${host}:${actual}${prefix}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
