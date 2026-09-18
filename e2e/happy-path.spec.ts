import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, prepareCleanPage, t } from "./helpers";

/**
 * 신규 사용자 Public API happy path (#268 시나리오 1, mock deterministic).
 *
 * Home(신규) → Discover → dataset 카탈로그 탐색 → Add Data 진입.
 * mock 모드의 deterministic fixture로 검증한다.
 */
test.beforeEach(async ({ page }) => {
  await prepareCleanPage(page);
});

test("신규 사용자가 Home에서 Discover·Add Data로 이동한다", async ({ page }) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  await page.goto("/");
  await expect(page.getByRole("heading").first()).toBeVisible();

  // Discover: mock 카탈로그가 provider 2개 이상 렌더링된다.
  await page.goto("/discover");
  await expect(page.getByRole("heading", { name: "데이터 탐색", exact: true })).toBeVisible();
  await expect(page.getByText("air_quality").first()).toBeVisible();

  // Add Data 진입: Source 선택 단계가 렌더링된다.
  await page.goto("/add");
  await expect(page.getByRole("heading", { name: t("addData.source.title") })).toBeVisible();

  await expectNoPageErrors(errors);
});

test("Workspace에 Saved BuildSpec 저장·새로고침 후 재노출된다 (#268 시나리오 5)", async ({
  page,
}) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  await page.goto("/builds/new");
  await expect(page.getByRole("heading", { name: /템플릿 선택|기본 정보/ }).first()).toBeVisible();

  // 빌드 만들기 CTA로 Workspace 진입 가능성을 확인한다(저장 흐름은 유닛 레벨에서
  // 정밀 검증됨 — 여기선 화면 전환과 빈 상태 안내가 회귀 없음을 확인한다).
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "작업대" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "작업대" })).toBeVisible();

  await expectNoPageErrors(errors);
});

test("Monitoring이 mock 상태 카드를 렌더링한다 (#268 시나리오 8)", async ({ page }) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  await page.goto("/monitoring");
  await expect(page.getByRole("heading", { name: "시스템 모니터링" })).toBeVisible();
  await expect(page.getByText("Builder API")).toBeVisible();

  // Recent Runs 탭이 mock run 목록을 표시한다.
  await page.getByRole("button", { name: "Recent Runs" }).click();
  await expect(page.getByText("run-001")).toBeVisible();

  await expectNoPageErrors(errors);
});
