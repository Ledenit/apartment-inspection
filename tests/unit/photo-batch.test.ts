import { expect, it, vi } from "vitest";
import { addPhotoBatch } from "../../src/photo-batch";
import { Photo } from "../../src/model";

const photo = (): Photo => ({
  id: crypto.randomUUID(),
  blob: new Blob(["jpeg"], { type: "image/jpeg" }),
  width: 10,
  height: 10,
  caption: "",
});
const files = () => [
  new File(["valid"], "one.jpg"),
  new File(["valid"], "two.jpg"),
];

it("rejects an entire oversized selection before decoding or adding any file", async () => {
  const photos = Array.from({ length: 14 }, photo);
  const prepare = vi.fn(async () => photo());
  const result = await addPhotoBatch(
    files(),
    15,
    () => photos,
    prepare,
    (p) => photos.push(p),
  );
  expect(result.overflow).toBe(true);
  expect(photos).toHaveLength(14);
  expect(prepare).not.toHaveBeenCalled();
});
it("keeps existing and valid new photos when another file is corrupt", async () => {
  const photos = [photo()];
  const first = photos[0];
  let call = 0;
  const result = await addPhotoBatch(
    files(),
    15,
    () => photos,
    async () => {
      if (call++ === 0) throw Error("corrupt");
      return photo();
    },
    (p) => photos.push(p),
  );
  expect(result.errors).toBe(1);
  expect(photos).toHaveLength(2);
  expect(photos[0]).toBe(first);
});
it("does not append or decode later files after target deletion during decode", async () => {
  let active = true;
  let release!: (value: Photo) => void;
  const append = vi.fn();
  const prepare = vi.fn(
    () =>
      new Promise<Photo>((resolve) => {
        release = resolve;
      }),
  );
  const pending = addPhotoBatch(
    files(),
    15,
    () => (active ? [] : undefined),
    prepare,
    append,
  );
  active = false;
  release(photo());
  expect((await pending).cancelled).toBe(true);
  expect(append).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledTimes(1);
});
