import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { Repository } from "../../src/repository";
import { DraftSession } from "../../src/session";
import {
  StorageError,
  newRoom,
  localDate,
  uniqueRoomName,
  roomCount,
  config,
} from "../../src/model";
const repo = () => new Repository(`test-${crypto.randomUUID()}`);
const create = (r: Repository) =>
  r.createDocument({
    title: "Осмотр",
    address: "Тестовый адрес",
    inspectionDate: "2026-11-20",
  });
describe("transactional repository", () => {
  it("retries a synchronous SecurityError from IndexedDB open", async () => {
    const r = repo();
    const original = indexedDB.open.bind(indexedDB);
    const open = vi
      .spyOn(indexedDB, "open")
      .mockImplementationOnce(() => {
        throw new DOMException("blocked", "SecurityError");
      })
      .mockImplementation(original);
    try {
      await expect(r.listDocuments()).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await r.listDocuments()).toEqual([]);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
    }
  });
  it("persists nested data and rejects concurrent stale writes without overwriting winner", async () => {
    const r = repo(),
      d = await create(r);
    const a = r.updateDocument(d.id, d.revision, (v) => {
      v.description = "первая вкладка";
      v.rooms.push(newRoom("Комната", "Комната", []));
    });
    const b = r.updateDocument(d.id, d.revision, (v) => {
      v.description = "вторая вкладка";
    });
    const result = await Promise.allSettled([a, b]);
    expect(result.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
    expect((result[1] as PromiseRejectedResult).reason.code).toBe("conflict");
    const stored = await r.getDocument(d.id);
    expect(stored.description).toBe("первая вкладка");
    expect(stored.rooms).toHaveLength(1);
    expect(stored.revision).toBe(2);
  });
  it("rolls back invalid nested mutation and photo limit atomically", async () => {
    const r = repo(),
      d = await create(r);
    await expect(
      r.updateDocument(d.id, 1, (v) => {
        v.title = "must roll back";
        const room = newRoom("Комната", "Комната", []);
        room.photos = Array.from({ length: config.roomPhotos + 1 }, () => ({
          id: crypto.randomUUID(),
          blob: new Blob(["jpeg"], { type: "image/jpeg" }),
          width: 10,
          height: 10,
          caption: "",
        }));
        v.rooms.push(room);
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await r.getDocument(d.id)).toMatchObject({
      title: "Осмотр",
      revision: 1,
      rooms: [],
    });
  });
  it("deletes only the expected revision", async () => {
    const r = repo(),
      d = await create(r);
    await r.updateDocument(d.id, 1, (v) => {
      v.title = "changed";
    });
    await expect(r.deleteDocument(d.id, 1)).rejects.toMatchObject({
      code: "conflict",
    });
    await r.deleteDocument(d.id, 2);
    await expect(r.getDocument(d.id)).rejects.toMatchObject({
      code: "not-found",
    });
  });
  it("rejects empty defects, foreign checklist IDs and invalid calendar days", async () => {
    const r = repo(),
      d = await create(r);
    for (const mutate of [
      (v: typeof d) => {
        v.inspectionDate = "2026-02-30";
      },
      (v: typeof d) => {
        const room = newRoom("Комната", "Комната", []);
        room.defects.push({
          id: crypto.randomUUID(),
          title: "  ",
          description: "",
          photos: [],
        });
        v.rooms.push(room);
      },
      (v: typeof d) => {
        const room = newRoom("Кухня", "Кухня", []);
        room.checkedItemIds = ["room-walls"];
        v.rooms.push(room);
      },
    ]) {
      await expect(r.updateDocument(d.id, 1, mutate)).rejects.toMatchObject({
        code: "invalid",
      });
    }
  });
});
describe("draft queue", () => {
  for (const failure of [false, true])
    it(`discards a new defect without resurrection after ${failure ? "failed" : "successful"} autosave`, async () => {
      const r = repo();
      let d = await create(r);
      const room = newRoom("Комната", "Комната", []);
      d = await r.updateDocument(d.id, d.revision, (v) => {
        v.rooms.push(room);
      });
      const original = r.updateDocument.bind(r);
      let fail = failure;
      r.updateDocument = async (...args) => {
        if (fail) throw new StorageError("quota");
        return original(...args);
      };
      const s = new DraftSession(r, d, () => {});
      s.edit((v) => {
        v.rooms[0].defects.push({
          id: "new-defect",
          title: "Temporary",
          description: "",
          photos: [],
        });
      });
      await s.flush().catch(() => {});
      if (failure) {
        await expect(
          s.discardDefect(room.id, "new-defect", true),
        ).rejects.toMatchObject({ code: "quota" });
        expect(s.draft.rooms[0].defects).toEqual([]);
        fail = false;
        await s.retry();
      } else await s.discardDefect(room.id, "new-defect", true);
      expect((await r.getDocument(d.id)).rooms[0].defects).toEqual([]);
      expect(s.dirty).toBe(false);
    });
  it("settles in-flight save, cancels queued defect content and preserves unrelated draft", async () => {
    const r = repo();
    let d = await create(r);
    const room = newRoom("Комната", "Комната", []);
    d = await r.updateDocument(d.id, d.revision, (v) => {
      v.rooms.push(room);
    });
    const original = r.updateDocument.bind(r);
    let release!: () => void;
    let first = true;
    r.updateDocument = async (...args) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(...args);
    };
    const s = new DraftSession(r, d, () => {});
    s.edit((v) => {
      v.rooms[0].defects.push({
        id: "discard",
        title: "first",
        description: "",
        photos: [],
      });
    });
    s.edit((v) => {
      v.rooms[0].defects[0].title = "queued";
      v.description = "keep";
    });
    const discard = s.discardDefect(room.id, "discard", true);
    release();
    await discard;
    const stored = await r.getDocument(d.id);
    expect(stored.rooms[0].defects).toEqual([]);
    expect(stored.description).toBe("keep");
  });
  it("restores an existing defect to its last confirmed value while preserving other input", async () => {
    const r = repo();
    let d = await create(r);
    const room = newRoom("Комната", "Комната", []);
    room.defects.push({
      id: "existing",
      title: "confirmed",
      description: "saved",
      photos: [],
    });
    d = await r.updateDocument(d.id, d.revision, (v) => {
      v.rooms.push(room);
    });
    const original = r.updateDocument.bind(r);
    r.updateDocument = async () => {
      throw new StorageError("quota");
    };
    const s = new DraftSession(r, d, () => {});
    s.edit((v) => {
      v.rooms[0].defects[0].title = "unconfirmed";
      v.description = "keep";
    });
    await s.flush().catch(() => {});
    r.updateDocument = original;
    await s.discardDefect(room.id, "existing", false);
    const stored = await r.getDocument(d.id);
    expect(stored.rooms[0].defects[0].title).toBe("confirmed");
    expect(stored.description).toBe("keep");
  });
  it("keeps input typed while a previous save is in flight and flushes final snapshot", async () => {
    const r = repo(),
      d = await create(r);
    let release!: () => void;
    const original = r.updateDocument.bind(r);
    let first = true;
    r.updateDocument = async (...args) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(...args);
    };
    const s = new DraftSession(r, d, () => {});
    s.edit((v) => {
      v.description = "a";
    });
    s.edit((v) => {
      v.description = "ab";
    });
    s.edit((v) => {
      v.description = "abc";
    });
    release();
    await s.flush();
    expect(s.draft.description).toBe("abc");
    expect((await r.getDocument(d.id)).description).toBe("abc");
    expect(s.dirty).toBe(false);
  });
  it("retains quota-failed draft and later edits, retries complete snapshot", async () => {
    const r = repo(),
      d = await create(r);
    const original = r.updateDocument.bind(r);
    let fail = true;
    r.updateDocument = async (...args) => {
      if (fail) throw new StorageError("quota");
      return original(...args);
    };
    const s = new DraftSession(r, d, () => {});
    s.edit((v) => {
      v.description = "не терять";
    });
    await expect(s.flush()).rejects.toMatchObject({ code: "quota" });
    s.edit((v) => {
      v.title = "ещё ввод";
    });
    expect((await r.getDocument(d.id)).description).toBe("");
    expect(s.draft.description).toBe("не терять");
    fail = false;
    await s.retry();
    expect(await r.getDocument(d.id)).toMatchObject({
      description: "не терять",
      title: "ещё ввод",
    });
  });
  it("preserves conflicting draft and only reloads on explicit request", async () => {
    const r = repo(),
      d = await create(r),
      s = new DraftSession(r, d, () => {});
    await r.updateDocument(d.id, 1, (v) => {
      v.description = "remote";
    });
    s.edit((v) => {
      v.description = "local";
    });
    await expect(s.flush()).rejects.toMatchObject({ code: "conflict" });
    await expect(s.retry()).rejects.toMatchObject({ code: "conflict" });
    expect(s.draft.description).toBe("local");
    expect((await r.getDocument(d.id)).description).toBe("remote");
    await s.reload();
    expect(s.draft.description).toBe("remote");
  });
});
it("uses calendar date, stable naming and Russian counts", () => {
  expect(localDate(new Date(2026, 0, 2, 0, 1))).toBe("2026-01-02");
  const rooms = [newRoom("Комната", "Комната", [])];
  rooms.push(newRoom("Комната", "Комната", rooms));
  expect(uniqueRoomName("Комната", rooms)).toBe("Комната 3");
  expect(rooms[0].name).toBe("Комната");
  expect([1, 2, 5, 11, 21].map(roomCount)).toEqual([
    "1 комната",
    "2 комнаты",
    "5 комнат",
    "11 комнат",
    "21 комната",
  ]);
});
