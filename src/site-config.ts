/** Read at export time so an operator can change the deployed file without rebuilding. */
export async function loadPublicSiteUrl(): Promise<string> {
  const response = await fetch(`${import.meta.env.BASE_URL}site-config.json`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return import.meta.env.VITE_PUBLIC_SITE_URL ?? "";
  if (!response.ok) throw new Error("Не удалось прочитать настройку адреса сайта.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data) ||
    typeof (data as { publicSiteUrl?: unknown }).publicSiteUrl !== "string") throw new Error("Некорректная настройка адреса сайта.");
  return (data as { publicSiteUrl: string }).publicSiteUrl;
}
