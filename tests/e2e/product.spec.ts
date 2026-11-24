import { test, expect } from './demo-fixture';
import { readFile, stat, mkdir } from 'node:fs/promises';
import {renderPdfFirstPage} from './pdf-render';
import { createDocument, addRoom, openRoom, openDescription, finishDialog, documents, onlyDoc, evidence, syntheticPhoto, withOrientation6, upload, noOverflow, visibleHitTarget, reopenRoom } from './helpers';

test('Q01/Q02/Q06/Q07: основной поток, реальная IndexedDB и reload', async ({ page }, info) => {
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText(/пока нет документов/i)).toBeVisible();
  await expect(page.getByText(/браузер|локально/i).first()).toBeVisible();
  await evidence(page, info, '01-empty-library', {});
  await createDocument(page);
  const original = await onlyDoc(page);
  expect(original.inspectionDate).toBe('2026-02-03');
  expect(original.id).toMatch(/^[0-9a-f-]{36}$/i);
  await evidence(page, info, '02-new-document', { id: original.id });
  await addRoom(page);
  if (!(await page.getByRole('heading', { name: /^комната$/i }).isVisible())) await openRoom(page);
  await expect(page.getByText(/дефектов (?:пока )?нет|нет дефектов|не отмечено/i).first()).toBeVisible();
  const description = await openDescription(page);
  await description.fill('Синтетическое описание комнаты. <img src=x onerror="window.__qaInjected=true">');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.description).toContain('<img');
  await finishDialog(page);
  await page.reload();
  expect((await onlyDoc(page)).id).toBe(original.id);
  expect((await onlyDoc(page)).rooms[0]!.description).toContain('Синтетическое описание');
  expect(await page.evaluate(() => '__qaInjected' in window)).toBe(false);
  await evidence(page, info, '03-room-reloaded', { id: original.id, revision: (await onlyDoc(page)).revision });
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('Q03: все 36 пунктов и сохранение отметок', async ({ page }, info) => {
  const expected = JSON.parse(await readFile('src/checklists.json', 'utf8')) as Record<string, { id: string; title: string; hint: string }[]>;
  expect(Object.keys(expected)).toHaveLength(6);
  expect(new Set(Object.values(expected).flat().map(item => item.id)).size).toBe(36);
  await createDocument(page);
  const observed: { type: string; count: number }[] = [];
  for (const [type, items] of Object.entries(expected)) {
    await addRoom(page, type);
    if (!(await page.getByRole('checkbox').count())) {
      if (!(await page.getByRole('heading', { name: type, exact: true }).isVisible())) await openRoom(page, type);
      await page.getByRole('button', { name: /проверено.*из 6/i }).click();
    }
    expect(items).toHaveLength(6);
    await expect(page.getByRole('checkbox')).toHaveCount(6);
    for (const item of items) {
      await expect(page.getByRole('checkbox', { name: item.title, exact: true })).toBeVisible();
    }
    await page.getByRole('checkbox', { name: items[0]!.title, exact: true }).check();
    await expect.poll(async () => (await onlyDoc(page)).rooms.find(room => room.type === type)?.checkedItemIds).toEqual([items[0]!.id]);
    await page.reload();
    await reopenRoom(page, type);
    const expand = page.getByRole('button', { name: /проверено.*из 6/i });
    if (await expand.getAttribute('aria-expanded') === 'false') await expand.click();
    await expect(page.getByRole('checkbox', { name: items[0]!.title, exact: true })).toBeChecked();
    observed.push({ type, count: items.length });
    await page.getByRole('button', { name: /^к документу$/i }).click();
  }
  await evidence(page, info, '04-checklists', observed);
});

test('Q04/Q05: настоящие фото, orientation, JPEG и лимиты', async ({ page }, info) => {
  await createDocument(page);
  await addRoom(page);
  if (!(await page.locator('input[type=file]').count())) await openRoom(page);
  const large = withOrientation6(await syntheticPhoto(page));
  await upload(page, [large]);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.photos.length).toBe(1);
  let photo = (await onlyDoc(page, true)).rooms[0]!.photos[0]!;
  expect(photo.blob.type).toBe('image/jpeg');
  expect([photo.width, photo.height]).toEqual([1200, 1600]);
  expect(Buffer.from(photo.blob.bytes).includes(Buffer.from('Exif'))).toBe(false);
  expect(Buffer.from(photo.blob.bytes).includes(Buffer.from('QA-GPS-METADATA'))).toBe(false);
  const small = await syntheticPhoto(page, 320, 240);
  await upload(page, [small]);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.photos.length).toBe(2);
  photo = (await onlyDoc(page)).rooms[0]!.photos[1]!;
  expect([photo.width, photo.height]).toEqual([320, 240]);
  await upload(page, Array.from({ length: 13 }, () => small));
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.photos.length).toBe(15);
  await expect(page.getByRole('button', { name: 'Фото', exact: true })).toBeDisabled();
  expect((await onlyDoc(page)).rooms[0]!.photos).toHaveLength(15);
  await page.reload();
  expect((await onlyDoc(page)).rooms[0]!.photos).toHaveLength(15);
  await evidence(page, info, '05-photos-limit', { stored: 15, oriented: [1200, 1600], small: [320, 240], metadataRemoved: true });
});

