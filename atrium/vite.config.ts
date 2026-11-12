import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  publicDir: "../../public",
  plugins: [react()],
  build: { outDir: "../../dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
