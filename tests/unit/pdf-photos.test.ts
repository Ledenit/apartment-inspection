import { afterEach, expect, it, vi } from "vitest";
import { pdfPhotoBudget, preparePdfPhoto } from "../../src/pdf-photos";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function canvasFixture(
  width = 1600,
  height = 1067,
  outputs: (number | null)[] = [500_000],
) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  const drawImage = vi.fn();
  const dimensions: number[][] = [];
  const qualities: number[] = [];
  function encode(quality: number) {
    dimensions.push([canvas.width, canvas.height]);
    qualities.push(quality);
    const size = outputs.shift();
    if (size == null) throw new Error("Encoder failed");
    return new Blob([new Uint8Array(size)], { type: "image/jpeg" });
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage }),
    toDataURL(_type: string, quality: number) {
      const blob = encode(quality);
      return `data:image/jpeg;base64,${btoa("x".repeat(blob.size))}`;
    },
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  return { close, canvas, dimensions, drawImage, qualities };
}

it("allocates 18 MB for 30 distinct photos and passes small source blobs through unchanged", async () => {
  expect(pdfPhotoBudget(30)).toBe(600_000);
  const blob = new Blob(["jpeg"]);
  expect(await preparePdfPhoto(blob, pdfPhotoBudget(30))).toBe(blob);
});
it("bounds attempts, preserves aspect ratio, and closes bitmap/canvas after success", async () => {
  const fixture = canvasFixture(1600, 1000, [700_000, 650_000, 450_000]);
  const source = new Blob([new Uint8Array(700_000)], { type: "image/jpeg" });
  const result = await preparePdfPhoto(source, 600_000);
  expect(result.size).toBe(450_000);
  expect(source.size).toBe(700_000);
  expect(fixture.dimensions).toEqual([
    [1600, 1000],
    [1600, 1000],
    [1200, 750],
  ]);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.canvas.width).toBe(0);
  expect(fixture.canvas.height).toBe(0);
});
it("does not upscale small images that exceed a byte budget", async () => {
  const fixture = canvasFixture(320, 240, [100]);
  await preparePdfPhoto(new Blob([new Uint8Array(500)]), 200);
  expect(fixture.dimensions).toEqual([[320, 240]]);
});
it("releases bitmap and canvas on encoder failure", async () => {
  const fixture = canvasFixture(1600, 1000, [null]);
  await expect(
    preparePdfPhoto(new Blob([new Uint8Array(900_000)]), 600_000),
  ).rejects.toThrow();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.canvas.width).toBe(0);
  expect(fixture.canvas.height).toBe(0);
});
it("stops after the bounded attempts if the image cannot meet the budget", async () => {
  const fixture = canvasFixture(1600, 1000, [700, 650, 610]);
  await expect(
    preparePdfPhoto(new Blob([new Uint8Array(700)]), 600),
  ).rejects.toThrow();
  expect(fixture.dimensions).toHaveLength(3);
  expect(fixture.close).toHaveBeenCalledOnce();
});
it("chooses the initial quality from the byte budget without a redundant encode", async () => {
  const fixture = canvasFixture(1600, 1067, [480_000]);
  await preparePdfPhoto(new Blob([new Uint8Array(900_000)]), 600_000);
  expect(fixture.qualities).toEqual([0.6]);
});
it("encodes a JPEG without relying on OffscreenCanvas or idle callbacks", async () => {
  vi.stubGlobal("OffscreenCanvas", undefined);
  const fixture = canvasFixture(320, 240, [400]);
  const result = await preparePdfPhoto(new Blob([new Uint8Array(900)]), 600);
  expect(result.type).toBe("image/jpeg");
  expect(result.size).toBe(400);
  expect(fixture.dimensions).toEqual([[320, 240]]);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.canvas.width).toBe(0);
});
it("rejects a browser that does not produce JPEG and releases resources", async () => {
  const fixture = canvasFixture(320, 240);
  fixture.canvas.toDataURL = () => "data:image/png;base64,eA==";
  await expect(
    preparePdfPhoto(new Blob([new Uint8Array(900)]), 600),
  ).rejects.toThrow();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.canvas.width).toBe(0);
});
it("revokes a fallback object URL if browser image decoding fails", async () => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      throw Error("unsupported");
    }),
  );
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      async decode() {
        throw Error("corrupt");
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await expect(preparePdfPhoto(new Blob(["large"]), 1)).rejects.toThrow(
    "corrupt",
  );
  expect(revoke).toHaveBeenCalledWith("blob:test");
});
