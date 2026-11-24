import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StoredDoc = { id: string; title?: string; address: string; inspectionDate: string; description: string; revision: number; rooms: StoredRoom[] };
export type StoredPhoto = { id: string; caption?: string; width: number; height: number; blob: { size: number; type: string; bytes: number[]; sha256?: string } };
export type StoredRoom = { id: string; type: string; name: string; description: string; checkedItemIds: string[]; photos: StoredPhoto[]; defects: { id: string; title: string; description: string; photos: StoredPhoto[] }[] };

// Read the actual origin's stores; assertions never import the product repository.
export async function documents(page: Page, includePhotoBytes = false, includePhotoHashes = false): Promise<StoredDoc[]> {
  return page.evaluate(async ({includePhotoBytes,includePhotoHashes}) => {
    const output: unknown[] = [];
    async function serial(value: unknown): Promise<unknown> {
      if (value instanceof Blob) return { size: value.size, type: value.type, bytes: includePhotoBytes ? Array.from(new Uint8Array(await value.arrayBuffer())) : [], sha256: includePhotoHashes ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await value.arrayBuffer()))).map(byte=>byte.toString(16).padStart(2,'0')).join('') : undefined };
      if (Array.isArray(value)) return Promise.all(value.map(serial));
      if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, val]) => [key, await serial(val)])));
      return value;
    }
    for (const item of await indexedDB.databases()) {
      if (!item.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(item.name!); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      try {
        for (const store of Array.from(db.objectStoreNames)) {
          const rows = await new Promise<unknown[]>((resolve, reject) => { const req = db.transaction(store).objectStore(store).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
          for (const row of rows) if (row && typeof row === 'object' && 'rooms' in row && 'address' in row) output.push(await serial(row));
        }
      } finally { db.close(); }
    }
    return output;
  }, {includePhotoBytes,includePhotoHashes}) as Promise<StoredDoc[]>;
}

export async function onlyDoc(page: Page, includePhotoBytes = false, includePhotoHashes = false): Promise<StoredDoc> {
  const result = await documents(page, includePhotoBytes, includePhotoHashes);
  expect(result).toHaveLength(1);
  return result[0]!;
}

export async function settle(page: Page): Promise<void> {
  await expect.poll(async () => {
    const value = await documents(page);
    return JSON.stringify(value.map(d => [d.id, d.revision]));
  }).not.toBe('[]');
  await expect(page.getByText(/сохраняем|сохранение…|обработка фото/i)).toHaveCount(0);
}

export async function createDocument(page: Page, address = 'QA улица Синтетическая, 21'): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /новый документ/i }).click();
  await expect(page.getByRole('button', { name: /^создать документ$/i })).toHaveCount(0);
  await setInspectionDate(page,'2026-02-03');
  await page.getByLabel(/^адрес/i).fill(address);
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await documents(page)).some(doc=>doc.address===address)).toBe(true);
}

export async function setInspectionDate(page: Page, value: string): Promise<void> {
  const direct = page.getByLabel(/дата осмотра/i);
  if(await direct.count() && await direct.first().isVisible()) {await direct.first().fill(value);return;}
  await page.getByRole('button',{name:/^Дата осмотра:/i}).click();
  await page.getByRole('dialog').getByLabel(/дата осмотра/i).fill(value);
  await finishDialog(page);
}

export async function addRoom(page: Page, type = 'Комната'): Promise<void> {
  const count = (await onlyDoc(page)).rooms.length;
  await page.getByRole('button', { name: /добавить(?: комнату)?$/i }).first().click();
  await page.getByRole('button', { name: new RegExp(`^${type}$`) }).click();
  await expect.poll(async () => (await onlyDoc(page)).rooms.length).toBe(count + 1);
}

export async function openRoom(page: Page, name = 'Комната'): Promise<void> {
  const link = page.getByRole('link', { name: new RegExp(name) });
  if (await link.count()) await link.first().click();
  else await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
}

export async function openDescription(page: Page) {
  await page.getByRole('button', { name: 'Изменить описание', exact: true }).click();
  return page.getByRole('dialog').getByRole('textbox', { name: /^Описание/ });
}

export async function finishDialog(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: /^(?:готово|сохранить)$/i }).click();
}

export async function evidence(page: Page, info: TestInfo, name: string, value: unknown, screenshotTimeout?: number): Promise<void> {
  const dir = path.resolve('docs/evidence/qa');
  await mkdir(dir, { recursive: true });
  const key = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  const png = path.join(dir, `${key}.png`);
  const json = path.join(dir, `${key}.json`);
  await page.screenshot({ path: png, fullPage: true, timeout: screenshotTimeout });
  await writeFile(json, JSON.stringify({ scenario: info.title, viewport: page.viewportSize(), at: new Date().toISOString(), value }, null, 2), 'utf8');
  await info.attach(key, { path: json, contentType: 'application/json' });
}

export async function syntheticPhoto(page: Page, width = 2400, height = 1800, noise = false, seedValue = 17): Promise<Buffer> {
  const base64 = await page.evaluate(({ width, height, noise, seedValue }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    if (noise) {
      const data = ctx.createImageData(width, height); let seed = seedValue;
      for (let i = 0; i < data.data.length; i += 4) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        data.data[i] = seed & 255; data.data[i + 1] = (seed >>> 8) & 255; data.data[i + 2] = (seed >>> 16) & 255; data.data[i + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
    } else {
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, width / 2, height);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(width / 2, 0, width / 2, height);
    }
    return canvas.toDataURL('image/jpeg', .92).split(',')[1]!;
  }, { width, height, noise, seedValue });
  return Buffer.from(base64, 'base64');
}

// Minimal valid little-endian EXIF IFD containing orientation plus a synthetic GPS marker.
export function withOrientation6(jpeg: Buffer): Buffer {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff, Buffer.from('QA-GPS-METADATA')]);
  const marker = Buffer.alloc(4); marker[0] = 0xff; marker[1] = 0xe1; marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

export async function upload(page: Page, buffers: Buffer[], prefix = 'qa'): Promise<void> {
  await page.getByRole('button', { name: /^Фото$|Добавить фото/i }).last().click();
  await page.locator('input[type=file][multiple]').first().setInputFiles(buffers.map((buffer, i) => ({ name: `${prefix}-${i}.jpg`, mimeType: 'image/jpeg', buffer })));
}

export async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

export async function visibleHitTarget(page: Page, selector: string): Promise<void> {
  const element = page.locator(selector).last();
  await element.scrollIntoViewIfNeeded();
  expect(await element.evaluate(node => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.top >= 0 && r.bottom <= innerHeight && !!hit && (node.contains(hit) || hit.contains(node));
  })).toBe(true);
}

export async function reopenRoom(page: Page, type = 'Комната'): Promise<void> {
  const doc = await onlyDoc(page);
  await page.locator('.list-row').filter({ hasText: doc.title || doc.address }).click();
  await openRoom(page, type);
}
