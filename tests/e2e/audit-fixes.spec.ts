import {test, expect} from "./demo-fixture";
import {createDocument, addRoom, onlyDoc, syntheticPhoto} from "./helpers";

test("empty room, inline defect title, all three photo entry points and camera/gallery file chooser", async ({page}) => {
  await createDocument(page); await addRoom(page);
  await expect(page.getByRole("heading", {name: "Дефекты пока не отмечены", exact: true})).toBeVisible();
  await expect(page.getByText("Если заметите повреждение, добавьте его", {exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Добавить дефект", exact: true}).click();
  const title = page.getByLabel("Название дефекта", {exact: true});
  await expect(title).toBeFocused();
  expect(await title.evaluate(el => !!el.closest("h1"))).toBe(true);
  await expect(page.locator(".photo-add")).toHaveCount(3);
  const jpeg = await syntheticPhoto(page, 320, 240);
  for (let i = 0; i < 3; i++) {
    await page.locator(".photo-add").nth(i).click();
    await expect(page.getByRole("button", {name: "Снять камерой", exact: true})).toBeVisible();
    await expect(page.locator("input[capture]")).toHaveAttribute("capture", "environment");
    await expect(page.locator("input[multiple]")).toHaveAttribute("accept", "image/*");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", {name: i === 0 ? "Снять камерой" : "Выбрать из галереи", exact: true}).click();
    await (await chooser).setFiles([]);
    expect((await onlyDoc(page)).rooms[0].defects).toHaveLength(0);
    await page.keyboard.press("Escape");
  }
  const caseSensitiveTitle = "Царапина У Окна";
  await title.fill(caseSensitiveTitle);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0].defects[0]?.title).toBe(caseSensitiveTitle);
  await page.locator(".photo-add").last().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", {name: "Выбрать из галереи", exact: true}).click();
  await (await chooser).setFiles([{name: "qa.jpg", mimeType: "image/jpeg", buffer: jpeg}]);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0].defects[0].photos.length).toBe(1);
  await expect(page.locator(".photo-add")).toHaveCount(1);
  await title.fill("");
  await page.getByRole("button", {name: "К комнате", exact: true}).click();
  await expect(page.getByRole("dialog")).toContainText("Название дефекта обязательно");
  await page.getByRole("dialog").getByRole("button", {name: "Продолжить редактирование", exact: true}).click();
  await title.fill(caseSensitiveTitle);
  await page.getByRole("button", {name: "Сохранить", exact: true}).click();
  await expect(page.locator(".list-row").filter({hasText: caseSensitiveTitle})).toHaveCount(1);
});

test("compact action menu stays in the viewport and closes with backdrop/Escape and restores focus", async ({page}) => {
  await createDocument(page); await addRoom(page);
  for (const viewport of [{width: 430, height: 887}, {width: 320, height: 568}]) {
    await page.setViewportSize(viewport);
    const opener = page.getByRole("button", {name: "Действия", exact: true});
    await opener.click();
    const menu = page.getByRole("dialog", {name: "Действия", exact: true});
    const r = await menu.boundingBox();
    expect(r!.x).toBeGreaterThanOrEqual(0); expect(r!.y).toBeGreaterThanOrEqual(0);
    expect(r!.x + r!.width).toBeLessThanOrEqual(viewport.width);
    expect(r!.y + r!.height).toBeLessThanOrEqual(viewport.height);
    for (let i = 0; i < 5; i++) {await page.keyboard.press("Tab"); expect(await menu.evaluate(el => el.contains(document.activeElement))).toBe(true);}
    await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
    await opener.click(); await page.mouse.click(2, 2);
    await expect(menu).toHaveCount(0); await expect(opener).toBeFocused();
  }
});

test("photo processing rejects disguised HTML and sends only processed JPEG to the same-origin server", async ({page}) => {
  const outgoing: string[] = [], uploads: {url: string; method: string; type: string; bytes: number[]}[] = [];
  await page.route("**/*", async route => {
    const request = route.request();
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") {outgoing.push(request.url()); await route.abort();}
    else await route.continue();
  });
  page.on("request", r => {if (!["GET", "HEAD"].includes(r.method())) uploads.push({url:r.url(),method:r.method(),type:r.headers()['content-type'] ?? '',bytes:Array.from(r.postDataBuffer() ?? [])});});
  await createDocument(page); await addRoom(page);
  await page.getByRole("button", {name: "Фото", exact: true}).click();
  await page.locator("input[multiple]").setInputFiles({name: "bad.jpg", mimeType: "image/jpeg", buffer: Buffer.from('<html><script>window.__qaUnsafe=true</script></html>')});
  await expect(page.getByRole("alert")).toContainText("Не удалось прочитать");
  expect((await onlyDoc(page)).rooms[0].photos).toHaveLength(0);
  expect(uploads).toEqual([]);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><script>window.__qaUnsafe=true</script><image href="https://example.invalid/qa-synthetic" width="24" height="16"/><rect width="24" height="16" fill="red"/></svg>';
  await page.getByRole("button", {name: "Фото", exact: true}).click();
  await page.locator("input[multiple]").setInputFiles({name: "qa.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg)});
  await expect(page.getByRole("status").filter({hasText: "Обрабатываем фото"})).toHaveCount(0);
  const stored = await onlyDoc(page, true);
  for (const photo of stored.rooms[0].photos) {
    expect(photo.blob.type).toBe("image/jpeg"); expect(photo.blob.bytes.slice(0, 2)).toEqual([255, 216]);
    expect(Buffer.from(photo.blob.bytes).toString()).not.toContain("__qaUnsafe");
  }
  expect(await page.evaluate(() => "__qaUnsafe" in window)).toBe(false);
  expect(outgoing).toEqual([]);
  if (stored.rooms[0].photos.length) await expect.poll(() => uploads.length).toBeGreaterThan(0);
  for (const upload of uploads) {
    expect(new URL(upload.url).hostname).toBe('127.0.0.1');
    expect(new URL(upload.url).pathname).toMatch(/^\/api\/photos\/[0-9a-f-]+$/);
    expect(upload.method).toBe('PUT'); expect(upload.type).toBe('image/jpeg');
    expect(upload.bytes.slice(0,2)).toEqual([255,216]);
    expect(Buffer.from(upload.bytes).toString()).not.toContain('__qaUnsafe');
  }
});
