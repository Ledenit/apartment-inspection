import { test, expect, loginDemo } from './demo-fixture';
import { createDocument, addRoom, onlyDoc, documents, evidence, upload, syntheticPhoto } from './helpers';

test('V2: default local calendar date и startup unavailable', async ({ page, browser }, info) => {
  await page.clock.install({time: new Date('2026-11-23T21:30:00Z')});
  await page.goto('/'); await page.getByRole('button', {name: /Новый документ/}).click();
  if(!await page.locator('input[type=date]').count()) await page.getByRole('button',{name:/^Дата осмотра:/i}).click();
  await expect(page.locator('input[type=date]')).toHaveAccessibleName(/Дата осмотра/);
  await expect(page.locator('input[type=date]')).toHaveValue('2026-11-24');
  const context = await browser.newContext(); const denied = await context.newPage();
  await loginDemo(context, 'http://127.0.0.1:4173');
  await denied.addInitScript(() => { indexedDB.open = () => {throw new DOMException('QA storage denied', 'SecurityError');}; });
  await denied.goto('http://127.0.0.1:4173/');
  await expect(denied.getByRole('alert')).toContainText(/не получилось|хранилищ/i);
  await evidence(denied, info, 'v2-storage-unavailable-local-date', {localDate: '2026-11-24', utcDate: '2026-11-23', injectedStorageDenial: true});
  await context.close();
});

test('V2: PNG JPEG conversion, chooser cancel, caption/delete и PDF error retry', async ({ page }, info) => {
  await createDocument(page); await addRoom(page);
  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas');c.width=320;c.height=240;return c.toDataURL('image/png').split(',')[1]!; }), 'base64');
  await page.getByRole('button', {name: 'Фото', exact:true}).click();
  await page.locator('input[multiple]').setInputFiles({name:'qa.png',mimeType:'image/png',buffer:png});
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
  let photo = (await onlyDoc(page)).rooms[0]!.photos[0]!;
  expect([photo.width,photo.height,photo.blob.type]).toEqual([320,240,'image/jpeg']);
  await page.getByRole('button', {name:'Фото',exact:true}).click();
  await page.locator('input[multiple]').setInputFiles([]);
  await page.keyboard.press('Escape');
  expect((await onlyDoc(page)).rooms[0]!.photos).toHaveLength(1);
  await page.getByRole('button', {name:'Открыть фото 1',exact:true}).click();
  await page.getByLabel('Подпись к фото').fill('Короткая подпись');
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos[0]!.caption).toBe('Короткая подпись');
  await page.getByRole('button', {name:'Удалить фото',exact:true}).click();
  await page.getByRole('button',{name:'Удалить',exact:true}).click();
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos.length).toBe(0);
  await page.getByRole('button',{name:'К документу',exact:true}).click();
  await page.route('**/assets/fonts/**', route => route.abort());
  // Network abort above is scoped; actual font URL is discovered from same-origin requests if different.
  await page.route('**/*.ttf', route => route.abort());
  await page.getByRole('button',{name:/Сформировать PDF/}).click();
  await expect(page.getByRole('alert')).toContainText(/Не получилось создать PDF/);
  await page.unroute('**/*.ttf'); await page.unroute('**/assets/fonts/**');
  await page.getByRole('button',{name:'Повторить',exact:true}).click();
  await expect(page.getByRole('link',{name:'Скачать PDF'})).toBeVisible();
  await evidence(page,info,'v2-png-pdf-retry',{pngConverted:true,chooserCancellation:true,photoDeleted:true,pdfErrorRetry:true});
});