test('Q08: отказ реальной записи сохраняет draft и позволяет retry', async ({ page }, info) => {
  await createDocument(page);
  await addRoom(page);
  if (!(await page.getByRole('heading', { name: /^комната$/i }).isVisible())) await openRoom(page);
  const field = await openDescription(page);
  await field.fill('Подтверждённый исходный текст');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.description).toBe('Подтверждённый исходный текст');
  await page.evaluate(() => {
    const prototype = IDBObjectStore.prototype;
    const original = prototype.put;
    Object.defineProperty(window, '__qaRestorePut', { configurable: true, value: () => { prototype.put = original; } });
    prototype.put = function () { throw new DOMException('QA injected write refusal', 'QuotaExceededError'); };
  });
  await field.fill('Несохранённый черновик QA');
  await page.keyboard.press('Tab');
  await expect(page.getByText(/мест[ао]|квот|не.*сохран|ошибка.*запис/i).first()).toBeVisible();
  await expect(field).toHaveValue('Несохранённый черновик QA');
  expect((await onlyDoc(page)).rooms[0]!.description).toBe('Подтверждённый исходный текст');
  await evidence(page, info, '06-quota-draft', { draftPreserved: true, committedPreserved: true, injected: 'IDBObjectStore.put QuotaExceededError' });
  await page.evaluate(() => (window as unknown as { __qaRestorePut: () => void }).__qaRestorePut());
  await page.getByRole('dialog').getByRole('button', { name: /повтор/i }).click();
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.description).toBe('Несохранённый черновик QA');
  await page.reload();
  expect((await onlyDoc(page)).rooms[0]!.description).toBe('Несохранённый черновик QA');
});

test('Q09: две вкладки не теряют более новую запись', async ({ page, context }, info) => {
  await createDocument(page);
  await addRoom(page);
  if (!(await page.getByRole('heading', { name: /^комната$/i }).isVisible())) await openRoom(page);
  const stale = await context.newPage();
  // Block notification delivery only; retain actual IDB revision arbitration.
  await stale.addInitScript(() => {
    const channel = window.BroadcastChannel;
    if (channel) Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: class { postMessage() {} close() {} addEventListener() {} } });
  });
  await stale.goto(page.url());
  await reopenRoom(stale);
  const staleField = await openDescription(stale);
  const currentField = await openDescription(page);
  await currentField.fill('Вкладка A — подтверждённая новая запись');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.description).toBe('Вкладка A — подтверждённая новая запись');
  await staleField.fill('Вкладка B — устаревший черновик');
  await stale.keyboard.press('Tab');
  await expect(stale.getByText(/конфликт|другой вкладк|изменён.*вкладк/i).first()).toBeVisible();
  expect((await onlyDoc(page)).rooms[0]!.description).toBe('Вкладка A — подтверждённая новая запись');
  await expect(staleField).toHaveValue('Вкладка B — устаревший черновик');
  await evidence(stale, info, '07-two-tabs-conflict', { committedPreserved: true, draftPreserved: true });
});

