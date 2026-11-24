import { test, expect } from './demo-fixture';
import { readFile, mkdir } from 'node:fs/promises';
import { createDocument, addRoom, onlyDoc, syntheticPhoto, upload, evidence, openDescription, finishDialog, reopenRoom } from './helpers';

test('Q06/Q10: заполненный UI, дефект6, invalidfiles, длинная подпись PDF', async ({ page }, info) => {
  const errors: string[] = []; const external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== '127.0.0.1') external.push(r.url()); });
  await createDocument(page, 'Синтетический адрес, 12');
  await evidence(page, info, 'v2-inline-document', {});
  // The creation route stays inline; adding the first room awaits committed metadata.
  await addRoom(page);
  const jpeg = await syntheticPhoto(page, 320, 240);
  await upload(page, [jpeg]);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
  await page.getByRole('button', { name: 'Открыть фото 1', exact: true }).click();
  const longCaption = Array.from({ length: 420 }, (_, i) => `подпись${i}`).join(' ');
  await page.getByLabel('Подпись к фото').fill(longCaption);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos[0]!.caption).toBe(longCaption);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Фото', exact: true }).click();
  await page.locator('input[multiple]').setInputFiles([
    { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('broken synthetic jpeg') },
    { name: 'text.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic text') },
  ]);
  await expect(page.getByRole('alert').filter({hasText: /Не удалось прочитать файлов: 2/})).toBeVisible();
  expect((await onlyDoc(page)).rooms[0]!.photos).toHaveLength(1);
  const field = await openDescription(page);
  await field.fill('Описание комнаты: кириллица и длинный текст. '.repeat(80));
  await finishDialog(page);
  await page.getByRole('button', { name: /^Добавить(?: дефект)?$/, exact: true }).click();
  await page.getByLabel('Название дефекта').fill('   ');
  expect((await onlyDoc(page)).rooms[0]!.defects).toHaveLength(0);
  await page.getByLabel('Название дефекта').fill('Трещина на стене');
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.defects.length).toBe(1);
  await upload(page, Array.from({length: 5}, () => jpeg));
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.defects[0]!.photos.length).toBe(5);
  await upload(page, [jpeg, jpeg]);
  await expect(page.getByRole('alert').filter({hasText: /набор не добавлен/})).toBeVisible();
  expect((await onlyDoc(page)).rooms[0]!.defects[0]!.photos).toHaveLength(5);
  await upload(page, [jpeg]);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.defects[0]!.photos.length).toBe(6);
  await expect(page.getByRole('button', {name: 'Фото', exact: true})).toBeDisabled();
  await evidence(page, info, 'v2-filled-defect', { photos: 6 });
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: /Проверено/ }).click();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /Что проверить/ }).click();
  await evidence(page, info, 'v2-filled-help', {});
  await page.getByRole('button', { name: /К осмотру/ }).click();
  await evidence(page, info, 'v2-filled-room', {});
  await page.getByRole('button', { name: 'К документу', exact: true }).click();
  await addRoom(page, 'Кухня');
  await page.getByRole('button', { name: 'К документу', exact: true }).click();
  await evidence(page, info, 'v2-filled-document', {});
  await page.getByRole('button', { name: 'В библиотеку', exact: true }).click();
  await evidence(page, info, 'v2-filled-library', {});
  await page.reload(); await reopenRoom(page);
  const before = await onlyDoc(page);
  expect(before.rooms[0]!.defects[0]!.photos).toHaveLength(6);
  expect(before.rooms[0]!.photos[0]!.caption).toBe(longCaption);
  await page.getByRole('button', { name: 'К документу', exact: true }).click();
  await page.getByRole('button', {name: /Сформировать PDF/}).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', {name: 'Скачать PDF'}).click();
  await mkdir('docs/evidence/qa',{recursive:true});
  const file = 'docs/evidence/qa/actual-rich.pdf'; await (await download).saveAs(file);
  const module = 'pdfjs-dist/legacy/build/pdf.mjs'; const pdfjs = await import(module);
  const pdf = await pdfjs.getDocument({data: new Uint8Array(await readFile(file))}).promise;
  let text = ''; const pages: {page: number; text: string; images: number; dateY?: number}[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const current = await pdf.getPage(n); const content = await current.getTextContent();
    const pageText = content.items.map((i: {str?: string}) => i.str || '').join(' ');
    const ops = await current.getOperatorList();
    const images = ops.fnArray.filter((op: number) => [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintJpegXObject, pdfjs.OPS.paintInlineImageXObject].includes(op)).length;
    const date = content.items.find((i: {str?: string}) => i.str?.startsWith('Дата осмотра:'));
    if (date) { expect(n).toBe(pdf.numPages); expect(date.transform[4]).toBeLessThan(60); expect(date.transform[5]).toBeLessThan(65); }
    if (/Продолжение подписи/.test(pageText)) expect(images).toBeGreaterThan(0);
    pages.push({ page: n, text: pageText, images, dateY: date?.transform[5] }); text += pageText + ' ';
  }
  expect(text).toContain('Трещина на стене'); expect(text).toContain('Кухня');
  expect(text).toContain('Дефектов не отмечено'); expect(text).toContain('Продолжение подписи');
  for(let i = 0; i < 420; i++) expect(text.match(new RegExp(`подпись${i}(?![0-9])`, 'g'))).toHaveLength(1);
  expect(text.match(/Дата осмотра:/g)).toHaveLength(1);
  expect(text).not.toMatch(/Проверено|Входная дверь/);
  expect((await onlyDoc(page)).revision).toBe(before.revision);
  expect(errors).toEqual([]); expect(external).toEqual([]);
  await evidence(page, info, 'v2-rich-pdf', {pages, noExternalRequests: true}); await pdf.destroy();
});
