import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so the build works from any static host path (GitHub Pages, a subfolder, etc).
  base: "./",
  server: { port: 5173 },
  test: { include: ["tests/**/*.test.ts"] },
});
