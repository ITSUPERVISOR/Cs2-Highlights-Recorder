import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = process.cwd();

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(root, "electron/main.ts"),
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      lib: {
        entry: resolve(root, "electron/preload.ts"),
        formats: ["cjs"],
      },
      rollupOptions: {
        output: {
          entryFileNames: "preload.cjs",
        },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: { "@": resolve(root, "src/renderer/src") },
    },
    plugins: [react(), tailwindcss()],
  },
});
