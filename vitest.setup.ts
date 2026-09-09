import "@testing-library/jest-dom/vitest";
import { afterEach, afterAll } from "vitest";

/**
 * MSW (Mock Service Worker) 설정 (#104)
 *
 * vitest 환경에서 실제 HTTP 요청을 인터셉트하여 모의 Builder API 응답을 제공한다.
 * 이를 통해 E2E 테스트를 실제 Builder 서버 없이 실행할 수 있다.
 */
import { setupServer } from "msw/node";
import { handlers } from "./__tests__/msw/handlers";
import { i18n } from "@/shared/i18n"; // 다국어 초기화 — 테스트는 ko로 고정(기존 단언 호환)
void i18n.changeLanguage("ko");

// MSW 서버 설정 (모든 핸들러 등록)
export const mswServer = setupServer(...handlers);

// 모든 테스트 시작 전 MSW 서버 시작
mswServer.listen({ onUnhandledRequest: "warn" });

// 각 테스트 후 핸들러 리셋 (이전 테스트의 요청/응답 기록 제거)
afterEach(() => {
  mswServer.resetHandlers();
});

// 모든 테스트 종료 후 MSW 서버 정리
afterAll(() => {
  mswServer.close();
});
