import { test, expect } from './demo-fixture';
import { createDocument, addRoom, onlyDoc, syntheticPhoto, upload, evidence, finishDialog, openDescription } from './helpers';

test('V2: atomic batch14+2, delayed decoder и guards структурных действий', async ({ page }, info) => {
  await createDocument(page); await addRoom(page);
  const jpeg = await syntheticPhoto(page, 320, 240);
  await upload(page, Array.from({length: 14}, () => jpeg));
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos.length).toBe(14);
  await upload(page, [jpeg, jpeg]);
  await expect(page.getByRole('alert').filter({ hasText: /набор.*не добавлен/i })).toBeVisible();
  expect((await onlyDoc(page)).rooms[0]!.photos).toHaveLength(14);
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { __qaReleaseDecode: release });
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      await gate; return (original as Function)(...args);
    }) as typeof createImageBitmap;
  });
  await upload(page, [jpeg]);
  await expect(page.getByRole('status').filter({ hasText: /обрабатываем фото/i })).toBeVisible();
  await page.getByRole('button', { name: 'К документу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Комната', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Действия', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Действия' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Добавить(?: дефект)?$/, exact: true }).click();
  await expect(page.getByLabel('Название дефекта')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __qaReleaseDecode: () => void }).__qaReleaseDecode());
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos.length).toBe(15);
  expect((await onlyDoc(page)).rooms).toHaveLength(1);
  expect((await onlyDoc(page)).rooms[0]!.defects).toHaveLength(0);
  await evidence(page, info, 'v2-atomic-delayed-guards', { rejectedBatch: [14, 2, 14], completed: 15, injectedDecodeGate: true });
});

test('V2: discard нового autosaved дефекта и восстановление существующего', async ({ page }, info) => {
  await createDocument(page); await addRoom(page);
  await page.getByRole('button', { name: /^Добавить(?: дефект)?$/, exact: true }).click();
  await page.getByLabel('Название дефекта').fill('Новый промежуточно сохранённый');
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.defects.length).toBe(1);
  await page.getByLabel('Название дефекта').fill('');
  await page.getByRole('button', { name: 'К комнате', exact: true }).click();
  await page.getByRole('button', { name: 'Отбросить ввод', exact: true }).click();
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.defects.length).toBe(0);
  await page.getByRole('button', { name: /^Добавить(?: дефект)?$/, exact: true }).click();
  await page.getByLabel('Название дефекта').fill('Существующий валидный');
  await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.defects[0]?.title).toBe('Существующий валидный');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.locator('.list-row').filter({hasText: 'Существующий валидный'}).click();
  await page.getByRole('button', { name: 'Действия', exact: true }).click();
  await page.getByRole('button', { name: 'Название дефекта', exact: true }).click();
  await page.getByLabel('Название дефекта').fill(''); await finishDialog(page);
  await page.getByRole('button', { name: 'К комнате', exact: true }).click();
  await page.getByRole('button', { name: 'Отбросить ввод', exact: true }).click();
  const doc = await onlyDoc(page);
  expect(doc.rooms[0]!.defects).toHaveLength(1);
  expect(doc.rooms[0]!.defects[0]!.title).toBe('Существующий валидный');
  await evidence(page, info, 'v2-discard-defect', { newRemoved: true, existingRestored: true });
});
