import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildPdf, pdfFilename } from "../../src/pdf";
import { Inspection, newRoom } from "../../src/model";
const fonts = async () => ({
  regular: new Uint8Array(
    await readFile("public/fonts/Montserrat-Regular.ttf"),
  ),
  heading: new Uint8Array(await readFile("public/fonts/Oswald-Bold.ttf")),
});
async function fixture(caption = "") {
  const room = newRoom("Комната", "ORPHANROOM", []);
  room.photos.push({
    id: "photo",
    blob: new Blob(
      [new Uint8Array(await readFile("tests/unit/fixtures/photo.jpg"))],
      { type: "image/jpeg" },
    ),
    width: 600,
    height: 400,
    caption,
  });
  return {
    id: "pdf-test",
    title: "",
    address: "Address",
    inspectionDate: "2026-11-20",
    description: Array(30).fill("DESCRIPTION").join("\n"),
    rooms: [room],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Inspection;
}
async function parsedPages(d: Inspection) {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const blob = await buildPdf(d, await fonts());
  const parsed = await getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    useSystemFonts: false,
  }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= parsed.numPages; n++) {
      const page = await parsed.getPage(n);
      const content = await page.getTextContent();
      const ops = await page.getOperatorList();
      pages.push({
        text: content.items
          .filter((v) => "str" in v)
          .map((v) => (v as { str: string }).str)
          .join(" "),
        images: ops.fnArray.filter(
          (v) =>
            v === OPS.paintImageXObject || v === OPS.paintInlineImageXObject,
        ).length,
      });
    }
    return pages;
  } finally {
    await parsed.destroy();
  }
}
describe("PDF contract", () => {
  it("keeps the actual 30-line orphan fixture room heading with its first photo", async () => {
    const pages = await parsedPages(await fixture());
    const roomPage = pages.find((p) => p.text.includes("ORPHANROOM"))!;
    expect(roomPage.images).toBe(1);
    expect(pages[0].text).not.toContain("ORPHANROOM");
  }, 30000);
  it("keeps a wrapped defect heading with its first photo", async () => {
    const d = await fixture();
    const photo = d.rooms[0].photos[0];
    d.rooms[0].photos = [];
    d.rooms[0].defects.push({
      id: "defect",
      title: "DEFECTHEADING ".repeat(12),
      description: "",
      photos: [photo],
    });
    const pages = await parsedPages(d);
    expect(pages.find((p) => p.text.includes("DEFECTHEADING"))!.images).toBe(1);
  }, 30000);
  it("moves an ordinary caption of more than ten lines with its image intact", async () => {
    const words = Array.from({ length: 16 }, (_, i) => `CAP${i}`);
    const pages = await parsedPages(await fixture(words.join("\n")));
    const paired = pages.filter((p) => /CAP\d/.test(p.text));
    expect(paired).toHaveLength(1);
    expect(paired[0].images).toBe(1);
    expect(paired[0].text.match(/CAP\d+/g)).toEqual(words);
  }, 30000);
  it("repeats a thumbnail and continuation label on every oversized-caption page without losing or duplicating words", async () => {
    const words = Array.from({ length: 1800 }, (_, i) => `CAP${i}`);
    const d = await fixture(words.join(" "));
    d.description = "";
    const pages = await parsedPages(d);
    const captionPages = pages.filter((p) => /CAP\d/.test(p.text));
    expect(captionPages.length).toBeGreaterThan(2);
    for (const [index, page] of captionPages.entries()) {
      expect(page.images).toBe(1);
      expect(page.text.includes("Продолжение подписи")).toBe(index > 0);
    }
    expect(captionPages.flatMap((p) => p.text.match(/CAP\d+/g) || [])).toEqual(
      words,
    );
  }, 30000);
  it("embeds Cyrillic, includes empty room and long text, A4 and one final date, no metadata date/checklists", async () => {
    const room = newRoom("Комната", "Пустая комната", []);
    room.checkedItemIds = ["room-walls"];
    const d: Inspection = {
      id: "test",
      title: "Квартира",
      address: "Тестовый адрес",
      inspectionDate: "2026-11-20",
      description: "Длинное описание ".repeat(800),
      rooms: [room],
      generalCheckedItemIds: ["general-keys"],
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    };
    const before = structuredClone(d);
    const blob = await buildPdf(d, {
      regular: new Uint8Array(
        await readFile("public/fonts/Montserrat-Regular.ttf"),
      ),
      heading: new Uint8Array(await readFile("public/fonts/Oswald-Bold.ttf")),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(pdf.getCreationDate()).toBeUndefined();
    expect(pdf.getModificationDate()).toBeUndefined();
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    for (const p of pdf.getPages()) {
      expect(p.getWidth()).toBeCloseTo(595.28);
      expect(p.getHeight()).toBeCloseTo(841.89);
    }
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const parsed = await getDocument({ data: bytes, useSystemFonts: false })
      .promise;
    let text = "";
    let lastItems: { str: string; transform: number[] }[] = [];
    for (let i = 1; i <= parsed.numPages; i++) {
      const page = await parsed.getPage(i);
      const content = await page.getTextContent();
      const items = content.items.filter(
        (v): v is typeof v & { str: string; transform: number[] } => "str" in v,
      );
      text += items.map((v) => v.str).join(" ");
      if (i === parsed.numPages) lastItems = items;
    }
    expect(text).toContain("Осмотр квартиры");
    expect(text).toContain("Пустая комната");
    expect(text).toContain("Дефектов не отмечено");
    expect(text.match(/Дата осмотра/g)).toHaveLength(1);
    expect(text).not.toContain("Стены и обои");
    expect(text).not.toContain("room-walls");
    expect(text).not.toContain("general-keys");
    expect(text).not.toContain("Ключи");
    expect(lastItems.at(-1)?.str).toBe("Дата осмотра: 20.11.2026");
    expect(lastItems.at(-1)?.transform[5]).toBe(30);
    expect(d).toEqual(before);
    await parsed.destroy();
  }, 30000);
  it("sanitizes download filename", () => {
    const d = {
      address: "Адрес:/<>|\u0001",
      inspectionDate: "2026-11-20",
    } as Inspection;
    expect(pdfFilename(d)).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
    expect(pdfFilename(d)).toContain("20.11.2026.pdf");
  });
  it("preserves inspection date and extension when a long address is shortened", () => {
    for (const address of ["Очень длинный адрес ".repeat(40), "😀".repeat(200)]) {
      const name = pdfFilename({address, inspectionDate: "2026-11-20"} as Inspection);
      expect(name.length).toBeLessThanOrEqual(180);
      expect(name).toMatch(/ — 20\.11\.2026\.pdf$/);
      expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
      expect(decodeURIComponent(encodeURIComponent(name))).toBe(name);
    }
  });
});
