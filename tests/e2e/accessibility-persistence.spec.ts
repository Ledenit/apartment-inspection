import { test, expect, chromium } from './demo-fixture';
import { existsSync } from 'node:fs';
import { loginDemo } from './demo-fixture';
import { createDocument, addRoom, openRoom, openDescription, onlyDoc, documents, evidence, noOverflow, upload, syntheticPhoto, setInspectionDate } from './helpers';

test('Q07: закрытие браузерного профиля и повторное открытие настоящей БД', async ({}, info) => {
  const profile = info.outputPath('isolated-persistent-profile');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const options = { executablePath, headless: true, viewport: { width: 430, height: 887 }, locale: 'ru-RU' };
  let context = await chromium.launchPersistentContext(profile, options);
  try {
    const page = await context.newPage();
    await loginDemo(context, 'http://127.0.0.1:4173');
    // Explicit URL because this independently launched context has no configured baseURL.
    await page.goto('http://127.0.0.1:4173/');
    await page.getByRole('button', { name: /новый документ/i }).click();
    await setInspectionDate(page,'2026-02-03');
    await page.getByLabel(/^адрес/i).fill('QA повторное открытие профиля');
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await documents(page))[0]?.address).toBe('QA повторное открытие профиля');
    await addRoom(page);
    await upload(page, [await syntheticPhoto(page,320,240)]);
    await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos.length).toBe(1);
    await page.getByRole('button',{name:'Открыть фото 1',exact:true}).click();
    await page.getByLabel('Подпись к фото').fill('Подпись после reopening');
    await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.photos[0]!.caption).toBe('Подпись после reopening');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name: /^Добавить(?: дефект)?$/,exact:true}).click();
    await page.getByLabel('Название дефекта').fill('Дефект после reopening');
    await expect.poll(async () => (await onlyDoc(page)).rooms[0]!.defects.length).toBe(1);
    await page.getByRole('button',{name:'Сохранить',exact:true}).click();
    const saved = await onlyDoc(page);
    await context.close();
    context = await chromium.launchPersistentContext(profile, options);
    const reopened = await context.newPage();
    await reopened.goto('http://127.0.0.1:4173/');
    await expect(reopened.getByText('QA повторное открытие профиля', { exact: true }).first()).toBeVisible();
    const restored = await onlyDoc(reopened);
    expect(restored).toEqual(saved);
    expect(restored.rooms[0]!.photos[0]!.blob.size).toBeGreaterThan(0);
    await evidence(reopened, info, '10-browser-profile-reopened', { id: restored.id, revision: restored.revision, realPersistentProfile: true });
  } finally { await context.close(); }
});

test('UI: dialog keyboard trap, Escape и возврат focus', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await createDocument(page);
  await addRoom(page);
  if (!(await page.getByRole('heading', { name: /^комната$/i }).isVisible())) await openRoom(page);
  const trigger = page.getByRole('button', { name: 'Изменить описание', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(/описание/i);
  expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  const controls = dialog.locator('button,a[href],input,textarea,select,[tabindex="0"]');
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count + 2; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  for (let index = 0; index < count + 2; index++) {
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await controls.last().scrollIntoViewIfNeeded();
  await noOverflow(page);
  await evidence(page, info, 'v3-dialog-keyboard', { tabCycles: count + 2, shiftTabCycles: count + 2 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await trigger.evaluate(node => {
    const style = getComputedStyle(node);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
  })).toBe(true);
});

test('UI: checklist клавиатурой, семантика expanded и справка', async ({ page }, info) => {
  await createDocument(page);
  await addRoom(page);
  if (!(await page.getByRole('heading', { name: /^комната$/i }).isVisible())) await openRoom(page);
  const trigger = page.getByRole('button', { name: /проверено.*из 6/i });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await page.keyboard.press('Space');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const checkbox = page.getByRole('checkbox').first();
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(checkbox).not.toBeVisible();
  await page.keyboard.press('Enter');
  await expect(checkbox).toBeChecked();
  await evidence(page, info, '12-checklist-keyboard', { expanded: true, checked: true });
});
