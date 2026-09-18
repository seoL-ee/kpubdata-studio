import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { afterEach, afterAll } from "vitest";

/**
 * RTL 비동기 대기 한도 (#377 후속).
 *
 * 기본값 1초는 이 앱의 단계 전환(카탈로그 조회 → 폼 렌더)에 부족해서, 여러 테스트가
 * 각자 `{ timeout: 4000 }` 을 손으로 붙여 쓰고 있었다. 한도는 한 곳에서만 관리한다.
 *
 * **이 숫자는 앱이 빠르다는 주장이 아니라 공유 러너 변동에 대한 예산이다.** 같은
 * 테스트(`newBuildDraft` 의 6단계 마법사 순회)가 로컬 182ms / CI 11.2초로 측정된 적이
 * 있다 — 60배 차이이고 코드가 아니라 러너 부하다. 예산을 러너 최고 속도에 맞춰
 * 조여두면 느린 날마다 거짓 실패가 난다.
 *
 * 대가는 "진짜로 깨진 대기"의 보고가 늦어지는 것뿐이다 — 실패 자체는 그대로 난다.
 */
configure({ asyncUtilTimeout: 30_000 });

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
