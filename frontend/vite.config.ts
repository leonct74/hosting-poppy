/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The host serves the built frontend from the extension dir; keep asset paths relative.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 1531 },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] },
});
