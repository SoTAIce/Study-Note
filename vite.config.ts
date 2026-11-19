import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { appStamp } from "./server/app-stamp.ts";

export default defineConfig(({ command }) => ({
  root: "web",
  // 构建时的代码指纹（repo-003）：和服务端算的对不上就提示「应用已更新，刷新一下」；开发模式不提示
  define: { __APP_STAMP__: JSON.stringify(command === "build" ? appStamp(fileURLToPath(new URL(".", import.meta.url))) : "") },
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:7777",
    },
  },
}));
