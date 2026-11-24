import { test as base, expect, type BrowserContext } from "@playwright/test";
export * from "@playwright/test";

export async function loginDemo(context: BrowserContext, origin: string) {
  const response = await context.request.post(`${origin}/api/session`, {
    headers: { Origin: origin, "X-Inspection-Request": "1" },
    data: { phone: "70000000000", code: "0000" },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

// Core regression scenarios start after a real API demo-login. A separate spec
// exercises the actual prefilled form and isolated unauthorized browser state.
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    await loginDemo(page.context(), new URL(baseURL!).origin);
    await use(page);
  },
});
