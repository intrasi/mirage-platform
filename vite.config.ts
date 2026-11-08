import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT || 4183),
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT || 4184}` },
  },
});