test('Q10/Q11: фактически скачанный PDF, 30 фото, текст/A4/дата/размер/время', async ({ page }, info) => {
  test.setTimeout(180_000);
  await createDocument(page, 'QA: адрес / запрещённые \\ символы');
  let seed = 17;
  for (const type of ['Комната', 'Кухня']) {
    await addRoom(page, type);
    if (!(await page.locator('input[type=file]').count())) await openRoom(page, type);
    const photos = [];
    for(let i = 0; i < 15; i++) photos.push(await syntheticPhoto(page, 1800, 1200, true, seed++));
    await upload(page, photos, type);
    await expect.poll(async () => (await onlyDoc(page)).rooms.find(room => room.type === type)?.photos.length, { timeout: 30_000 }).toBe(15);
    for(let i = 0; i < 15; i++) {
      await page.locator('.photo-open').nth(i).click();
      await page.getByLabel('Подпись к фото').fill(`Фото ${type} номер ${i + 1}`);
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: /^к документу$/i }).click();
  }
  const before = await onlyDoc(page, false, true);
  expect(new Set(before.rooms.flatMap(room=>room.photos.map(photo=>photo.blob.sha256))).size).toBe(30);
  const started = Date.now();
  await page.getByRole('button', { name: /сформировать(?: PDF)?/i }).click();
  const downloadButton = page.getByRole('link', { name: /скачать PDF/i });
  await expect(downloadButton).toBeEnabled({ timeout: 30_000 });
  const elapsedMs = Date.now() - started;
  expect.soft(elapsedMs).toBeLessThanOrEqual(15_000);
  const downloadEvent = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).not.toMatch(/[<>:"/\\|?*\x00-\x1f]/);
  await mkdir('docs/evidence/qa',{recursive:true});
  const file = 'docs/evidence/qa/actual-v4-pdf-30.pdf';
  await download.saveAs(file);
  const bytes=(await stat(file)).size;
  const after=await onlyDoc(page,false,true);
  const idbByteAndMetadataIdentity=JSON.stringify(after)===JSON.stringify(before);
  expect.soft(after).toEqual(before);
  await info.attach('pdf30-performance', { body: JSON.stringify({elapsedMs,bytes,limitBytes:20_000_000}),contentType:'application/json' });
  await renderPdfFirstPage(page,info,file);
  expect.soft(bytes).toBeLessThanOrEqual(20_000_000);
  const parserModule = 'pdfjs-dist/legacy/build/pdf.mjs';
  const pdfjs = await import(parserModule);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await readFile(file)), useSystemFonts: false }).promise;
  const lines: string[] = [];
  const dimensions: number[][] = [];
  let imageDraws = 0;
  for (let index = 1; index <= pdf.numPages; index++) {
    const pdfPage = await pdf.getPage(index);
    dimensions.push([pdfPage.view[2] - pdfPage.view[0], pdfPage.view[3] - pdfPage.view[1]]);
    const content = await pdfPage.getTextContent();
    const operators = await pdfPage.getOperatorList();
    imageDraws += operators.fnArray.filter((op: number) => [pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintJpegXObject,pdfjs.OPS.paintInlineImageXObject].includes(op)).length;
    lines.push(content.items.map((item: { str?: string }) => item.str || '').join(' '));
  }
  for (const [width, height] of dimensions) { expect(width).toBeCloseTo(595.28, 0); expect(height).toBeCloseTo(841.89, 0); }
  const text = lines.join(' ');
  expect(imageDraws).toBe(30);
  for(const room of before.rooms) for(const photo of room.photos) expect(text).toContain(photo.caption);
  expect(text).toContain('Осмотр квартиры');
  expect(text).toContain('Дефектов не отмечено');
  expect(text.match(/Дата осмотра/g)).toHaveLength(1);
  expect(text).toMatch(/Дата осмотра:\s*03\.02\.2026\s*$/);
  expect(text).not.toMatch(/Проверено|Входная дверь|Стены и обои/);
  await evidence(page, info, 'v4-pdf30-metrics', { elapsedMs, bytes: (await stat(file)).size, pages: pdf.numPages, imageDraws, distinctInputSeeds: 30, dimensions, text,idbByteAndMetadataIdentity,beforeRevision:before.revision,afterRevision:after.revision,beforePhotos:before.rooms.flatMap(room=>room.photos),afterPhotos:after.rooms.flatMap(room=>room.photos) });
  await pdf.destroy();
});

for (const viewport of [{ width: 430, height: 887 }, { width: 360, height: 640 }, { width: 320, height: 568 }, { width: 1366, height: 768 }]) {
  test(`UI: ${viewport.width}×${viewport.height}, 200% text и достижимость`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await createDocument(page);
    await addRoom(page);
    if (!(await page.getByRole('heading', { name: /^комната$/i }).isVisible())) await openRoom(page);
    const field = await openDescription(page);
    await field.fill('Очень длинный синтетический текст для проверки переносов и достижения последних действий. '.repeat(12));
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await onlyDoc(page)).rooms[0]?.description).toContain('Очень длинный');
    await finishDialog(page);
    await upload(page, [await syntheticPhoto(page, 320, 240)]);
    await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
    await page.getByRole('button', { name: 'Открыть фото 1', exact: true }).click();
    await page.getByLabel('Подпись к фото').fill('Последняя подпись фотографии комнаты');
    await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos[0]!.caption).toBe('Последняя подпись фотографии комнаты');
    await page.keyboard.press('Escape');
    await noOverflow(page);
    const scale = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,p,label,button,input,textarea,a,summary,figcaption')).filter(el => el.getClientRects().length);
      const before = elements.map(element => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
      for (const row of before) row.element.style.fontSize = `${row.size * 2}px`;
      return before.map(row => ({ tag: row.element.tagName, baseline: row.size, actual: parseFloat(getComputedStyle(row.element).fontSize) }));
    });
    expect(scale.length).toBeGreaterThan(5);
    for (const row of scale) expect(row.actual / row.baseline).toBeCloseTo(2, 2);
    await noOverflow(page);
    await visibleHitTarget(page, 'main button, main a');
    const reachability = [];
    for (const selector of ['.photo-open', 'figcaption', '.photo-add', 'section:has(.photo-grid) h2']) {
      const element = page.locator(selector).last();
      await element.evaluate(node => node.scrollIntoView({block: 'center', inline: 'nearest'}));
      const result = await element.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const bar = document.querySelector('.action-bar')!.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { top: rect.top, bottom: rect.bottom, barTop: bar.top, viewport: innerHeight, hit: !!hit && (node.contains(hit) || hit.contains(node)) };
      });
      expect(result.top).toBeGreaterThanOrEqual(0);
      expect(result.bottom).toBeLessThanOrEqual(Math.min(result.barTop, result.viewport));
      expect(result.hit).toBe(true);
      reachability.push({ selector, ...result });
    }
    await evidence(page, info, `v3-ui-${viewport.width}-${viewport.height}-200`, { scale, reachability });
  });
}
