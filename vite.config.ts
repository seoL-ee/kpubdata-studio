import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  // GitHub Pages에서는 /kpubdata-studio/ 하위 경로에서 서빙되므로 production(빌드·프리뷰) base를 맞춘다.
  // 로컬 dev 서버는 루트(/)를 사용한다. `vite preview`도 production mode라 base가 유지된다.
  base: mode === "production" ? "/kpubdata-studio/" : "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
