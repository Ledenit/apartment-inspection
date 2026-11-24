import {test, expect} from "./demo-fixture";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {createDocument, addRoom, onlyDoc, upload, syntheticPhoto} from "./helpers";

test("built app obeys the configured CSP during menu, photo, defect, duplicate and PDF flows", async ({page}) => {
  const config = await readFile("nginx.example.conf", "utf8");
  const csp = config.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
  expect(csp).toBeTruthy();
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => {if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== "127.0.0.1") external.push(r.url());});
  await page.addInitScript(() => {
    (window as any).__cspAudit = [];
    document.addEventListener("securitypolicyviolation", e => (window as any).__cspAudit.push({directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile}));
  });
  await page.route("**/*", async route => {
    if (route.request().resourceType() === "document") {
      const response = await route.fetch();
      await route.fulfill({response, headers: {...response.headers(), "content-security-policy": csp!, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"}});
    } else await route.continue();
  });
  await createDocument(page); await addRoom(page);
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await expect(page.getByRole("dialog", {name: "Действия", exact: true})).toBeVisible();
  await page.keyboard.press("Escape");
  await upload(page, [await syntheticPhoto(page, 320, 240)]);
  await page.getByRole("button", {name: "Добавить дефект", exact: true}).click();
  await page.getByLabel("Название дефекта", {exact: true}).fill("Синтетический дефект CSP");
  await page.getByRole("button", {name: "Сохранить", exact: true}).click();
  await expect.poll(async () => (await onlyDoc(page)).rooms[0].defects.length).toBe(1);
  await page.getByRole("button", {name: "К документу", exact: true}).click();
  await page.getByRole("button", {name: "Действия", exact: true}).click();
  await page.getByRole("button", {name: "Дублировать документ", exact: true}).click();
  await expect(page.getByRole("heading", {level: 1})).toContainText("(копия)");
  await page.getByRole("button", {name: "Сформировать PDF", exact: true}).click();
  await expect(page.getByRole("link", {name: "Скачать PDF", exact: true})).toBeVisible({timeout: 30000});
  const violations = await page.evaluate(() => (window as any).__cspAudit);
  expect(violations).toEqual([]); expect(errors).toEqual([]); expect(external).toEqual([]);
  await mkdir("docs/evidence/full-audit-2026-11-24", {recursive: true});
  await writeFile("docs/evidence/full-audit-2026-11-24/csp.json", JSON.stringify({csp, violations, errors, external, nativeIOS: "unverified", headers: "Test server response injection using exact nginx directive; deployed nginx not exercised"}, null, 2), "utf8");
});
