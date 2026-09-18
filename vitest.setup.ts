import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { afterEach, afterAll } from "vitest";

/**
 * RTL 비동기 대기 한도 (#377 후속).
 *
 * 기본값 1초는 이 앱의 단계 전환(카탈로그 조회 → 폼 렌더)에 부족해서, 여러 테스트가
 * 각자 `{ timeout: 4000 }` 을 손으로 붙여 쓰고 있었다. 그런데 4초도 부족한 순간이
 * 있다 — 커버리지 계측이 켜진 CI 러너에서 newBuildDraft 의 단계 전환이 4.2초가 걸려
 * main 이 빨갛게 됐다.
 *
 * 한도를 한 곳에서 넉넉하게 잡는다. 진짜로 깨진 테스트는 여전히 실패하고, 보고가
 * 조금 늦어질 뿐이다 — 반대로 한도를 러너 속도에 맞춰 조여두면 느린 날마다 거짓
 * 실패가 난다.
 */
configure({ asyncUtilTimeout: 10_000 });

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
