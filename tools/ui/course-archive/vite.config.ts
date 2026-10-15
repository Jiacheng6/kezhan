import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  define: { __RHINE_MODELS__: "{}" },
  build: {
    target: "es2022",
    outDir: "../../../src/ui/library/archive",
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three";
        },
      },
    },
  },
});
