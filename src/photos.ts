import { config, Photo } from "./model";
export async function preparePhoto(file: File): Promise<Photo> {
  if (!file.type.startsWith("image/"))
    throw new Error("Выберите изображение JPEG, PNG или WebP.");
  let source: ImageBitmap | HTMLImageElement;
  let dispose = () => {};
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
    dispose = () => (source as ImageBitmap).close();
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      img.src = url;
      await img.decode();
      source = img;
      dispose = () => URL.revokeObjectURL(url);
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("Не удалось прочитать фото. Попробуйте JPEG или PNG.");
    }
  }
  try {
    const sw =
        source instanceof HTMLImageElement ? source.naturalWidth : source.width,
      sh =
        source instanceof HTMLImageElement
          ? source.naturalHeight
          : source.height;
    if (!sw || !sh) throw new Error("Фото пустое.");
    const ratio = Math.min(1, config.maxPhotoSide / Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * ratio)),
      height = Math.max(1, Math.round(sh * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Не удалось обработать фото.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Не удалось сжать фото."))),
        "image/jpeg",
        config.jpegQuality,
      ),
    );
    canvas.width = canvas.height = 0;
    return { id: crypto.randomUUID(), blob, width, height, caption: "" };
  } finally {
    dispose();
  }
}
