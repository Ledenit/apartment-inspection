// Raw fixture intentionally exercises the actual displayed demo login, not the suite's login helper.
import { test, expect, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { addRoom, createDocument, documents, onlyDoc, syntheticPhoto, upload } from "./helpers";
import { decodeRenderedSiteQR } from "./pdf-site-render";

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("Номер телефона", { exact: true })).toHaveValue("70000000000");
  await expect(page.getByLabel("Код подтверждения", { exact: true })).toHaveValue("0000");
  await expect(page.getByText("Номер и код уже заполнены. SMS не отправляется.")).toBeVisible();
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: /новый документ/i })).toBeVisible();
  const cookie = (await page.context().cookies()).find(value => value.name === "inspection_session")!;
  expect(cookie.value).toMatch(/^[a-f0-9]{64}$/); expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe("Strict"); expect(cookie.path).toBe("/api");
  expect(await page.evaluate(() => document.cookie)).not.toContain("inspection_session");
}
async function remoteIds(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/photos"); expect(response.status()).toBe(200); return (await response.json()).photoIds;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("demo login, failed upload durable retry, real server bytes, copy/delete independence and owner isolation", async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  const external: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url()); });
  await login(page);
  let fail = true;
  await page.route("**/api/photos/*", route => route.request().method() === "PUT" && fail ? route.abort("connectionfailed") : route.continue());
  await createDocument(page, "QA server synthetic address"); await addRoom(page);
  await upload(page, [await syntheticPhoto(page, 2400, 1800)]);
  await expect.poll(async () => (await onlyDoc(page)).rooms[0].photos.length).toBe(1);
  await expect(page.getByRole("button", { name: "Повторить загрузку фото", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.screenshot({ path: "docs/evidence/server-photos-2026-11-24/photo-sync-error-320.png", fullPage: true });
  await page.setViewportSize({ width: 430, height: 887 });
  const stored = await onlyDoc(page, true, true), original = stored.rooms[0].photos[0];
  expect(original.width).toBeLessThanOrEqual(1600); expect(original.height).toBeLessThanOrEqual(1600);
  expect(await remoteIds(page)).toEqual([]);
  fail = false;
  await page.getByRole("button", { name: "Повторить загрузку фото", exact: true }).click();
  await expect.poll(() => remoteIds(page)).toEqual([original.id]);
  const actual = await page.request.get(`/api/photos/${original.id}`); expect(actual.status()).toBe(200);
  const compressed = Buffer.from(original.blob.bytes); expect(await actual.body()).toEqual(compressed); expect(hash(await actual.body())).toBe(original.blob.sha256);
  await page.getByRole("button", { name: "К документу", exact: true }).click();
  await page.getByRole("button", { name: "Действия", exact: true }).click();
  await page.getByRole("button", { name: "Дублировать документ", exact: true }).click();
  await expect.poll(async () => (await documents(page)).length).toBe(2);
  const copy = (await documents(page, true)).find(doc => doc.id !== stored.id)!, copyPhoto = copy.rooms[0].photos[0];
  expect(copyPhoto.id).not.toBe(original.id);
  await expect.poll(async () => (await remoteIds(page)).sort()).toEqual([original.id, copyPhoto.id].sort());
  expect(await (await page.request.get(`/api/photos/${copyPhoto.id}`)).body()).toEqual(compressed);
  const otherContext = await browser.newContext({ baseURL: info.project.use.baseURL });
  try {
    const other = await otherContext.newPage();
    expect((await other.request.get(`/api/photos/${original.id}`)).status()).toBe(401);
    await login(other); expect(await remoteIds(other)).toEqual([]);
    expect((await other.request.get(`/api/photos/${original.id}`)).status()).toBe(404);
    expect(await documents(other)).toEqual([]);
  } finally { await otherContext.close(); }
  await page.getByRole("button", { name: "Действия", exact: true }).click();
  await page.getByRole("button", { name: "Удалить документ", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить", exact: true }).click();
  await expect.poll(() => remoteIds(page)).toEqual([original.id]);
  expect((await page.request.get(`/api/photos/${copyPhoto.id}`)).status()).toBe(404);
  expect(await (await page.request.get(`/api/photos/${original.id}`)).body()).toEqual(compressed);
  expect(await documents(page, true, true)).toEqual([stored]);
  await page.reload(); await expect(page.getByRole("button", { name: /новый документ/i })).toBeVisible();
  await expect(page.getByLabel("Номер телефона", { exact: true })).toHaveCount(0);
  expect(external).toEqual([]); expect(errors).toEqual([]);
  await info.attach("photo-server-verification", { contentType: "application/json", body: JSON.stringify({ original: original.id, deletedCopy: copyPhoto.id, sha256: hash(compressed), bytes: compressed.length, isolation: true, external, errors }) });
});

test("runtime address file changes the actual PDF link and rendered QR without rebuild", async ({ page }, info) => {
  test.setTimeout(150_000);
  await login(page);
  let address = "https://inspection.example/first?source=paper";
  let reads = 0;
  await page.route("**/site-config.json", async route => {
    expect(new URL(route.request().url()).pathname).toBe("/site-config.json"); reads++;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ publicSiteUrl: address }) });
  });
  await createDocument(page, "QA runtime QR address");
  await addRoom(page);
  await page.getByRole("button", { name: "К документу", exact: true }).click();
  const before = await onlyDoc(page);
  for (const [index, value] of ["https://inspection.example/first?source=paper", "https://inspection.example/changed-after-deploy#return"].entries()) {
    address = value;
    await page.getByRole("button", { name: "Сформировать PDF", exact: true }).click();
    await expect(page.getByRole("link", { name: "Скачать PDF", exact: true })).toBeVisible({ timeout: 30_000 });
    const downloaded = page.waitForEvent("download"); await page.getByRole("link", { name: "Скачать PDF", exact: true }).click();
    await mkdir("docs/evidence/qa", { recursive: true }); const filename = `docs/evidence/qa/runtime-site-${index}.pdf`; await (await downloaded).saveAs(filename);
    const module = "pdfjs-dist/legacy/build/pdf.mjs", pdfjs = await import(module), pdf = await pdfjs.getDocument({ data: new Uint8Array(await readFile(filename)) }).promise;
    const links: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) for (const annotation of await (await pdf.getPage(n)).getAnnotations()) if (annotation.subtype === "Link") links.push(annotation.url);
    expect(links.length).toBeGreaterThan(0); expect(new Set(links)).toEqual(new Set([value]));
    const decoded = await decodeRenderedSiteQR(page, info, filename, `runtime-${index}`, pdf.numPages);
    expect(decoded).toHaveLength(1); expect(decoded[0].data).toBe(value); await pdf.destroy();
    expect(await onlyDoc(page)).toEqual(before);
    await page.getByRole("button", { name: "К документу", exact: true }).click();
  }
  expect(reads).toBe(2);
});
