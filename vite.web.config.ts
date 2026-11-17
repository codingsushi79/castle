import react from "@vitejs/plugin-react";
import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The web version of Castle Online, served by the Castle Online server at
 * /play/. Built into server/public/play, which Vercel serves as static files.
 */
export default defineConfig({
  root: resolve(__dirname, "web"),
  base: "/play/",
  publicDir: resolve(__dirname, "public"),
  plugins: [
    react(),
    {
      name: "castle-web-extras",
      closeBundle: () => {
        copyFileSync(resolve(__dirname, "src-tauri/icons/icon.png"), resolve(__dirname, "server/public/play/icon-512.png"));
        rmSync(resolve(__dirname, "server/public/play/dev-command.json"), { force: true }); // a local development file, not for the web
      },
    },
  ],
  build: { outDir: resolve(__dirname, "server/public/play"), emptyOutDir: true, target: "safari15", chunkSizeWarningLimit: 4000 },
  server: { port: 1430, strictPort: true },
});
