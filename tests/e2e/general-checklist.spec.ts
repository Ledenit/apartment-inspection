// Independent QA requirements supplied by the QA agent; primary agent operates the runner.
import { test, expect, type Page } from "./demo-fixture";
import { createDocument, addRoom, documents, onlyDoc, openDescription, finishDialog } from "./helpers";

async function openLegacy(page: Page) {
  await createDocument(page, "QA общие пункты, 24");
  await page.getByRole("button", {name: "В библиотеку", exact: true}).click();
  await page.getByText("QA общие пункты, 24", {exact: true}).click();
  await expect(page.getByRole("heading", {name: "Общее по квартире", exact: true})).toBeVisible();
}
async function expand(page: Page) {
  const button = page.getByRole("button", {name: /Проверено \d из 6 пунктов/});
  if (await button.getAttribute("aria-expanded") === "false") await button.click();
}
test("general legacy document, help without rooms, autosave, copy and independent room marks", async ({page}, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await openLegacy(page);
  expect((await onlyDoc(page) as any).generalCheckedItemIds).toBeUndefined();
  await expand(page);
  await expect(page.getByRole("checkbox")).toHaveCount(6);
  expect(await page.getByRole("checkbox").evaluateAll(nodes => nodes.every(n => !(n as HTMLInputElement).checked))).toBe(true);
  await page.getByRole("button", {name: "Не знаете, что фиксировать?", exact: true}).click();
  await expect(page.getByRole("combobox")).toHaveValue("Общее");
  await expect(page.getByText("Положите все ключи и брелки в одну руку и снимите так, чтобы было видно число. Число запишите в описании.", {exact: true})).toBeVisible();
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  expect((await onlyDoc(page)).rooms).toHaveLength(0);
  const field = await openDescription(page); await field.fill("Старый формат открывается и сохраняется"); await finishDialog(page);
  await expand(page);
  await page.getByRole("checkbox", {name: "Ключи", exact: true}).check();
  await page.getByRole("checkbox", {name: "Счётчики воды", exact: true}).check();
  await expect.poll(async () => (await onlyDoc(page) as any).generalCheckedItemIds).toEqual(["general-keys", "general-water"]);
  // Hints are reading content rather than checkbox labels.
  await page.locator(".check-hint").first().click();
  await expect(page.getByRole("checkbox", {name: "Ключи", exact: true})).toBeChecked();
  await page.getByText("Ключи", {exact: true}).click();
  await expect(page.getByRole("checkbox", {name: "Ключи", exact: true})).not.toBeChecked();
  await addRoom(page);
  await expand(page);
  await page.getByRole("checkbox", {name: "Стены и обои", exact: true}).check();
  await expect.poll(async () => (await onlyDoc(page)).rooms[0].checkedItemIds).toEqual(["room-walls"]);
  await page.getByRole("button", {name: "Что проверить и как снять", exact: true}).click();
  await expect(page.getByRole("combobox")).toHaveValue("Комната");
  await page.getByRole("button", {name: "К осмотру Комната", exact: true}).click();
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  await page.reload();
  await page.getByText("QA общие пункты, 24", {exact: true}).click();
  expect((await onlyDoc(page)).description).toBe("Старый формат открывается и сохраняется");
  await expand(page);
  await expect(page.getByRole("checkbox", {name: "Счётчики воды", exact: true})).toBeChecked();
  await expect(page.getByRole("checkbox", {name: "Ключи", exact: true})).not.toBeChecked();
  const original = await onlyDoc(page);
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await page.getByRole("button", {name: "Дублировать документ", exact: true}).click();
  await expect(page.getByRole("heading", {level: 1})).toContainText("(копия)");
  await expand(page);
  await page.getByRole("checkbox", {name: "Счётчики воды", exact: true}).uncheck();
  await expect.poll(async () => (await documents(page) as any[]).find(d => d.id !== original.id).generalCheckedItemIds).toEqual([]);
  expect((await documents(page)).find(d => d.id === original.id)).toEqual(original);
  for (const width of [430, 320, 1366]) {
    await page.setViewportSize({width, height: 887});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("checkbox").last().scrollIntoViewIfNeeded();
    await expect(page.getByRole("checkbox").last()).toBeInViewport();
    await page.screenshot({path: info.outputPath(`general-${width}.png`), fullPage: true, animations: "allow"});
  }
  expect(errors).toEqual([]);
});
test("general checklist controls remain reachable at 320px and 200% text", async ({page}) => {
  await page.setViewportSize({width: 320, height: 568});
  await openLegacy(page);
  await page.addStyleTag({content: "html { font-size: 200%; }"});
  await expand(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const locator of [page.getByRole("checkbox").last(), page.getByRole("button", {name: "Что проверить и как снять", exact: true}), page.getByRole("button", {name: "Сформировать PDF", exact: true})]) {
    await locator.scrollIntoViewIfNeeded();
    expect(await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === el || el.contains(hit);
    })).toBe(true);
  }
});
test("PDF text is identical when only general and room checklist marks change", async ({page}) => {
  await openLegacy(page); await addRoom(page);
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  async function pdfText() {
    await page.getByRole("button", {name: "Сформировать PDF", exact: true}).click();
    const link = page.getByRole("link", {name: "Скачать PDF", exact: true});
    await expect(link).toBeVisible({timeout: 30000});
    const bytes = await link.evaluate(async (a: HTMLAnchorElement) => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
    const {getDocument} = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await getDocument({data: new Uint8Array(bytes), useSystemFonts: false}).promise;
    try {
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map(v => "str" in v ? v.str : "").join(" ");
      return text;
    } finally {await pdf.destroy();}
  }
  const before = await pdfText();
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  await expand(page); await page.getByRole("checkbox", {name: "Ключи", exact: true}).check();
  await page.locator(".list-row").filter({hasText: "Комната"}).click();
  await expand(page); await page.getByRole("checkbox", {name: "Стены и обои", exact: true}).check();
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  expect(await pdfText()).toBe(before);
});
