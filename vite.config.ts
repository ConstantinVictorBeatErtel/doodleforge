import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const root = dirname(fileURLToPath(import.meta.url));

// Only saved manifests and renderable assets are exposed. The entry flow never
// starts the CLI or sends a paid World Labs request.
function savedWorlds(): Plugin {
  const mime: Record<string, string> = { '.json': 'application/json', '.spz': 'application/octet-stream', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  const install: NonNullable<Plugin['configureServer']> = (server) => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? '').split('?')[0];
      if (!path.startsWith('/world-assets/')) return next();
      const match = path.match(/^\/world-assets\/([a-zA-Z0-9_-]+)\/(manifest\.json|assets\/[a-zA-Z0-9_.-]+)$/);
      if (!match || !['GET', 'HEAD'].includes(req.method ?? '')) { res.statusCode = 404; res.end('Not found'); return; }
      const worldRoot = resolve(root, 'data/worlds', match[1]);
      const file = resolve(worldRoot, match[2]);
      const type = mime[extname(file)];
      if (!type || !existsSync(file) || !statSync(file).isFile() || !realpathSync(file).startsWith(realpathSync(worldRoot) + sep)) {
        res.statusCode = 404; res.end('Saved room asset not found'); return;
      }
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', statSync(file).size);
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).pipe(res);
    });
  };
  return { name: 'saved-worlds', configureServer: install, configurePreviewServer: install };
}

export default defineConfig({
  root,
  plugins: [react(), savedWorlds(), VitePWA({
    registerType: "autoUpdate",
    // Precache only the app shell — never the room/collider splats, GLBs or storage URLs,
    // which are per-world and already cached server-side into Convex storage (see
    // convex/worlds.ts). Explicit glob keeps the sample GLBs under public/models from being
    // swept into the service worker's precache.
    // The three.js/Spark/Convex bundle is a single ~6-7 MB chunk (no code-splitting yet) —
    // comfortably under this cap so the app shell still gets precached instead of Workbox
    // silently skipping it and the whole build failing.
    workbox: { globPatterns: ["**/*.{js,css,html,svg,woff2}"], maximumFileSizeToCacheInBytes: 10 * 1024 * 1024 },
    includeAssets: ["apple-touch-icon.png"],
    manifest: {
      name: "doodleforge",
      short_name: "doodleforge",
      description: "Walk a scanned room and sketch new objects into it.",
      start_url: "/",
      display: "standalone",
      background_color: "#0b0d10",
      theme_color: "#0b0d10",
      icons: [
        { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
        { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
        { src: "/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
  })],
  server: {
    host: true,
    port: 5173,
    fs: { deny: ["**/.env", "**/.env.*", "**/*.{crt,pem}", "**/.git/**", "**/.local/**", "**/asset-output/**"] },
  },
});
