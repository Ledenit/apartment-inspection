import { config } from "./model";

/** Leave room for fonts, text and PDF structures below the 20 MB export target. */
export const PDF_IMAGE_BUDGET = 18_000_000;

export function pdfPhotoBudget(count: number) {
  return Math.floor(PDF_IMAGE_BUDGET / Math.max(1, count));
}

/** Export-only transformation. The source Blob is never modified or replaced. */
export async function preparePdfPhoto(
  sourceBlob: Blob,
  byteBudget: number,
): Promise<Blob> {
  if (sourceBlob.size <= byteBudget) return sourceBlob;
  let source: ImageBitmap | HTMLImageElement;
  let dispose = () => {};
  try {
    source = await createImageBitmap(sourceBlob, {
      imageOrientation: "from-image",
    });
    dispose = () => (source as ImageBitmap).close();
  } catch {
    const url = URL.createObjectURL(sourceBlob);
    const image = new Image();
    try {
      image.src = url;
      await image.decode();
      source = image;
      dispose = () => URL.revokeObjectURL(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }
  let canvas: HTMLCanvasElement | undefined;
  try {
    const width = "naturalWidth" in source ? source.naturalWidth : source.width;
    const height =
      "naturalHeight" in source ? source.naturalHeight : source.height;
    if (!width || !height) throw new Error("Фото пустое.");
    canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Не удалось подготовить фото для PDF.");
    const initialQuality = Math.max(
      0.6,
      Math.min(0.72, (config.jpegQuality * byteBudget) / sourceBlob.size),
    );
    const attempts = [
      [1600, initialQuality],
      ...(initialQuality > 0.6 ? [[1600, 0.6]] : []),
      [1200, 0.6],
    ];
    for (const [maxSide, quality] of attempts) {
      const ratio = Math.min(1, maxSide / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      // Async canvas encoders can defer each image for ~1 s in the preview UI.
      // Encode one bounded raster synchronously; decoding the next photo yields.
      const data = canvas.toDataURL("image/jpeg", quality);
      if (!data.startsWith("data:image/jpeg;base64,"))
        throw new Error("Не удалось сжать фото для PDF.");
      const binary = atob(data.slice(data.indexOf(",") + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/jpeg" });
      if (blob.size <= byteBudget) return blob;
    }
    throw new Error(
      "Не удалось уменьшить размер PDF. Попробуйте экспорт ещё раз.",
    );
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
    dispose();
  }
}
