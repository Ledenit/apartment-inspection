import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Repository } from "../../src/repository";
import { newRoom, getChecklist, type Inspection } from "../../src/model";
import { canSharePdf, sharePdf } from "../../src/pdf-share";

async function fixture() {
  const repo = new Repository(`f13-${crypto.randomUUID()}`);
  const doc = await repo.createDocument({title: "Осмотр", address: "Тестовый адрес", inspectionDate: "2026-11-20"});
  const photo = () => ({ id: crypto.randomUUID(), blob: new Blob(["jpeg bytes"], { type: "image/jpeg" }), caption: "Подпись", width: 12, height: 8 });
  const source = await repo.updateDocument(doc.id, doc.revision, d => {
    d.generalCheckedItemIds = ["general-keys"];
    d.description = "Описание";
    const room = newRoom("Кухня", "Кухня", []);
    room.description = "Стены";
    room.checkedItemIds = [getChecklist("Кухня")[0].id];
    room.photos = [photo()];
    room.defects = [{id: crypto.randomUUID(), title: "Трещина", description: "У окна", photos: [photo()]}];
    d.rooms = [room, newRoom("Комната", "Пустая", [])];
  });
  return {repo, source};
}
const ids = (d: Inspection) => [d.id, ...d.rooms.flatMap(r => [r.id, ...r.photos.map(p => p.id), ...r.defects.flatMap(f => [f.id, ...f.photos.map(p => p.id)])])];

describe("F13 duplicate", () => {
  it("persists an independent complete copy with fresh ids and identical photo bytes", async () => {
    const {repo, source} = await fixture();
    const copy = await repo.duplicateDocument(source.id, source.revision);
    expect(copy).toMatchObject({title: "Осмотр (копия)", revision: 1, inspectionDate: source.inspectionDate, description: source.description});
    expect(ids(copy).every(id => !ids(source).includes(id))).toBe(true);
    expect(copy.rooms[0]).toMatchObject({ name: "Кухня", checkedItemIds: source.rooms[0].checkedItemIds, description: "Стены" });
    expect(copy.rooms).toHaveLength(2);
    expect(copy.generalCheckedItemIds).toEqual(["general-keys"]);
    expect(await copy.rooms[0].photos[0].blob.text()).toBe(await source.rooms[0].photos[0].blob.text());
    expect(await copy.rooms[0].defects[0].photos[0].blob.text()).toBe("jpeg bytes");
    expect(await repo.getDocument(source.id)).toEqual(source);
    await repo.updateDocument(copy.id, 1, d => {d.rooms[0].photos[0].caption = "Другая"; d.rooms[0].defects = [];});
    expect(await repo.getDocument(source.id)).toEqual(source);
    await repo.deleteDocument(copy.id, 2);
    expect(await repo.listDocuments()).toEqual([source]);
  });
  it("rejects stale/deleted sources without adding partial copies", async () => {
    const {repo, source} = await fixture();
    await expect(repo.duplicateDocument(source.id, source.revision - 1)).rejects.toMatchObject({code: "conflict"});
    expect(await repo.listDocuments()).toEqual([source]);
    await repo.deleteDocument(source.id, source.revision);
    await expect(repo.duplicateDocument(source.id, source.revision)).rejects.toMatchObject({code: "not-found"});
    expect(await repo.listDocuments()).toEqual([]);
  });
  it("aborts on quota, preserves original and permits retry", async () => {
    const {repo, source} = await fixture();
    const add = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementationOnce(() => {throw new DOMException("full", "QuotaExceededError");});
    try {
      await expect(repo.duplicateDocument(source.id, source.revision)).rejects.toMatchObject({code: "quota"});
      expect(await repo.listDocuments()).toEqual([source]);
      await repo.duplicateDocument(source.id, source.revision);
      expect(await repo.listDocuments()).toHaveLength(2);
    } finally {add.mockRestore();}
  });
  it("uses address for an untitled document", async () => {
    const {repo, source} = await fixture();
    const untitled = await repo.updateDocument(source.id, source.revision, d => {d.title = "  ";});
    expect((await repo.duplicateDocument(source.id, untitled.revision)).title).toBe("Тестовый адрес (копия)");
  });
  it("validates general marks independently and leaves legacy documents compatible", async () => {
    const {repo, source} = await fixture();
    for (const marks of [["room-walls"], ["general-keys", "general-keys"]]) {
      await expect(repo.updateDocument(source.id, source.revision, d => {d.generalCheckedItemIds = marks;})).rejects.toMatchObject({code: "invalid"});
      expect(await repo.getDocument(source.id)).toEqual(source);
    }
    const legacy = await repo.updateDocument(source.id, source.revision, d => {delete d.generalCheckedItemIds;});
    expect((await repo.duplicateDocument(legacy.id, legacy.revision)).generalCheckedItemIds).toBeUndefined();
  });
});

describe("F13 PDF sharing", () => {
  const file = new File(["%PDF-"], "Осмотр.pdf", {type: "application/pdf"});
  it("detects absent, rejected and throwing file sharing capabilities", () => {
    try {
      vi.stubGlobal("navigator", {});
      expect(canSharePdf(file)).toBe(false);
      vi.stubGlobal("navigator", {share: vi.fn(), canShare: () => false});
      expect(canSharePdf(file)).toBe(false);
      vi.stubGlobal("navigator", {share: vi.fn(), canShare: () => {throw Error("denied");}});
      expect(canSharePdf(file)).toBe(false);
    } finally {vi.unstubAllGlobals();}
  });
  it("shares the exact prepared file, treats cancellation quietly and surfaces failure", async () => {
    const share = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException("cancel", "AbortError")).mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    try {
      vi.stubGlobal("navigator", {share, canShare: () => true});
      expect(canSharePdf(file)).toBe(true);
      expect(await sharePdf(file)).toBe("shared");
      expect(share).toHaveBeenNthCalledWith(1, {files: [file]});
      expect(await sharePdf(file)).toBe("cancelled");
      await expect(sharePdf(file)).rejects.toMatchObject({name: "NotAllowedError"});
    } finally {vi.unstubAllGlobals();}
  });
});
