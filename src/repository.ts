import { Inspection, Photo, StorageError, validateDocument } from "./model";

export type PhotoJob = { id: string; generation: string; version: number; action: "put" | "delete"; photo?: Photo };
function photos(document?: Inspection): Photo[] {
  return document?.rooms.flatMap(room => [...room.photos, ...room.defects.flatMap(defect => defect.photos)]) ?? [];
}
export function storageError(e: unknown): StorageError {
  return e instanceof StorageError
    ? e
    : new StorageError(
        e instanceof DOMException && e.name === "QuotaExceededError"
          ? "quota"
          : "unavailable",
      );
}
export class Repository {
  private db?: Promise<IDBDatabase>;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify() { for (const listener of this.listeners) listener(); }
  private queueChanges(tx: IDBTransaction, before?: Inspection, after?: Inspection) {
    const previous = new Set(photos(before).map(photo => photo.id));
    const current = new Set(photos(after).map(photo => photo.id));
    const queue = tx.objectStore("photo-outbox");
    const version = after?.revision ?? (before!.revision + 1);
    for (const id of current) if (!previous.has(id)) queue.put({ id, generation: crypto.randomUUID(), version, action: "put" });
    for (const id of previous) if (!current.has(id)) queue.put({ id, generation: crypto.randomUUID(), version, action: "delete" });
  }
  constructor(private name = "apartment-inspection-v1") {}
  private open() {
    if (this.db) return this.db;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let failed = false;
      try {
        const req = indexedDB.open(this.name, 2);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("documents")) req.result.createObjectStore("documents", { keyPath: "id" });
          if (!req.result.objectStoreNames.contains("photo-outbox")) req.result.createObjectStore("photo-outbox", { keyPath: "id" });
        };
        req.onsuccess = () => {
          if (failed) {
            req.result.close();
            return;
          }
          req.result.onversionchange = () => {
            req.result.close();
            this.db = undefined;
          };
          resolve(req.result);
        };
        req.onerror = () => {
          failed = true;
          reject(storageError(req.error));
        };
        req.onblocked = () => {
          failed = true;
          reject(new StorageError("unavailable"));
        };
      } catch (e) {
        reject(storageError(e));
      }
    });
    this.db = attempt;
    void attempt.catch(() => {
      if (this.db === attempt) this.db = undefined;
    });
    return attempt;
  }
  async listDocuments() {
    const db = await this.open();
    return new Promise<Inspection[]>((resolve, reject) => {
      const req = db.transaction("documents").objectStore("documents").getAll();
      req.onsuccess = () =>
        resolve(
          (req.result as Inspection[]).sort(
            (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
          ),
        );
      req.onerror = () => reject(storageError(req.error));
    });
  }
  async getDocument(id: string) {
    const db = await this.open();
    return new Promise<Inspection>((resolve, reject) => {
      const req = db.transaction("documents").objectStore("documents").get(id);
      req.onsuccess = () =>
        req.result
          ? resolve(req.result)
          : reject(new StorageError("not-found"));
      req.onerror = () => reject(storageError(req.error));
    });
  }
  private async write(
    id: string,
    expected: number | null,
    mutate: (current?: Inspection) => Inspection | undefined,
  ) {
    const db = await this.open();
    return new Promise<Inspection | undefined>((resolve, reject) => {
      let failure: unknown, result: Inspection | undefined;
      const tx = db.transaction(["documents", "photo-outbox"], "readwrite");
      const store = tx.objectStore("documents");
      const read = store.get(id);
      read.onsuccess = () => {
        try {
          const current = read.result as Inspection | undefined;
          if (expected === null ? !!current : !current)
            throw new StorageError(
              expected === null ? "conflict" : "not-found",
            );
          if (current && current.revision !== expected)
            throw new StorageError("conflict");
          result = mutate(current);
          if (result) {
            validateDocument(result);
            store.put(result);
          } else store.delete(id);
          this.queueChanges(tx, current, result);
        } catch (e) {
          failure = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => { this.notify(); resolve(result); };
      tx.onabort = () => reject(storageError(failure || tx.error));
      tx.onerror = () => {
        failure ??= tx.error;
      };
    });
  }
  async createDocument(
    input: Pick<Inspection, "title" | "address" | "inspectionDate">,
  ) {
    const now = Date.now();
    const d: Inspection = {
      ...input,
      id: crypto.randomUUID(),
      description: "",
      rooms: [],
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    return (await this.write(d.id, null, () => d))!;
  }
  async updateDocument(
    id: string,
    expectedRevision: number,
    mutation: (document: Inspection) => void,
  ) {
    return (await this.write(id, expectedRevision, (current) => {
      const next = structuredClone(current!);
      mutation(next);
      next.id = current!.id;
      next.createdAt = current!.createdAt;
      next.revision = current!.revision + 1;
      next.updatedAt = Date.now();
      return next;
    }))!;
  }
  async deleteDocument(id: string, expectedRevision: number) {
    await this.write(id, expectedRevision, () => undefined);
  }
  async duplicateDocument(id: string, expectedRevision: number) {
    const db = await this.open();
    return new Promise<Inspection>((resolve, reject) => {
      const tx = db.transaction(["documents", "photo-outbox"], "readwrite");
      const store = tx.objectStore("documents");
      let result: Inspection, failure: unknown;
      const read = store.get(id);
      read.onsuccess = () => {
        try {
          const source = read.result as Inspection | undefined;
          if (!source) throw new StorageError("not-found");
          if (source.revision !== expectedRevision) throw new StorageError("conflict");
          result = structuredClone(source);
          result.id = crypto.randomUUID();
          result.title = `${source.title.trim() || source.address} (копия)`;
          result.createdAt = result.updatedAt = Date.now();
          result.revision = 1;
          for (const room of result.rooms) {
            room.id = crypto.randomUUID();
            for (const photo of room.photos) photo.id = crypto.randomUUID();
            for (const defect of room.defects) {
              defect.id = crypto.randomUUID();
              for (const photo of defect.photos) photo.id = crypto.randomUUID();
            }
          }
          validateDocument(result);
          store.add(result);
          this.queueChanges(tx, undefined, result);
        } catch (e) {
          failure = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => { this.notify(); resolve(result); };
      tx.onabort = () => reject(storageError(failure || tx.error));
      tx.onerror = () => { failure ??= tx.error; };
    });
  }
  async queueMissingPhotos(remoteIds: Set<string>) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["documents", "photo-outbox"], "readwrite");
      const request = tx.objectStore("documents").getAll();
      request.onsuccess = () => {
        const queue = tx.objectStore("photo-outbox");
        for (const document of request.result as Inspection[]) for (const photo of photos(document)) {
          if (!remoteIds.has(photo.id)) queue.put({ id: photo.id, generation: crypto.randomUUID(), version: document.revision, action: "put" });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
    });
  }
  async photoJobs(): Promise<PhotoJob[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["documents", "photo-outbox"]);
      const documents = tx.objectStore("documents").getAll();
      const jobs = tx.objectStore("photo-outbox").getAll();
      tx.oncomplete = () => {
        const current = new Map((documents.result as Inspection[]).flatMap(photos).map(photo => [photo.id, photo]));
        resolve((jobs.result as PhotoJob[]).slice(0, 10).map(job => ({ ...job, photo: current.get(job.id) })));
      };
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
    });
  }
  async acknowledgePhoto(id: string, generation: string) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("photo-outbox", "readwrite"), store = tx.objectStore("photo-outbox");
      const request = store.get(id);
      request.onsuccess = () => { if (request.result?.generation === generation) store.delete(id); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => {};
    });
  }
}
export const repository = new Repository();
