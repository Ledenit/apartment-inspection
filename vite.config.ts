import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import { pdfSite } from "./src/pdf-site";
import path from "node:path";
import { createApi } from "./server/api.js";
import type { Plugin } from "vite";

function photoApi(): Plugin {
  const install = async (server: { middlewares: { use: (middleware: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next: () => void) => void) => void } }) => {
    const api = await createApi({ dataDir: process.env.PHOTO_DATA_DIR ?? path.resolve("private-data"),
      origin: process.env.APP_ORIGIN, secureCookies: process.env.APP_ORIGIN?.startsWith("https:") ?? false });
    server.middlewares.use((req, res, next) => {
      void api.handle(req, res).then(handled => { if (!handled) next(); }).catch(() => {
        if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":"Service unavailable"}');
      });
    });
  };
  return { name: "private-photo-api", configureServer: install, configurePreviewServer: install };
}

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    pdfSite(
      loadEnv(mode, process.cwd(), "VITE_PUBLIC_SITE_URL").VITE_PUBLIC_SITE_URL,
    );
  }
  return {
    plugins: [photoApi()],
    server: { fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/private-data/**", "**/docs/**",
      `${path.resolve(process.env.PHOTO_DATA_DIR ?? "private-data").replace(/\\/g, "/")}/**`] } },
    test: { include: ["tests/unit/**/*.test.ts"] },
    build: { target: "es2022" },
  };
});
