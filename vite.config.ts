import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  optimizeDeps: {
    // AI 模块通过动态 import 加载，Vite 运行时发现后会触发第二轮预构建并删除
    // 第一轮缓存目录；预声明后首轮即包含，避免 Windows 下的重复预构建。
    include: ["@huggingface/transformers"],
  },

  clearScreen: false,
  server: {
    port: 8787,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 8788,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
