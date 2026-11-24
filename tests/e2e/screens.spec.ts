import {test, expect, type Page} from "./demo-fixture";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {documents, onlyDoc} from "./helpers";
import {createDocument} from "./helpers";

test("all application screens: Figma reference fixtures, desktop adaptation and reachable actions", async ({page}) => {
  test.setTimeout(120000);
  const output = path.resolve(process.env.QA_SCREEN_AUDIT_DIR || "docs/evidence/full-audit-2026-11-24/screens");
  await mkdir(output, {recursive: true});
  const errors: string[] = [], external: string[] = [], inventory: unknown[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => {if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== "127.0.0.1") external.push(r.url());});
  async function capture(name: string, reference: string) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => {})));
      window.scrollTo(0, 0);
    });
    await expect(page.locator("h1")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const geometry = await page.locator("main").evaluate(main => Array.from(main.querySelectorAll<HTMLElement>("h1,h2,.screen-header,.description,.checklist,.section-heading,.photo-grid,.action-bar")).map(el => {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el);
      return {tag: el.tagName, class: el.className, text: el.textContent?.slice(0, 120), x: r.x, y: r.y, width: r.width, height: r.height, font: css.fontFamily, size: css.fontSize, lineHeight: css.lineHeight};
    }));
    await page.screenshot({path: path.join(output, `${name}.png`), fullPage: true, animations: "allow"});
    inventory.push({name, reference, viewport: page.viewportSize(), geometry});
  }
  await page.goto("/");
  await expect(page.getByText("Пока нет документов", {exact: true})).toBeVisible();
  await capture("01-library-empty", "Библиотека_/ Нет документов.png");
  await page.getByRole("button", {name: "Новый документ", exact: true}).click();
  await capture("02-document-new", "Документ_/ Создание.png; system keyboard excluded from desktop simulation");
  await page.reload();
  await expect(page.getByRole("button", {name: "Новый документ", exact: true})).toBeVisible();
  await page.evaluate(async () => {
    let n = 0;
    async function photo(file: string, caption: string) {
      const image = await createImageBitmap(await (await fetch(`/assets/${file}.png`)).blob());
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext("2d")!.drawImage(image, 0, 0); image.close();
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), "image/jpeg", .92));
      return {id: `audit-photo-${++n}`, blob, caption, width: canvas.width, height: canvas.height};
    }
    const scratch = await photo("80c0e49b-45c1-40bf-9806-38b380c21789", "Общий вид");
    const side = await photo("80c0e49b-45c1-40bf-9806-38b380c21789", "Вид сбоку");
    const crack = await photo("03b59293-45cd-4272-8ece-6370bd5434ba", "");
    const living = {
      id: "audit-living", type: "Комната", name: "Гостиная", description: "Светлые стены, ламинат, диван у окна.",
      checkedItemIds: ["room-walls", "room-floor", "room-ceiling", "room-window", "room-furniture", "room-outlets"],
      photos: [await photo("cb11cb60-00df-4524-b4ae-772ee3729843", "Общий вид"), await photo("3a8311ec-25cf-4e1b-a400-e6bc444200c8", "Окно")],
      defects: [
        {id: "audit-scratch", title: "Царапина на полу", description: "Не слишком глубокая но заметная", photos: [scratch, side]},
        {id: "audit-crack", title: "Трещина на стене", description: "Справа от двери", photos: [crack]},
      ],
    };
    // Each source photo is local and all fixture data is synthetic.
    const room = (id: string, name: string, type: string) => ({id, name, type, description: "", checkedItemIds: [], photos: [], defects: []});
    const inspection = {id: "audit-document", title: "Квартира на Бажова", address: "ул. Бажова, 88", inspectionDate: "2026-11-14", description: "Двух комнатная в хорошем состоянии.", rooms: [living, room("audit-kitchen", "Кухня", "Кухня"), room("audit-bath", "Санузел", "Санузел"), room("audit-bedroom", "Спальня", "Комната")], createdAt: 4, updatedAt: 4, revision: 1};
    const db = await new Promise<IDBDatabase>((resolve, reject) => {const r = indexedDB.open("apartment-inspection-v1"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);});
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("documents", "readwrite"), store = tx.objectStore("documents");
      store.put(inspection);
      for (let i = 1; i <= 3; i++) {
        const copy = structuredClone(inspection); copy.id = `audit-library-${i}`; copy.createdAt = i; store.put(copy);
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    }); db.close();
  });
  await page.reload();
  await expect(page.locator(".list-row")).toHaveCount(4);
  await capture("03-library-filled", "Библиотека_/ Базовая.png; counts reflect fixture content");
  await page.locator(".list-row").first().click();
  await capture("04-document-filled", "Документ_/ Базовый.png; general section retained as in empty variant");
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await capture("05-document-actions", "Menu.png; F13 copy additional");
  await page.keyboard.press("Escape");
  await page.locator(".list-row").filter({hasText: "Гостиная"}).click();
  await capture("06-room-filled", "Комнта_/ Базовый.png");
  await page.getByRole("button", {name: /Проверено/}).click();
  await capture("07-room-checklist", "Комнта_/ Пункты открыты.png; canonical spec hints");
  await page.getByRole("button", {name: "Что проверить и как снять", exact: true}).click();
  await capture("08-help", "Экран инструкция_/  Базовый.png");
  await page.getByRole("combobox").selectOption("Кухня");
  await expect(page.getByRole("combobox")).toHaveValue("Кухня");
  await capture("09-help-kitchen", "Раздел справки.png; native popup uses operating system UI");
  await page.getByRole("button", {name: "К осмотру Гостиная", exact: true}).click();
  await page.locator(".list-row").filter({hasText: "Царапина на полу"}).click();
  await capture("10-defect-filled", "Дефект_/ Базовый.png; PDF_/ Готовый.png duplicate");
  await page.getByRole("button", {name: "Открыть фото Общий вид", exact: true}).click();
  await capture("11-photo-detail", "No exported standalone screen; preview/caption controls");
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name: "К комнате", exact: true}).click();
  await page.getByRole("button", {name: "Добавить", exact: true}).click();
  await capture("12-defect-new", "Дефект_/ Пустой.png; system keyboard excluded");
  await page.getByLabel("Название дефекта", {exact: true}).fill("Временный дефект аудита");
  await page.getByRole("button", {name: "Сохранить", exact: true}).click();
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  await page.locator(".list-row").filter({hasText: "Кухня"}).click();
  await capture("13-room-empty", "Комнта_/ Пустая.png; selected room and OS keyboard differ");
  await page.getByRole("button", {name: /Проверено/}).click();
  await capture("14-kitchen-checklist", "Кухня — пункты осмотра.png");
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  for (const width of [320, 1366]) {
    await page.setViewportSize({width, height: width === 320 ? 568 : 768});
    await capture(`15-document-${width}`, "Desktop adaptation or narrow accessibility extension");
  }
  await page.setViewportSize({width: 430, height: 887});
  await page.getByRole("button", {name: "Сформировать PDF", exact: true}).click();
  await expect(page.getByRole("link", {name: "Скачать PDF", exact: true})).toBeVisible({timeout: 30000});
  await capture("16-pdf-ready", "Кадр 7@2x.png; viewer/download/share controls additional");
  await expect(page.getByRole("heading", {name: "Документ готов", exact: true})).toBeVisible();
  expect((await documents(page)).length).toBe(4);
  expect(errors).toEqual([]); expect(external).toEqual([]);
  await writeFile(path.join(output, "inventory.json"), JSON.stringify({inventory, errors, external}, null, 2), "utf8");
});

test("Figma empty document: general checklist collapsed and expanded without rooms", async ({page}) => {
  const output = path.resolve(process.env.QA_SCREEN_AUDIT_DIR || "docs/evidence/full-audit-2026-11-24/screens");
  await mkdir(output, {recursive: true});
  await createDocument(page, "ул. Бажова, 88");
  await page.getByLabel("Название документа", {exact: true}).fill("Квартира на Бажова");
  await page.getByRole("button", {name: "В библиотеку", exact: true}).click();
  await page.locator(".list-row").first().click();
  await expect(page.getByRole("heading", {name: "Нет добавленных комнат", exact: true})).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.screenshot({path: path.join(output, "17-document-empty.png"), fullPage: true, animations: "allow"});
  await page.getByRole("button", {name: /Проверено/}).click();
  for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.check();
  await expect.poll(async () => (await onlyDoc(page) as any).generalCheckedItemIds.length).toBe(6);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path: path.join(output, "18-document-general-open.png"), fullPage: true, animations: "allow"});
  expect((await onlyDoc(page)).rooms).toHaveLength(0);
});
