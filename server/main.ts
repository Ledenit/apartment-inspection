import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApi } from './api.js';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
function headers(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}

export async function startServer() {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  const configured = process.env.APP_ORIGIN;
  if (process.env.NODE_ENV === 'production' && !configured) throw new Error('APP_ORIGIN is required in production');
  if (configured) {
    const url = new URL(configured);
    if (url.origin !== configured || url.protocol !== 'https:' || url.username || url.password) throw new Error('APP_ORIGIN must be an HTTPS origin without a path');
  }
  const dataDir = process.env.PHOTO_DATA_DIR ?? path.resolve('private-data');
  const api = await createApi({
    dataDir,
    origin: configured,
    secureCookies: configured?.startsWith('https:') ?? false,
  });
  const webRoot = await realpath(path.resolve('dist'));
  const actualDataDir = await realpath(dataDir);
  for (const directory of [webRoot, await realpath(path.resolve('public')).catch(() => path.resolve('public'))]) {
    if (actualDataDir === directory || actualDataDir.startsWith(`${directory}${path.sep}`) || directory.startsWith(`${actualDataDir}${path.sep}`)) throw new Error('Private storage and public assets must not overlap');
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    headers(res);
    try {
      if (await api.handle(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      let pathname: string;
      try { pathname = decodeURIComponent((req.url ?? '/').split('?')[0]); }
      catch { res.writeHead(400); res.end(); return; }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) {
        res.writeHead(404); res.end(); return;
      }
      let filename = path.resolve(webRoot, `.${pathname}`);
      if (filename !== webRoot && !filename.startsWith(`${webRoot}${path.sep}`)) { res.writeHead(404); res.end(); return; }
      try {
        const stat = await lstat(filename);
        if (stat.isDirectory()) filename = path.join(filename, 'index.html');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (path.extname(pathname)) { res.writeHead(404); res.end(); return; }
        filename = path.join(webRoot, 'index.html');
      }
      // realpath checks parent directory symlinks too; none may escape dist.
      const actual = await realpath(filename);
      if (!actual.startsWith(`${webRoot}${path.sep}`)) { res.writeHead(404); res.end(); return; }
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': contentTypes[path.extname(filename)] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(filename);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Temporarily unavailable');
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  startServer().then(server => {
    const address = server.address();
    console.log(`Inspection server listening on ${typeof address === 'object' && address ? `${address.address}:${address.port}` : 'configured address'}`);
  }).catch(() => { console.error('Inspection server startup failed. Check configuration and private storage permissions.'); process.exitCode = 1; });
}
