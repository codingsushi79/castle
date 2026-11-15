import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/swift/**", "**/build/**"] } },
  build: { target: "safari15", chunkSizeWarningLimit: 4000 },
});
