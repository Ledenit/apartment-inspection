import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const width of [320, 430, 1366]) {
  test(`demo access ${width}: prefilled form, keyboard, invalid code, retry and cookie reload`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 887 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Вход в демонстрацию", exact: true })).toBeVisible();
    const phone = page.getByLabel("Номер телефона", { exact: true });
    const code = page.getByLabel("Код подтверждения", { exact: true });
    const submit = page.getByRole("button", { name: "Войти", exact: true });
    await expect(phone).toHaveValue("70000000000"); await expect(code).toHaveValue("0000");
    await phone.focus(); await page.keyboard.press("Tab"); await expect(code).toBeFocused();
    await page.keyboard.press("Tab"); await expect(submit).toBeFocused();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await mkdir("docs/evidence/server-photos-2026-11-24", { recursive: true });
    await page.screenshot({ path: `docs/evidence/server-photos-2026-11-24/login-${width}.png`, fullPage: true });
    await code.fill("9999"); await submit.click();
    await expect(page.getByRole("alert")).toContainText("Не получилось войти");
    if (width === 320) await page.screenshot({ path: "docs/evidence/server-photos-2026-11-24/login-error-320.png", fullPage: true });
    await code.fill("0000"); await code.press("Enter");
    await expect(page.getByRole("heading", { name: "Библиотека", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Библиотека", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Вход в демонстрацию", exact: true })).toHaveCount(0);
  });
}
