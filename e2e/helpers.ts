import { expect, type Page } from "@playwright/test";

/**
 * 공용 헬퍼 (#268).
 *
 * - collectPageErrors: 각 스펙이 console error/unhandled rejection 없음을
 *   단정할 수 있게 한다(이슈 체크리스트).
 * - localStorage 정리: 사용자 상태(Workspace #293 소유자 버킷 포함)가 스펙 간
 *   새지 않도록 컨텍스트 시작 시 초기화한다.
 */

export async function prepareCleanPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      // 프라이빗 모드 등에서는 무시한다.
    }
  });
}

export function collectPageErrors(page: Page, bucket: string[]): void {
  page.on("pageerror", (error) => bucket.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Builder 미기동 환경에서 mock 우선 화면(Workspace 등)이 Builder 조회를
    // 먼저 시도하고 폴백하는 것은 앱 설계상 정상이다(#292) — 리소스 로드 실패
    // 리포트는 앱 오류가 아니므로 제외한다.
    if (text.includes("net::ERR_CONNECTION_REFUSED")) return;
    bucket.push(`console.error: ${text}`);
  });
}

export async function expectNoPageErrors(bucket: string[]): Promise<void> {
  // mock 모드에서 mock 데이터 폴백 로그(warn)는 허용한다 — error만 잡는다.
  expect(bucket, `page errors:\n${bucket.join("\n")}`).toEqual([]);
}
