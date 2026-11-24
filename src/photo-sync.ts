import { Repository } from "./repository";

export type PhotoSyncStatus = "syncing" | "ready" | "error";
export const apiHeaders = { "X-Inspection-Request": "1" };
export async function apiFetch(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin", signal: options.signal ?? AbortSignal.timeout(15000),
    headers: { ...apiHeaders, ...options.headers } });
  if (!response.ok) throw new Error("Не удалось связаться с сервером фотографий.");
  return response;
}

/** Durable IDB outbox: never uploads an uncommitted draft or prunes another tab's photos. */
export function synchronizePhotos(repo: Repository, report: (status: PhotoSyncStatus) => void) {
  let stopped = false, running = false, again = false, initialized = false;
  const run = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    report("syncing");
    try {
      if (!initialized) {
        const data = await (await apiFetch("/api/photos", { cache: "no-store" })).json();
        if (!Array.isArray(data.photoIds) || !data.photoIds.every((id: unknown) => typeof id === "string")) throw new Error("Invalid photo list");
        await repo.queueMissingPhotos(new Set(data.photoIds));
        initialized = true;
      }
      do {
        again = false;
        const jobs = await repo.photoJobs();
        if (!jobs.length) break;
        for (const job of jobs) {
          if (stopped) return;
          if (job.action === "put" && job.photo) {
            await apiFetch(`/api/photos/${encodeURIComponent(job.id)}`, { method: "PUT", headers: { "Content-Type": "image/jpeg", "X-Photo-Version": String(job.version) }, body: job.photo.blob });
          } else if (job.action === "delete" && !job.photo) {
            await apiFetch(`/api/photos/${encodeURIComponent(job.id)}`, { method: "DELETE", headers: { "X-Photo-Version": String(job.version) } });
          }
          await repo.acknowledgePhoto(job.id, job.generation);
        }
        again = true;
      } while (again && !stopped);
      if (!stopped) report("ready");
    } catch {
      again = false;
      if (!stopped) report("error");
    } finally {
      running = false;
      if (again && !stopped) { again = false; void run(); }
    }
  };
  const unsubscribe = repo.subscribe(() => { void run(); });
  const online = () => { initialized = false; void run(); };
  window.addEventListener("online", online);
  void run();
  return { retry: online, stop() { stopped = true; unsubscribe(); window.removeEventListener("online", online); } };
}
