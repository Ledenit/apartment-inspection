import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createApi, type ApiOptions } from "../../server/api";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("inspection-api-qa-")) throw new Error("Unsafe test cleanup");
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});
async function start(options: Partial<ApiOptions> = {}, existing?: string) {
  const dataDir = existing ?? await mkdtemp(path.join(tmpdir(), "inspection-api-qa-"));
  if (!existing) roots.push(dataDir);
  const api = await createApi({ dataDir, ...options });
  const server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const request = (route: string, method = "GET", body?: Buffer | string, cookie?: string, extra: Record<string, string> = {}) => fetch(origin + route, {
    method, headers: { Origin: origin, "X-Inspection-Request": "1", "X-Photo-Version": "2", ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body as BodyInit | undefined,
  });
  const login = async () => {
    const response = await request("/api/session", "POST", JSON.stringify({ phone: "70000000000", code: "0000" }), undefined, { "Content-Type": "application/json" });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^inspection_session=[a-f0-9]{64}; Path=\/api; HttpOnly; SameSite=Strict;/);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    return setCookie.split(";")[0];
  };
  return { dataDir, origin, request, login };
}
const jpeg = () => readFile("tests/unit/fixtures/photo.jpg");

describe("private photo HTTP service", () => {
  it("persists real JPEG bytes outside static files, survives restart and isolates browser owners", async () => {
    const api = await start(), photo = await jpeg(), id = randomUUID(), owner = await api.login(), other = await api.login();
    expect(owner).not.toBe(other);
    expect((await api.request(`/api/photos/${id}`)).status).toBe(401);
    expect((await api.request(`/api/photos/${id}`, "PUT", photo, owner, { "Content-Type": "image/jpeg" })).status).toBe(204);
    expect((await api.request("/api/photos", "GET", undefined, owner).then(r => r.json())).photoIds).toEqual([id]);
    expect((await api.request("/api/photos", "GET", undefined, other).then(r => r.json())).photoIds).toEqual([]);
    expect((await api.request(`/api/photos/${id}`, "GET", undefined, other)).status).toBe(404);
    const token = owner.slice(owner.indexOf("=") + 1), ownerDir = createHash("sha256").update(token).digest("hex");
    expect(await readFile(path.join(api.dataDir, "photos", ownerDir, `${id}.jpg`))).toEqual(photo);
    expect(await readdir(path.join(api.dataDir, "sessions"))).toEqual(expect.arrayContaining([`${ownerDir}.json`]));
    const restarted = await start({}, api.dataDir), result = await restarted.request(`/api/photos/${id}`, "GET", undefined, owner);
    expect(result.status).toBe(200); expect(result.headers.get("content-type")).toBe("image/jpeg");
    expect(result.headers.get("cache-control")).toContain("no-store"); expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await result.arrayBuffer())).toEqual(photo);
    expect((await restarted.request(`/api/photos/${id}`, "DELETE", undefined, other)).status).toBe(204);
    expect((await restarted.request(`/api/photos/${id}`, "GET", undefined, owner)).status).toBe(200);
    expect((await restarted.request(`/api/photos/${id}`, "DELETE", undefined, owner)).status).toBe(204);
    expect((await restarted.request(`/api/photos/${id}`, "GET", undefined, owner)).status).toBe(404);
    expect((await restarted.request("/api/photos", "GET", undefined, owner).then(r => r.json())).photoIds).toEqual([]);
  });
  it("rejects forged origins, absent CSRF header, malformed credentials and path tricks without writing photos", async () => {
    const api = await start(), owner = await api.login(), photo = await jpeg(), route = `/api/photos/${randomUUID()}`;
    const forgedHeaders: Record<string, string>[] = [{ Origin: "https://evil.example" }, { "X-Inspection-Request": "" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of forgedHeaders) {
      expect((await api.request(route, "PUT", photo, owner, { "Content-Type": "image/jpeg", ...headers })).status).toBe(403);
    }
    expect((await api.request("/api/session", "POST", '{"phone":"1","code":"0000"}', undefined, { "Content-Type": "application/json" })).status).toBe(400);
    expect((await api.request("/api/session", "POST", "{", undefined, { "Content-Type": "application/json" })).status).toBe(400);
    for (const id of ["%2e%2e%2fsecret", "..%5csecret", "not-a-uuid"]) expect((await api.request(`/api/photos/${id}`, "PUT", photo, owner, { "Content-Type": "image/jpeg" })).status).toBe(404);
    expect((await api.request("/api/photos", "GET", undefined, "inspection_session=" + "a".repeat(64))).status).toBe(401);
    expect((await api.request("/api/photos", "GET", undefined, owner).then(r => r.json())).photoIds).toEqual([]);
  });
  it("rejects non-JPEG, oversized images, excess dimensions and EXIF metadata; enforces immutable IDs and quota", async () => {
    const photo = await jpeg(), api = await start({ maxPhotoBytes: photo.length + 32, ownerQuotaBytes: photo.length, globalQuotaBytes: photo.length * 2 }), owner = await api.login(), id = randomUUID();
    const put = (bytes: Buffer, key = id, type = "image/jpeg") => api.request(`/api/photos/${key}`, "PUT", bytes, owner, { "Content-Type": type });
    expect((await put(photo, id, "image/png")).status).toBe(415);
    expect((await put(Buffer.from("<svg onload='alert(1)'/>"))).status).toBe(415);
    expect((await put(Buffer.alloc(photo.length + 33))).status).toBe(413);
    const exif = Buffer.concat([photo.subarray(0, 2), Buffer.from([255, 225, 0, 2]), photo.subarray(2)]);
    expect((await put(exif)).status).toBe(415);
    const large = Buffer.from(photo), sof = large.indexOf(Buffer.from([255, 192]));
    expect(sof).toBeGreaterThan(0); large.writeUInt16BE(1601, sof + 5);
    expect((await put(large)).status).toBe(415);
    expect((await put(photo)).status).toBe(204); expect((await put(photo)).status).toBe(204);
    const changed = Buffer.concat([photo.subarray(0, 2), Buffer.from([255, 254, 0, 2]), photo.subarray(2)]);
    expect((await put(changed)).status).toBe(409);
    expect((await put(photo, randomUUID())).status).toBe(507);
    expect(Buffer.from(await (await api.request(`/api/photos/${id}`, "GET", undefined, owner)).arrayBuffer())).toEqual(photo);
    expect((await api.request("/api/photos", "GET", undefined, owner).then(r => r.json())).photoIds).toEqual([id]);
  });
  it("sets Secure cookies when configured and enforces the configured public origin", async () => {
    const api = await start({ secureCookies: true, origin: "https://inspection.example" });
    expect((await api.request("/api/session", "POST", "{}", undefined, { "Content-Type": "application/json" })).status).toBe(403);
    const response = await api.request("/api/session", "POST", JSON.stringify({ phone: "70000000000", code: "0000" }), undefined, { Origin: "https://inspection.example", "Content-Type": "application/json" });
    expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toContain("; Secure");
  });
  it("enforces global quota across owners and reclaims photo bytes after deletion", async () => {
    const photo = await jpeg(), api = await start({ globalQuotaBytes: photo.length }), owner = await api.login(), other = await api.login(), id = randomUUID(), second = randomUUID();
    expect((await api.request(`/api/photos/${id}`, "PUT", photo, owner, { "Content-Type": "image/jpeg" })).status).toBe(204);
    expect((await api.request(`/api/photos/${second}`, "PUT", photo, other, { "Content-Type": "image/jpeg" })).status).toBe(507);
    expect((await api.request(`/api/photos/${id}`, "DELETE", undefined, owner, { "X-Photo-Version": "3" })).status).toBe(204);
    expect((await api.request(`/api/photos/${second}`, "PUT", photo, other, { "Content-Type": "image/jpeg" })).status).toBe(204);
    expect((await api.request("/api/photos", "GET", undefined, owner).then(r => r.json())).photoIds).toEqual([]);
  });
  it("persistent photo versions stop delayed uploads resurrecting deleted photos and delayed deletes removing restored photos", async () => {
    const api = await start(), owner = await api.login(), photo = await jpeg(), route = `/api/photos/${randomUUID()}`;
    for (const version of ["", "0", "-1", "1.1", "9007199254740992"]) expect((await api.request(route, "PUT", photo, owner, { "Content-Type": "image/jpeg", "X-Photo-Version": version })).status).toBe(400);
    expect((await api.request(route, "PUT", photo, owner, { "Content-Type": "image/jpeg", "X-Photo-Version": "2" })).status).toBe(204);
    expect((await api.request(route, "DELETE", undefined, owner, { "X-Photo-Version": "3" })).status).toBe(204);
    const restarted = await start({}, api.dataDir);
    expect((await restarted.request(route, "PUT", photo, owner, { "Content-Type": "image/jpeg", "X-Photo-Version": "2" })).status).toBe(204);
    expect((await restarted.request(route, "GET", undefined, owner)).status).toBe(404);
    expect((await restarted.request(route, "PUT", photo, owner, { "Content-Type": "image/jpeg", "X-Photo-Version": "3" })).status).toBe(204);
    expect((await restarted.request(route, "GET", undefined, owner)).status).toBe(404);
    expect((await restarted.request(route, "PUT", photo, owner, { "Content-Type": "image/jpeg", "X-Photo-Version": "4" })).status).toBe(204);
    expect((await restarted.request(route, "DELETE", undefined, owner, { "X-Photo-Version": "2" })).status).toBe(204);
    const response = await restarted.request(route, "GET", undefined, owner); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(photo);
  });
});
