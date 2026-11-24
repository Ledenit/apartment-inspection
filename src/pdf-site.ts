import qrcode from "qrcode-generator";

export const PDF_SITE_TITLE = "Вернуться на сайт";
export const QR_QUIET_MODULES = 4;
const CONFIG_ERROR = "Проверьте VITE_PUBLIC_SITE_URL: ";

/** One canonical public URI is shared by the printed text, link and QR. */
export function pdfSite(raw: string | undefined) {
  if (!raw) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw))
    throw new Error(CONFIG_ERROR + "адрес содержит управляющие символы.");
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    if (!/^https?:\/\//i.test(value)) throw new Error();
    url = new URL(value);
    if (!url.hostname || url.username || url.password) throw new Error();
  } catch {
    throw new Error(
      CONFIG_ERROR + "нужен полный HTTP(S) адрес без логина и пароля.",
    );
  }
  const uri = url.href;
  const qr = qrcode(0, "M");
  try {
    // URL serialization percent-encodes Unicode paths and uses an ASCII host.
    qr.addData(uri, "Byte");
    qr.make();
  } catch {
    throw new Error(CONFIG_ERROR + "адрес слишком длинный для QR-кода.");
  }
  const modules = qr.getModuleCount();
  // At least 0.53 mm per module; short codes occupy at least 34 mm on A4.
  const moduleSize = Math.max(1.5, 96 / (modules + 2 * QR_QUIET_MODULES));
  return {
    uri,
    modules,
    moduleSize,
    size: (modules + 2 * QR_QUIET_MODULES) * moduleSize,
    isDark: (row: number, column: number) => qr.isDark(row, column),
  };
}
