import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const engine = process.env.ENGINE_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/events", "/snapshot", "/history", "/equity", "/visit", "/health", "/profile", "/bee-image", "/setup", "/hive"].map((p) => [p, { target: engine, changeOrigin: false }])),
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
});
