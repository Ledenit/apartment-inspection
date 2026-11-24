import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { Repository } from "../../src/repository";
import { newRoom, type Inspection } from "../../src/model";

const create = (repo: Repository) => repo.createDocument({ title: "QA", address: "Synthetic address", inspectionDate: "2026-11-24" });
function photo() { return { id: crypto.randomUUID(), blob: new Blob(["synthetic jpeg"], { type: "image/jpeg" }), width: 10, height: 10, caption: "" }; }
async function setup() {
  const repo = new Repository(`outbox-qa-${crypto.randomUUID()}`), first = await create(repo), image = photo();
  const doc = await repo.updateDocument(first.id, 1, value => { const room = newRoom("Комната", "Комната", []); room.photos.push(image); value.rooms.push(room); });
  return { repo, doc, image };
}
describe("durable photo outbox", () => {
  it("queues committed additions only; invalid and stale updates roll back document and jobs together", async () => {
    const { repo, doc, image } = await setup();
    const jobs = await repo.photoJobs(); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ id: image.id, version: doc.revision, action: "put", photo: { id: image.id } });
    await repo.acknowledgePhoto(image.id, jobs[0].generation);
    await expect(repo.updateDocument(doc.id, 1, value => value.rooms[0].photos.push(photo()))).rejects.toMatchObject({ code: "conflict" });
    await expect(repo.updateDocument(doc.id, doc.revision, value => { value.address = ""; value.rooms[0].photos.push(photo()); })).rejects.toMatchObject({ code: "invalid" });
    expect(await repo.photoJobs()).toEqual([]); expect(await repo.getDocument(doc.id)).toEqual(doc);
  });
  it("keeps delete tombstones and a delayed old upload acknowledgement cannot remove a newer job", async () => {
    const { repo, doc, image } = await setup(), [old] = await repo.photoJobs();
    await repo.deleteDocument(doc.id, doc.revision);
    const [removed] = await repo.photoJobs(); expect(removed).toMatchObject({ id: image.id, version: doc.revision + 1, action: "delete", photo: undefined }); expect(removed.generation).not.toBe(old.generation);
    await repo.acknowledgePhoto(image.id, old.generation); expect(await repo.photoJobs()).toEqual([removed]);
    await repo.acknowledgePhoto(image.id, removed.generation); expect(await repo.photoJobs()).toEqual([]);
  });
  it("queues room-photo removal at the committed update revision while caption edits do not upload unchanged bytes", async () => {
    const { repo, doc, image } = await setup(), [job] = await repo.photoJobs(); await repo.acknowledgePhoto(image.id, job.generation);
    const captioned = await repo.updateDocument(doc.id, doc.revision, value => { value.rooms[0].photos[0].caption = "Updated caption"; });
    expect(await repo.photoJobs()).toEqual([]);
    const removed = await repo.updateDocument(doc.id, captioned.revision, value => { value.rooms[0].photos = []; });
    expect(await repo.photoJobs()).toMatchObject([{ id: image.id, version: removed.revision, action: "delete", photo: undefined }]);
  });
  it("reconciles missing remote photos and copies receive separate upload and delete jobs", async () => {
    const { repo, doc, image } = await setup(), [job] = await repo.photoJobs(); await repo.acknowledgePhoto(image.id, job.generation);
    await repo.queueMissingPhotos(new Set([image.id])); expect(await repo.photoJobs()).toEqual([]);
    await repo.queueMissingPhotos(new Set()); expect(await repo.photoJobs()).toMatchObject([{ id: image.id, action: "put" }]);
    const copy = await repo.duplicateDocument(doc.id, doc.revision), copyId = copy.rooms[0].photos[0].id;
    expect(copyId).not.toBe(image.id); expect((await repo.photoJobs()).map(j => j.id).sort()).toEqual([copyId, image.id].sort());
    await repo.deleteDocument(copy.id, copy.revision);
    expect((await repo.photoJobs()).find(j => j.id === copyId)).toMatchObject({ action: "delete", version: 2, photo: undefined });
    expect((await repo.photoJobs()).find(j => j.id === image.id)).toMatchObject({ action: "put", photo: { id: image.id } });
    expect(await repo.getDocument(doc.id)).toEqual(doc);
  });
  it("upgrades an existing v1 store without losing photos and reconciles them into the v2 outbox", async () => {
    const name = `outbox-legacy-qa-${crypto.randomUUID()}`, original = new Repository(`source-qa-${crypto.randomUUID()}`), base = await create(original);
    const room = newRoom("Комната", "Комната", []); room.photos.push(photo()); const legacy: Inspection = { ...base, rooms: [room] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, 1); request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "id" }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("documents", "readwrite"); tx.objectStore("documents").put(legacy); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    const upgraded = new Repository(name); expect(await upgraded.getDocument(legacy.id)).toEqual(legacy); expect(await upgraded.photoJobs()).toEqual([]);
    await upgraded.queueMissingPhotos(new Set()); expect(await upgraded.photoJobs()).toMatchObject([{ id: room.photos[0].id, action: "put", photo: { id: room.photos[0].id } }]);
  });
});
