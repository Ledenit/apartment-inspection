// Independent QA scenarios; execution and fixture/selector adaptation by the primary agent.
import { test, expect, type Page } from "./demo-fixture";
import { documents } from "./helpers";

const sourceId = "qa-f13-source";
async function seed(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", {name: /новый документ/i})).toBeVisible();
  await page.evaluate(async id => {
    const canvas = document.createElement("canvas");
    canvas.width = 24; canvas.height = 16;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ec253a"; ctx.fillRect(0, 0, 12, 16);
    ctx.fillStyle = "#2f74de"; ctx.fillRect(12, 0, 12, 16);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), "image/jpeg", .85));
    const photo = (_id: string, caption: string) => ({id: crypto.randomUUID(), blob, caption, width: 24, height: 16});
    const db = await new Promise<IDBDatabase>((resolve, reject) => {const req = indexedDB.open("apartment-inspection-v1"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);});
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("documents", "readwrite");
        tx.objectStore("documents").put({
          id, title: "Независимый QA F13", address: "Синтетическая улица, 24", inspectionDate: "2026-11-24",
          description: "Документ для проверки", createdAt: 1, updatedAt: 2, revision: 3,
          rooms: [
            {id: "qa-room-a", type: "Кухня", name: "Кухня QA", description: "Первое помещение", checkedItemIds: ["kitchen-cabinets", "kitchen-floor"],
              photos: [photo("qa-photo-a", "Первое фото"), photo("qa-photo-b", "Второе фото")],
              defects: [{id: "qa-defect", title: "Трещина QA", description: "У окна", photos: [photo("qa-defect-photo", "Фото дефекта")]}]},
            {id: "qa-room-b", type: "Комната", name: "Пустая QA", description: "Второе помещение", checkedItemIds: [], photos: [], defects: []},
          ],
        });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
    } finally {db.close();}
  }, sourceId);
  await page.reload();
  await page.getByText("Независимый QA F13", {exact: true}).click();
  await expect(page.getByRole("heading", {level: 1})).toHaveText("Независимый QA F13");
}
async function duplicate(page: Page) {
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await page.getByRole("button", {name: "Дублировать документ", exact: true}).click();
}
async function preview(page: Page) {
  await page.getByRole("button", {name: "Сформировать PDF", exact: true}).click();
  await expect(page.getByRole("link", {name: "Скачать PDF", exact: true})).toBeVisible({timeout: 30000});
}
function ids(d: any): string[] {
  return [d.id, ...d.rooms.flatMap((r: any) => [r.id, ...r.photos.map((p: any) => p.id), ...r.defects.flatMap((f: any) => [f.id, ...f.photos.map((p: any) => p.id)])])];
}
function content(value: any): any {
  if (Array.isArray(value)) return value.map(content);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !["id", "createdAt", "updatedAt", "revision"].includes(k)).map(([k,v]) => [k, content(v)]));
  return value;
}
test("F13 copy preserves complete data/photos, survives reload, edit/delete is independent", async ({page}) => {
  await seed(page);
  const [before] = await documents(page, true);
  await duplicate(page);
  await expect.poll(async () => (await documents(page)).length).toBe(2);
  const rows = await documents(page, true);
  const source = rows.find(d => d.id === sourceId)!;
  const copy: any = rows.find(d => d.id !== sourceId)!;
  expect(source).toEqual(before);
  expect(copy.title).toBe(`${before.title} (копия)`);
  expect(copy.revision).toBe(1);
  expect(content({...copy, title: before.title})).toEqual(content(before));
  expect(new Set(ids(copy)).size).toBe(ids(copy).length);
  for (const id of ids(copy)) expect(ids(before)).not.toContain(id);
  expect(copy.createdAt).toBeGreaterThan(2);
  await expect(page.getByRole("heading", {level: 1})).toHaveText(copy.title);
  await page.reload();
  expect(await documents(page, true)).toEqual(rows);
  await page.getByText(copy.title, {exact: true}).click();
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await page.getByRole("button", {name: "Изменить данные документа", exact: true}).click();
  await page.getByLabel("Название документа", {exact: true}).fill("Изменённая копия QA");
  await page.getByRole("dialog").getByRole("button", {name: "Готово", exact: true}).click();
  await page.getByRole("button", {name: "В библиотеку", exact: true}).click();
  expect((await documents(page, true)).find(d => d.id === sourceId)).toEqual(before);
  await page.getByText("Изменённая копия QA", {exact: true}).click();
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await page.getByRole("button", {name: "Удалить документ", exact: true}).click();
  await page.getByRole("dialog").getByRole("button", {name: "Удалить", exact: true}).click();
  await expect.poll(async () => (await documents(page)).length).toBe(1);
  expect(await documents(page, true)).toEqual([before]);
});
test("F13 stale source rejects copy without overwriting another tab", async ({page}) => {
  await seed(page);
  await page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>(resolve => {const r = indexedDB.open("apartment-inspection-v1"); r.onsuccess = () => resolve(r.result);});
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite"), store = tx.objectStore("documents"), r = store.get(id);
      r.onsuccess = () => store.put({...r.result, revision: r.result.revision + 1, description: "Другая вкладка"});
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    }); db.close();
  }, sourceId);
  const before = await documents(page, true);
  await duplicate(page);
  await expect(page.getByRole("alert")).toContainText("изменён в другой вкладке");
  expect(await documents(page, true)).toEqual(before);
});
test("F13 quota rollback, retry and immediate repeat click", async ({page}) => {
  await seed(page);
  const before = await documents(page, true);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    (window as any).__restoreAdd = () => { IDBObjectStore.prototype.add = original; };
    IDBObjectStore.prototype.add = function() {throw new DOMException("Synthetic quota", "QuotaExceededError");};
  });
  await duplicate(page);
  await expect(page.getByRole("alert")).toContainText("Недостаточно места");
  expect(await documents(page, true)).toEqual(before);
  await page.evaluate(() => (window as any).__restoreAdd());
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await page.getByRole("button", {name: "Дублировать документ", exact: true}).evaluate((button: HTMLButtonElement) => {button.click(); button.click();});
  await expect(page.getByRole("heading", {level: 1})).toHaveText("Независимый QA F13 (копия)");
  expect(await documents(page)).toHaveLength(2);
});
for (const mode of ["success", "abort", "failure"] as const) {
  test(`F13 share ${mode}: exact generated PDF File and active user gesture`, async ({page}) => {
    await page.addInitScript(mode => {
      (window as any).__shares = [];
      Object.defineProperty(navigator, "canShare", {configurable: true, value: (d: ShareData) => d.files?.length === 1 && d.files[0].type === "application/pdf"});
      Object.defineProperty(navigator, "share", {configurable: true, value: (d: ShareData) => {
        (window as any).__shares.push({file: d.files![0], active: navigator.userActivation.isActive});
        return mode === "success" ? Promise.resolve() : Promise.reject(new DOMException("QA", mode === "abort" ? "AbortError" : "NotAllowedError"));
      }});
    }, mode);
    await seed(page); await preview(page);
    const bytes = await page.getByRole("link", {name: "Скачать PDF", exact: true}).evaluate(async (a: HTMLAnchorElement) => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    await page.getByRole("button", {name: "Поделиться PDF", exact: true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).__shares.length)).toBe(1);
    const shared = await page.evaluate(async () => {const c = (window as any).__shares[0]; return {active: c.active, name: c.file.name, type: c.file.type, bytes: Array.from(new Uint8Array(await c.file.arrayBuffer()))};});
    expect(shared.active).toBe(true); expect(shared.name).toMatch(/\.pdf$/i); expect(shared.type).toBe("application/pdf"); expect(shared.bytes).toEqual(bytes);
    if (mode === "failure") await expect(page.getByRole("alert")).toContainText("Не получилось поделиться PDF");
    else await expect(page.getByText(/Не получилось поделиться PDF/)).toHaveCount(0);
    await expect(page.getByRole("link", {name: "Скачать PDF", exact: true})).toBeVisible();
  });
}
test("F13 unsupported sharing, PDF status and responsive reachability", async ({page}, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {configurable: true, value: undefined});
    Object.defineProperty(navigator, "canShare", {configurable: true, value: undefined});
  });
  await seed(page); await preview(page);
  await expect(page.getByRole("button", {name: "Поделиться PDF", exact: true})).toHaveCount(0);
  await expect(page.getByText(/отправка PDF через системное меню недоступна/)).toBeVisible();
  for (const width of [430, 320, 1366]) {
    await page.setViewportSize({width, height: 887});
    await expect(page.getByRole("heading", {name: "Документ готов", exact: true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", {name: "Просмотреть PDF", exact: true}).click();
    await expect(page.locator("iframe.pdf-preview")).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: info.outputPath(`pdf-ready-${width}.png`), fullPage: true, animations: "allow"});
  }
});
