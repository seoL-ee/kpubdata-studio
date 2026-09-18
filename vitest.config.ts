import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // e2e/는 Playwright 슈트다(#268) — vitest 수집/변환 대상에서 제외한다.
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
    // 커버리지 게이트 (#380). 목적은 새 커버리지를 강제하는 게 아니라 이미 도달한
    // 수준이 조용히 내려가지 않게 잠그는 것이다. 하한은 실측보다 2%p 낮게 둔다.
    //
    // 계측 대상은 src/ 의 애플리케이션 코드만이다 — 진입점(main.tsx)과 타입 선언,
    // 테스트 파일은 제외한다. 테스트가 import 하지 않는 진입점을 포함하면 총계만
    // 흐려지고 회귀 신호가 묻힌다.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__tests__/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      reporter: ["text-summary"],
      // 실측(2026-09-18): statements 86.54 / branches 77.12 / functions 87.93 /
      // lines 88.65. 네 지표 모두 약 2%p 아래로 잡는다. branches 하한이 눈에 띄게
      // 낮은 건 실제로 분기 커버리지가 가장 처져 있기 때문이고, 숫자를 맞추려고
      // 올리면 게이트가 상시 붉어진다 — 올리는 건 분기를 실제로 덮은 뒤의 일이다.
      thresholds: {
        statements: 84,
        branches: 75,
        functions: 85,
        lines: 86,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
