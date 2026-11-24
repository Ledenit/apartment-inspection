import checklists from "./checklists.json";
export type RoomType = keyof typeof checklists;
export const roomTypes = Object.keys(checklists) as RoomType[];
export const config = {
  roomPhotos: 15,
  defectPhotos: 6,
  maxPhotoSide: 1600,
  jpegQuality: 0.82,
};
export interface Photo {
  id: string;
  blob: Blob;
  caption: string;
  width: number;
  height: number;
}
export interface Defect {
  id: string;
  title: string;
  description: string;
  photos: Photo[];
}
export interface Room {
  id: string;
  type: RoomType;
  name: string;
  description: string;
  checkedItemIds: string[];
  photos: Photo[];
  defects: Defect[];
}
export interface Inspection {
  id: string;
  title: string;
  address: string;
  inspectionDate: string;
  description: string;
  rooms: Room[];
  generalCheckedItemIds?: string[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}
export const getChecklist = (type: RoomType) => checklists[type];
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function displayDate(value: string, short = false) {
  const [y, m, d] = value.split("-");
  return short
    ? `${d}.${m}.${y}`
    : new Date(Number(y), Number(m) - 1, Number(d))
        .toLocaleDateString("ru-RU", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
        .replace(" г.", "");
}
export function plural(n: number, forms: [string, string, string]) {
  const v = Math.abs(n) % 100;
  return `${n} ${forms[v > 10 && v < 15 ? 2 : v % 10 === 1 ? 0 : v % 10 >= 2 && v % 10 <= 4 ? 1 : 2]}`;
}
export const roomCount = (n: number) =>
  plural(n, ["комната", "комнаты", "комнат"]);
export const defectCount = (n: number) =>
  n ? plural(n, ["дефект", "дефекта", "дефектов"]) : "нет дефектов";
export const totalDefects = (d: Inspection) =>
  d.rooms.reduce((n, r) => n + r.defects.length, 0);
export function uniqueRoomName(base: string, rooms: Room[], exceptId?: string) {
  const names = new Set(
    rooms.filter((r) => r.id !== exceptId).map((r) => r.name),
  );
  let name = base.trim(),
    n = 2;
  while (names.has(name)) name = `${base.trim()} ${n++}`;
  return name;
}
export function newRoom(type: RoomType, name: string, rooms: Room[]): Room {
  return {
    id: crypto.randomUUID(),
    type,
    name: uniqueRoomName(name || type, rooms),
    description: "",
    checkedItemIds: [],
    photos: [],
    defects: [],
  };
}
export class StorageError extends Error {
  constructor(
    public code: "not-found" | "conflict" | "quota" | "unavailable" | "invalid",
    message?: string,
  ) {
    super(message || code);
  }
}
export function validateDocument(d: Inspection) {
  const invalid = () => {
    throw new StorageError(
      "invalid",
      "Проверьте обязательные поля и ограничения фотографий.",
    );
  };
  if (
    !d.id ||
    !d.address.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.inspectionDate)
  )
    invalid();
  const [y, m, day] = d.inspectionDate.split("-").map(Number);
  const date = new Date(y, m - 1, day);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== day
  )
    invalid();
  const ids = new Set<string>();
  const id = (value: string) => {
    if (!value || ids.has(value)) invalid();
    ids.add(value);
  };
  id(d.id);
  if (d.generalCheckedItemIds !== undefined && (
    !Array.isArray(d.generalCheckedItemIds) ||
    new Set(d.generalCheckedItemIds).size !== d.generalCheckedItemIds.length ||
    d.generalCheckedItemIds.some(value => !getChecklist("Общее").some(item => item.id === value))
  )) invalid();
  const photos = (items: Photo[], max: number) => {
    if (items.length > max) invalid();
    for (const p of items) {
      id(p.id);
      if (
        !(p.blob instanceof Blob) ||
        p.blob.type !== "image/jpeg" ||
        p.width <= 0 ||
        p.height <= 0 ||
        Math.max(p.width, p.height) > config.maxPhotoSide
      )
        invalid();
    }
  };
  for (const r of d.rooms) {
    id(r.id);
    if (
      !r.name.trim() ||
      !roomTypes.includes(r.type) ||
      r.checkedItemIds.some(
        (i) => !getChecklist(r.type).some((c) => c.id === i),
      ) ||
      new Set(r.checkedItemIds).size !== r.checkedItemIds.length
    )
      invalid();
    photos(r.photos, config.roomPhotos);
    for (const f of r.defects) {
      id(f.id);
      if (!f.title.trim()) invalid();
      photos(f.photos, config.defectPhotos);
    }
  }
}
