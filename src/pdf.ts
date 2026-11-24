import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFString,
  rgb,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { pdfPhotoBudget, preparePdfPhoto } from "./pdf-photos";
import { pdfSite, PDF_SITE_TITLE, QR_QUIET_MODULES } from "./pdf-site";
import {
  Inspection,
  Photo,
  displayDate,
  roomCount,
  defectCount,
  totalDefects,
} from "./model";
const FOOTNOTE =
  "Документ составлен пользователем и не заменяет договор и акт приёма-передачи";
export type PdfStage = 0 | 1 | 2 | 3 | 4 | 5;
export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  width: number,
) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      for (const char of word) {
        if (line && font.widthOfTextAtSize(line + char, size) > width) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}
export function pdfFilename(d: Inspection) {
  const suffix = ` — ${displayDate(d.inspectionDate, true)}.pdf`;
  const prefix = `Осмотр — ${d.address}`
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .slice(0, 180 - suffix.length)
    .replace(/[\uD800-\uDBFF]$/, "_");
  return prefix + suffix;
}
export async function buildPdf(
  documentSnapshot: Inspection,
  fontBytes?: { regular: Uint8Array; heading: Uint8Array },
  publicSiteUrl: string | undefined = import.meta.env.VITE_PUBLIC_SITE_URL,
  onProgress?: (stage: PdfStage) => void,
): Promise<Blob> {
  let stage: PdfStage = 0;
  const advance = (next: PdfStage) => {
    if (next > stage) {stage = next; onProgress?.(next);}
  };
  const site = pdfSite(publicSiteUrl);
  const d = structuredClone(documentSnapshot);
  const pdf = await PDFDocument.create();
  advance(1);
  pdf.registerFontkit(fontkit);
  const load = async (path: string) => {
    const res = await fetch(path);
    if (!res.ok) throw new Error("Не удалось загрузить шрифт PDF.");
    return new Uint8Array(await res.arrayBuffer());
  };
  const regular = await pdf.embedFont(
    fontBytes?.regular ?? (await load("/fonts/Montserrat-Regular.ttf")),
    { subset: true },
  );
  const heading = await pdf.embedFont(
    fontBytes?.heading ?? (await load("/fonts/Oswald-Bold.ttf")),
    { subset: true },
  );
  const W = 595.28,
    H = 841.89,
    M = 42,
    CW = W - 2 * M;
  let page = pdf.addPage([W, H]),
    y = H - M;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const ensure = (height: number) => {
    if (y - height < 64) newPage();
  };
  const text = (value: string, size = 10, font = regular, after = 9) => {
    const lines = wrapText(value, font, size, CW);
    for (const line of lines) {
      ensure(size * 1.5);
      page.drawText(line, {
        x: M,
        y: y - size,
        size,
        font,
        color: rgb(0, 0, 0),
      });
      y -= size * 1.5;
    }
    y -= after;
  };
  const usable = H - M - 64;
  const titleHeight = (value: string, size: number) =>
    wrapText(value, heading, size, CW).length * size * 1.5 + 9;
  const title = (value: string, size = 19, following = 15) => {
    const lines = wrapText(value, heading, size, CW);
    lines.forEach((line, index) => {
      ensure(
        Math.min((lines.length - index) * size * 1.5 + 9 + following, usable),
      );
      page.drawText(line, { x: M, y: y - size, size, font: heading });
      y -= size * 1.5;
    });
    y -= 9;
  };
  const images = new Map<Photo, PDFImage>();
  const photoCount = d.rooms.reduce(
    (count, room) =>
      count +
      room.photos.length +
      room.defects.reduce((n, defect) => n + defect.photos.length, 0),
    0,
  );
  const byteBudget = pdfPhotoBudget(photoCount);
  const imageFor = async (p: Photo) => {
    let img = images.get(p);
    if (!img) {
      const exportBlob = await preparePdfPhoto(p.blob, byteBudget);
      img = await pdf.embedJpg(await exportBlob.arrayBuffer());
      images.set(p, img);
    }
    return img;
  };
  const photoLayout = async (p: Photo) => {
    const img = await imageFor(p);
    const lines = p.caption ? wrapText(p.caption, regular, 9, CW) : [];
    const scale = Math.min(CW / img.width, 240 / img.height, 1);
    const height = img.height * scale;
    const full = height + 6 + lines.length * 13.5 + 10;
    return {
      img,
      lines,
      width: img.width * scale,
      height,
      first: full <= usable ? full : height + 6 + 13.5 + 10,
      oversized: full > usable,
    };
  };
  const photo = async (p: Photo) => {
    const { img, lines, width, height, first, oversized } =
      await photoLayout(p);
    ensure(first);
    page.drawImage(img, { x: M, y: y - height, width, height });
    y -= height + 6;
    for (const line of lines) {
      if (oversized && y - 13.5 < 64) {
        newPage();
        const scale = Math.min(120 / img.width, 64 / img.height, 1);
        const thumbnailHeight = img.height * scale;
        page.drawImage(img, {
          x: M,
          y: y - thumbnailHeight,
          width: img.width * scale,
          height: thumbnailHeight,
        });
        y -= thumbnailHeight + 6;
        text("Продолжение подписи", 9, regular, 6);
      }
      page.drawText(line, { x: M, y: y - 9, size: 9, font: regular });
      y -= 13.5;
    }
    y -= 10;
  };
  const firstContent = async (description: string, photos: Photo[]) =>
    description.trim()
      ? 15
      : photos.length
        ? (await photoLayout(photos[0])).first
        : 15;
  title("Осмотр квартиры", 26);
  advance(2);
  if (d.title.trim()) text(d.title, 14, heading);
  text(d.address, 12);
  if (d.description.trim()) text(d.description);
  text(`${roomCount(d.rooms.length)} · ${defectCount(totalDefects(d))}`);
  for (const r of d.rooms) {
    y -= 8;
    const firstDefect = r.defects[0];
    const roomFollowing =
      r.description.trim() || r.photos.length || !firstDefect
        ? await firstContent(r.description, r.photos)
        : titleHeight("Дефекты", 15) +
          titleHeight(firstDefect.title, 14) +
          (await firstContent(firstDefect.description, firstDefect.photos));
    title(r.name, 19, roomFollowing);
    if (r.description.trim()) text(r.description);
    for (const p of r.photos) {await photo(p); advance(3);}
    if (!r.defects.length) text("Дефектов не отмечено");
    else {
      title(
        "Дефекты",
        15,
        titleHeight(firstDefect.title, 14) +
          (await firstContent(firstDefect.description, firstDefect.photos)),
      );
      for (const f of r.defects) {
        title(f.title, 14, await firstContent(f.description, f.photos));
        advance(4);
        if (f.description.trim()) text(f.description);
        for (const p of f.photos) await photo(p);
      }
    }
  }
  advance(5);
  const footLines = wrapText(FOOTNOTE, regular, 8, CW);
  if (site) {
    const lines = wrapText(site.uri, regular, 9, CW);
    const siteHeight = 21 + lines.length * 13.5 + 10 + site.size + 16;
    const footerHeight = siteHeight + footLines.length * 12 + 22;
    if (footerHeight > usable)
      throw new Error(
        "Проверьте VITE_PUBLIC_SITE_URL: адрес слишком длинный для блока PDF.",
      );
    // Keep the site, legal note and final date on the same final page.
    ensure(footerHeight);
    text(PDF_SITE_TITLE, 12, heading, 3);
    for (const line of lines) {
      const baseline = y - 9;
      page.drawText(line, { x: M, y: baseline, size: 9, font: regular });
      page.node.addAnnot(
        pdf.context.register(
          pdf.context.obj({
            Type: "Annot",
            Subtype: "Link",
            Rect: [
              M,
              baseline - 2,
              M + regular.widthOfTextAtSize(line, 9),
              baseline + 10,
            ],
            Border: [0, 0, 0],
            A: { Type: "Action", S: "URI", URI: PDFString.of(site.uri) },
          }),
        ),
      );
      y -= 13.5;
    }
    y -= 10;
    page.drawRectangle({
      x: M,
      y: y - site.size,
      width: site.size,
      height: site.size,
      color: rgb(1, 1, 1),
    });
    for (let row = 0; row < site.modules; row++) {
      for (let column = 0; column < site.modules;) {
        if (!site.isDark(row, column)) {
          column++;
          continue;
        }
        const start = column;
        while (column < site.modules && site.isDark(row, column)) column++;
        page.drawRectangle({
          x: M + (QR_QUIET_MODULES + start) * site.moduleSize,
          y: y - (QR_QUIET_MODULES + row + 1) * site.moduleSize,
          width: (column - start) * site.moduleSize,
          height: site.moduleSize,
          color: rgb(0, 0, 0),
        });
      }
    }
    y -= site.size + 16;
  }
  ensure(footLines.length * 12 + 22);
  text(FOOTNOTE, 8, regular, 0);
  page.drawText(`Дата осмотра: ${displayDate(d.inspectionDate, true)}`, {
    x: M,
    y: 30,
    size: 10,
    font: regular,
  });
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  if (info && "delete" in info) {
    (info as { delete: (key: PDFName) => void }).delete(
      PDFName.of("CreationDate"),
    );
    (info as { delete: (key: PDFName) => void }).delete(PDFName.of("ModDate"));
  }
  const bytes = await pdf.save();
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}
