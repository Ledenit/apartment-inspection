import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

export interface ApiOptions {
  dataDir: string;
  origin?: string;
  secureCookies?: boolean;
  maxPhotoBytes?: number;
  ownerQuotaBytes?: number;
  globalQuotaBytes?: number;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe data directory');
}

async function regularFile(filename: string): Promise<Buffer | undefined> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe data file');
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return await file.readFile(); } finally { await file.close(); }
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

async function atomicWrite(filename: string, bytes: Buffer): Promise<void> {
  const temporary = `${filename}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
  }
  finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ApiError(413, 'Request is too large');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new ApiError(413, 'Request is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

// Only the baseline JPEG produced by our canvas compressor is accepted. Metadata
// is discarded by the client; APP1 is rejected here as an additional boundary.
function validateJpeg(bytes: Buffer): void {
  const invalid = () => { throw new ApiError(415, 'A compressed JPEG photo is required'); };
  if (bytes.length < 16 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalid();
  let offset = 2;
  let dimensions = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xd8 || marker === 0x00) invalid();
    if (offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid();
    if (marker === 0xe1) invalid();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (marker !== 0xc0 || length < 8 || bytes[offset + 2] !== 8) invalid();
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!height || !width || height > 1600 || width > 1600 || dimensions) invalid();
      dimensions = true;
    }
    if (marker === 0xda) {
      if (!dimensions) invalid();
      // Entropy-coded data may contain stuffed bytes and restart markers only.
      for (let i = offset + length; i < bytes.length - 2; i++) {
        if (bytes[i] !== 0xff) continue;
        const next = bytes[++i];
        if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) invalid();
      }
      return;
    }
    offset += length;
  }
  invalid();
}

export async function createApi(options: ApiOptions): Promise<{ handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> }> {
  const dataDir = path.resolve(options.dataDir);
  for (const name of ['public', 'dist', 'server-dist']) {
    const webRoot = path.resolve(name);
    if (dataDir === webRoot || dataDir.startsWith(`${webRoot}${path.sep}`)) throw new Error('Photo data must be outside the web root');
  }
  await privateDirectory(dataDir);
  if (await realpath(dataDir) !== dataDir) throw new Error('Symlinked data directories are not supported');
  const sessionsDir = path.join(dataDir, 'sessions');
  const photosDir = path.join(dataDir, 'photos');
  await privateDirectory(sessionsDir);
  await privateDirectory(photosDir);
  const configuredOrigin = options.origin ? new URL(options.origin).origin : undefined;
  const maxPhotoBytes = options.maxPhotoBytes ?? 5 * 1024 * 1024;
  const ownerQuotaBytes = options.ownerQuotaBytes ?? 256 * 1024 * 1024;
  const globalQuotaBytes = options.globalQuotaBytes ?? 2 * 1024 * 1024 * 1024;
  const rates = new Map<string, { minute: number; requests: number }>();
  const loginRates = new Map<string, { minute: number; requests: number }>();
  let activeUploads = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (waiting >= 16) throw new ApiError(503, 'Please retry shortly');
    waiting++;
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    try { return await result; } finally { waiting--; }
  }
  async function owner(req: IncomingMessage): Promise<string | undefined> {
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('inspection_session='))?.slice('inspection_session='.length);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return undefined;
    const id = digest(cookie);
    const stored = await regularFile(path.join(sessionsDir, `${id}.json`));
    return stored ? id : undefined;
  }
  function mutationAllowed(req: IncomingMessage): void {
    const expected = configuredOrigin ?? `http://${req.headers.host}`;
    if (req.headers.origin !== expected || req.headers['x-inspection-request'] !== '1') throw new ApiError(403, 'Request origin is not allowed');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'Request origin is not allowed');
  }
  function rateLimit(map: Map<string, { minute: number; requests: number }>, key: string, limit: number): void {
    const minute = Math.floor(Date.now() / 60_000);
    let rate = map.get(key);
    if (!rate || rate.minute !== minute) {
      if (map.size >= 2048) {
        for (const [oldKey, old] of map) if (old.minute !== minute) map.delete(oldKey);
        if (map.size >= 2048) throw new ApiError(429, 'Too many requests');
      }
      rate = { minute, requests: 0 }; map.set(key, rate);
    }
    if (++rate.requests > limit) throw new ApiError(429, 'Too many requests');
  }
  type PhotoState = { version: number; deleted: boolean; sha256?: string };
  async function state(directory: string, id: string): Promise<PhotoState | undefined> {
    const stateDirectory = path.join(directory, '.state');
    try {
      const stat = await lstat(stateDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe state directory');
      const bytes = await regularFile(path.join(stateDirectory, `${id}.json`));
      if (!bytes) return undefined;
      const value = JSON.parse(bytes.toString('utf8')) as PhotoState;
      if (!Number.isSafeInteger(value.version) || value.version < 1 || typeof value.deleted !== 'boolean' || (value.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.sha256))) throw new Error('Invalid photo state');
      return value;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async function saveState(directory: string, id: string, value: PhotoState): Promise<void> {
    const stateDirectory = path.join(directory, '.state');
    await privateDirectory(stateDirectory);
    if (!(await regularFile(path.join(stateDirectory, `${id}.json`))) && (await readdir(stateDirectory)).length >= 500) throw new ApiError(507, 'Photo ID capacity reached');
    await atomicWrite(path.join(stateDirectory, `${id}.json`), Buffer.from(JSON.stringify(value)));
  }
  async function usage(): Promise<{ total: number; owners: Map<string, { count: number; bytes: number }> }> {
    let total = 0;
    const owners = new Map<string, { count: number; bytes: number }>();
    for (const entry of await readdir(photosDir, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe photo directory');
      const directory = path.join(photosDir, entry.name);
      const current = { count: 0, bytes: 0 };
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (file.name === '.state') {
          if (!file.isDirectory() || file.isSymbolicLink()) throw new Error('Unsafe state directory');
          continue;
        }
        const stat = await lstat(path.join(directory, file.name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe photo file');
        current.count++;
        current.bytes += stat.size;
      }
      total += current.bytes;
      owners.set(entry.name, current);
    }
    return { total, owners };
  }
  return {
    async handle(req, res) {
      if (!(req.url === '/api' || req.url?.startsWith('/api/'))) return false;
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
      try {
        const route = (req.url ?? '').split('?')[0];
        const session = await owner(req);
        rateLimit(rates, session ?? `ip:${req.socket.remoteAddress ?? 'unknown'}`, 240);
        if (route === '/api/session' && req.method === 'GET') {
          json(200, session ? { authenticated: true, phone: '70000000000', demo: true } : { authenticated: false, demo: true });
          return true;
        }
        if (route === '/api/session' && req.method === 'POST') {
          mutationAllowed(req);
          rateLimit(loginRates, `ip:${req.socket.remoteAddress ?? 'unknown'}`, 60);
          rateLimit(loginRates, 'global', 300);
          if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON is required');
          let input: { phone?: unknown; code?: unknown };
          try { input = JSON.parse((await body(req, 1024)).toString('utf8')); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'Invalid JSON'); }
          if (!input || input.phone !== '70000000000' || input.code !== '0000') throw new ApiError(400, 'Use the displayed demo credentials');
          if (!session) await exclusive(async () => {
            if ((await readdir(sessionsDir)).length >= 1000) throw new ApiError(503, 'Demo session capacity reached');
            const token = randomBytes(32).toString('hex');
            await atomicWrite(path.join(sessionsDir, `${digest(token)}.json`), Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() })));
            res.setHeader('Set-Cookie', `inspection_session=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000${options.secureCookies ? '; Secure' : ''}`);
          });
          json(200, { authenticated: true, phone: '70000000000', demo: true });
          return true;
        }
        if (route === '/api/photos' && req.method === 'GET') {
          if (!session) throw new ApiError(401, 'Demo sign-in is required');
          const directory = path.join(photosDir, session);
          let photoIds: string[] = [];
          try {
            const stat = await lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe photo directory');
            const candidates = (await readdir(directory, { withFileTypes: true }))
              .filter(file => file.isFile() && !file.isSymbolicLink() && file.name.endsWith('.jpg') && uuid.test(file.name.slice(0, -4)))
              .map(file => file.name.slice(0, -4));
            for (const id of candidates) if (!(await state(directory, id))?.deleted) photoIds.push(id);
          } catch (error) { if (!missing(error)) throw error; }
          json(200, { photoIds }); return true;
        }
        const match = /^\/api\/photos\/([^/]+)$/.exec(route);
        if (!match || !uuid.test(match[1])) throw new ApiError(404, 'Not found');
        if (!session) throw new ApiError(401, 'Demo sign-in is required');
        const directory = path.join(photosDir, session);
        const id = match[1].toLowerCase();
        const filename = path.join(directory, `${id}.jpg`);
        if (req.method === 'GET') {
          try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe photo directory'); }
          catch (error) { if (!missing(error)) throw error; throw new ApiError(404, 'Photo not found'); }
          if ((await state(directory, id))?.deleted) throw new ApiError(404, 'Photo not found');
          const bytes = await regularFile(filename);
          if (!bytes) throw new ApiError(404, 'Photo not found');
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Content-Disposition': 'inline; filename="photo.jpg"' });
          res.end(bytes);
          return true;
        }
        if (req.method !== 'PUT' && req.method !== 'DELETE') throw new ApiError(405, 'Method not allowed');
        mutationAllowed(req);
        const rawVersion = req.headers['x-photo-version'];
        const version = typeof rawVersion === 'string' && /^[1-9]\d*$/.test(rawVersion) ? Number(rawVersion) : NaN;
        if (!Number.isSafeInteger(version)) throw new ApiError(400, 'A positive photo version is required');
        if (req.method === 'DELETE') {
          await exclusive(async () => {
            await privateDirectory(directory);
            const saved = await state(directory, id);
            if (saved && version < saved.version) return;
            const existing = await regularFile(filename);
            await saveState(directory, id, { version, deleted: true, sha256: saved?.sha256 ?? (existing ? digest(existing) : undefined) });
            if (existing) await unlink(filename);
          });
          res.writeHead(204); res.end(); return true;
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'image/jpeg') throw new ApiError(415, 'A compressed JPEG photo is required');
        if (activeUploads >= 4) throw new ApiError(503, 'Please retry shortly');
        activeUploads++;
        try {
          const bytes = await body(req, maxPhotoBytes);
          validateJpeg(bytes);
          await exclusive(async () => {
          await privateDirectory(directory);
          const saved = await state(directory, id);
          if (saved && (version < saved.version || (version === saved.version && saved.deleted))) return;
          const hash = digest(bytes);
          if (saved?.sha256 && saved.sha256 !== hash) throw new ApiError(409, 'Photo ID already exists');
          const existing = await regularFile(filename);
          if (existing) {
            if (!existing.equals(bytes)) throw new ApiError(409, 'Photo ID already exists');
            await saveState(directory, id, { version, deleted: false, sha256: hash });
            return;
          }
          const current = await usage();
          const own = current.owners.get(session) ?? { bytes: 0, count: 0 };
          if (own.count >= 500 || own.bytes + bytes.length > ownerQuotaBytes || current.total + bytes.length > globalQuotaBytes) throw new ApiError(507, 'Photo storage capacity reached');
          const stateDirectory = path.join(directory, '.state');
          await privateDirectory(stateDirectory);
          if (!saved && (await readdir(stateDirectory)).length >= 500) throw new ApiError(507, 'Photo ID capacity reached');
          await atomicWrite(filename, bytes);
          await saveState(directory, id, { version, deleted: false, sha256: hash });
          });
        } finally { activeUploads--; }
        res.writeHead(204); res.end(); return true;
      } catch (error) {
        if (!req.complete) req.resume();
        const known = error instanceof ApiError;
        json(known ? error.status : 500, { error: known ? error.message : 'Storage is temporarily unavailable' });
        return true;
      }
    },
  };
}
