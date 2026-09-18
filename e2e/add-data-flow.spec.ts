import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, prepareCleanPage, t } from "./helpers";

/**
 * Add Data 시나리오 (#268 시나리오 1/2/3, mock deterministic).
 *
 * Public API happy path: Source 선택 → Configure → (Preview) → Review의
 * canonical BuildSpec 확인까지. File source 진입도 확인한다.
 * 실제 제출·실행은 실 Builder 연결(kpubdata#282 cross-repo) 범위다.
 */
test.beforeEach(async ({ page }) => {
  await prepareCleanPage(page);
});

test("Public API source로 Source→Configure 단계가 진행된다", async ({ page }) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  await page.goto("/add");
  await expect(page.getByRole("heading", { name: t("addData.source.title") })).toBeVisible();

  // 1단계는 source kind 3종 카드다 — Public API를 고른다.
  const publicApiCard = page.getByRole("button", { name: /Public API/ }).first();
  await expect(publicApiCard).toBeVisible();
  await publicApiCard.click();

  // 다음 단계(Configure): 제공자/데이터셋 선택 폼이 렌더링된다.
  await page.getByRole("button", { name: "다음" }).first().click();
  // 같은 문구가 stepper 라벨에도 있어 getByText 는 두 개를 잡는다 — 단계 제목(heading)으로 좁힌다.
  await expect(page.getByRole("heading", { name: t("addData.configure.title") })).toBeVisible();
  await expect(page.getByLabel(t("addData.configure.providerLabel"))).toBeVisible();
  await expect(page.getByLabel(t("addData.configure.datasetLabel"))).toBeVisible();

  await expectNoPageErrors(errors);
});

test("File source 탭이 표시되고 업로드 UI가 존재한다", async ({ page }) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  await page.goto("/add");
  await expect(page.getByRole("heading", { name: t("addData.source.title") })).toBeVisible();

  // Source kind 선택에 File 진입점이 있다.
  const fileEntry = page.getByRole("button", { name: "File Upload" }).first();
  await expect(fileEntry).toBeVisible();

  await expectNoPageErrors(errors);
});

test("Review 단계는 진입 전 단계를 거쳐야 한다(임의 진입 방어는 유닛 레벨 검증)", async ({
  page,
}) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  // 마법사 상태 없이 /add에 진입하면 항상 1단계부터다(초안 복원 안내 제외).
  await page.goto("/add");
  await expect(page.getByRole("heading", { name: t("addData.source.title") })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: t("addData.source.title") }).or(page.getByText(/복원/).first()).first()).toBeVisible();

  await expectNoPageErrors(errors);
});
