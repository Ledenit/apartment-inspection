import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import jsQR from "jsqr";
import { buildPdf } from "../../src/pdf";
import { pdfSite, PDF_SITE_TITLE, QR_QUIET_MODULES } from "../../src/pdf-site";
import { Inspection } from "../../src/model";

it("omits a site block for an absent or blank setting", () => {
  for (const value of [undefined, "", "  "]) expect(pdfSite(value)).toBeNull();
});
it.each([
  "/relative",
  "javascript:alert(1)",
  "data:text/plain,x",
  "https:example.test",
  "https://user:password@example.test",
  "https://user@example.test",
  "https://",
  "https://example.test/\npath",
])("rejects an invalid public site setting: %s", (value) => {
  expect(() => pdfSite(value)).toThrow("VITE_PUBLIC_SITE_URL");
});
it("decodes the generated QR with an independent decoder to the canonical URI", () => {
  const raw = " HTTPS://ПРИМЕР.РФ:443/путь?x=два#раздел ";
  const site = pdfSite(raw)!;
  expect(site.uri).toBe(new URL(raw).href);
  const scale = 4;
  const width = (site.modules + QR_QUIET_MODULES * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < site.modules; row++) {
    for (let col = 0; col < site.modules; col++) {
      if (!site.isDark(row, col)) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const p =
            (((row + QR_QUIET_MODULES) * scale + dy) * width +
              (col + QR_QUIET_MODULES) * scale +
              dx) *
            4;
          pixels[p] = pixels[p + 1] = pixels[p + 2] = 0;
        }
    }
  }
  expect(jsQR(pixels, width, width)?.data).toBe(site.uri);
  expect(site.moduleSize).toBeGreaterThanOrEqual(1.5);
  expect(site.size).toBeGreaterThanOrEqual(96);
});
it("reports unsupported QR payloads as a configuration error", () => {
  expect(() => pdfSite("https://example.test/" + "a".repeat(3000))).toThrow(
    "VITE_PUBLIC_SITE_URL",
  );
});

async function pdfFixture(url: string, lines = 40) {
  const d: Inspection = {
    id: "site",
    title: "",
    address: "Synthetic address",
    inspectionDate: "2026-02-03",
    description: Array(lines).fill("CONTENT").join("\n"),
    rooms: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const before = structuredClone(d);
  const blob = await buildPdf(
    d,
    {
      regular: new Uint8Array(
        await readFile("public/fonts/Montserrat-Regular.ttf"),
      ),
      heading: new Uint8Array(await readFile("public/fonts/Oswald-Bold.ttf")),
    },
    url,
  );
  expect(d).toEqual(before);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    useSystemFonts: false,
  }).promise;
}
it("keeps the wrapped clickable URL, QR, legal note and one date on the final page", async () => {
  const uri = new URL(
    "https://example.test/" + "segment-".repeat(65) + "?x=1#end",
  ).href;
  const parsed = await pdfFixture(uri);
  try {
    expect(parsed.numPages).toBeGreaterThan(1);
    const allText: string[] = [];
    for (let n = 1; n <= parsed.numPages; n++) {
      const page = await parsed.getPage(n);
      expect(page.view).toEqual([0, 0, 595.28, 841.89]);
      const items = (await page.getTextContent()).items.filter(
        (v): v is typeof v & { str: string; transform: number[] } =>
          "str" in v && v.str.length > 0,
      );
      const annotations = await page.getAnnotations();
      const strings = items.map((v) => v.str);
      allText.push(...strings);
      if (n !== parsed.numPages) {
        expect(strings).not.toContain(PDF_SITE_TITLE);
        expect(annotations).toHaveLength(0);
        continue;
      }
      const firstLine = strings.indexOf(PDF_SITE_TITLE) + 1;
      expect(firstLine).toBeGreaterThan(0);
      const urlLines = items.slice(firstLine, firstLine + annotations.length);
      expect(annotations.length).toBeGreaterThan(1);
      expect(urlLines.map((v) => v.str).join("")).toBe(uri);
      for (const [index, annotation] of annotations.entries()) {
        expect(annotation.url).toBe(uri);
        expect(annotation.rect[0]).toBeGreaterThanOrEqual(42);
        expect(annotation.rect[2]).toBeLessThanOrEqual(553.28);
        expect(annotation.rect[1]).toBeLessThanOrEqual(
          urlLines[index].transform[5],
        );
        expect(annotation.rect[3]).toBeGreaterThan(
          urlLines[index].transform[5],
        );
      }
      expect(strings.join(" ")).toContain("Документ составлен пользователем");
      expect(items.at(-1)?.str).toBe("Дата осмотра: 03.02.2026");
      expect(items.at(-1)?.transform[5]).toBe(30);
    }
    expect(allText.filter((v) => v === PDF_SITE_TITLE)).toHaveLength(1);
    expect(allText.filter((v) => v.startsWith("Дата осмотра:"))).toHaveLength(
      1,
    );
  } finally {
    await parsed.destroy();
  }
}, 30000);
it("leaves default PDFs without placeholder text or links", async () => {
  const parsed = await pdfFixture("", 0);
  try {
    expect(parsed.numPages).toBe(1);
    const page = await parsed.getPage(1);
    expect(await page.getAnnotations()).toHaveLength(0);
    const text = (await page.getTextContent()).items
      .filter((v) => "str" in v)
      .map((v) => v.str)
      .join(" ");
    expect(text).not.toContain(PDF_SITE_TITLE);
    expect(text).not.toMatch(/localhost|example|https?:\/\//);
  } finally {
    await parsed.destroy();
  }
}, 30000);
it("rejects invalid configuration before attempting font fetch or PDF creation", async () => {
  await expect(
    buildPdf({} as Inspection, undefined, "file:///private"),
  ).rejects.toThrow("VITE_PUBLIC_SITE_URL");
});
it("rejects a QR-capable URL that cannot fit the complete printable footer", async () => {
  const uri = "https://example.test/" + "m".repeat(2200);
  expect(pdfSite(uri)).not.toBeNull();
  await expect(pdfFixture(uri, 0)).rejects.toThrow(
    "адрес слишком длинный для блока PDF",
  );
}, 30000);
