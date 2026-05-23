import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vitest/config";
import manifest from "./src/manifest";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    emptyOutDir: true,
    minify: "terser",
    outDir: "dist",
    sourcemap: "inline",
    terserOptions: {
      format: {
        ascii_only: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
