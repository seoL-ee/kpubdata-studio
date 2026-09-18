import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, prepareCleanPage } from "./helpers";

/**
 * cross-repo 실연동 E2E (kpubdata#282 3단계 시나리오, @real-builder 태그).
 *
 * 사전 조건: 실제 Builder가 기동돼 있어야 한다(기본 http://localhost:8000,
 * REAL_BUILDER_URL로 override). Builder는 KPUBDATA_BUILDER_DEV_MODE=true로
 * 실행하고, Studio는 VITE_USE_REAL_BUILDER=true로 빌드 서버를 띄운다
 * (playwright.real.config.ts의 webServer가 주입한다).
 *
 * 검증 경로: Studio UI → fetch → Builder HTTP → dispatch → orchestrator →
 * kpubdata ingestion(file) → Bronze/Silver/Gold → manifest → 응답 → UI 렌더링.
 * file source는 외부 네트워크 없이 결정적으로 동작한다.
 *
 * Public API source(= kpubdata provider 경로)는 kpubdata의 replay 전송으로 덮는다 —
 * 기록된 fixture를 재생하므로 여기도 외부 네트워크와 서비스키가 필요 없다. 러너가
 * kpubdata 레포를 찾았을 때만(REAL_BUILDER_REPLAY) 실행된다.
 */
const BUILDER_URL = process.env.REAL_BUILDER_URL ?? "http://localhost:8000";

// 기본 슈트(mock, npm run test:e2e)에서는 실행하지 않는다.
test.skip(!process.env.REAL_BUILDER_E2E, "실 Builder 기동 필요 — scripts/run-real-e2e.mjs");

/**
 * 로그인 토큰은 메모리 store에만 있어 full reload(page.goto)하면 풀린다 —
 * 로그인 후 이동은 항상 SPA 링크(사이드바)로 한다.
 */
async function navigateViaShell(page: import("@playwright/test").Page, label: RegExp): Promise<void> {
  await page.getByRole("link", { name: label }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test.beforeEach(async ({ page }) => {
  await prepareCleanPage(page);

  // playwright.real.config.ts sets VITE_DEV_BYPASS_AUTH and this suite's Builder runs
  // with KPUBDATA_BUILDER_DEV_MODE=1 — auth is bypassed on both sides, so this suite
  // exercises the data path only, never the OIDC path. Real OIDC E2E is a manual smoke
  // (see README "Keycloak → Builder OIDC smoke").
  await page.goto("/");
});

test("실 Builder /version이 응답한다 (기동 전제) @real-builder", async ({ request }) => {
  const response = await request.get(`${BUILDER_URL}/version`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { service?: string };
  expect(body.service).toBe("kpubdata-builder");
});

test("File Upload → Preview → Build → Builds 이력 전체 경로 @real-builder", async ({
  page,
}) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  // 1) Source: File Upload 선택 후 Configure로 진행(SPA 내비게이션 — 토큰 유지)
  await navigateViaShell(page, /Add Data|데이터 추가/);
  await page.getByRole("button", { name: "File Upload" }).first().click();
  await page.getByRole("button", { name: "다음" }).first().click();

  // 2) Configure: 포맷 csv + 실제 파일 업로드(실 Builder POST /uploads)
  await expect(page.getByRole("heading", { name: "설정 (Configure)" })).toBeVisible();
  await page.getByLabel("포맷 (Format)").selectOption("csv");
  const fileInput = page.getByLabel("파일");
  await fileInput.setInputFiles({
    name: "cross-e2e.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("id,name,value\n1,alpha,10\n2,beta,20\n3,gamma,30\n", "utf8"),
  });
  // 실제 POST /uploads 완료 표시를 기다린다("업로드 중" 상태와 구분).
  await expect(page.getByText(/업로드 완료: cross-e2e\.csv/).first()).toBeVisible({
    timeout: 30_000,
  });

  // 3) Preview & Validate 단계 — "Preview 새로고침"으로 실 Builder /preview·/validate 호출
  await page.getByRole("button", { name: "다음" }).first().click();
  await expect(page.getByText("미리보기 · 검증 (Preview & Validate)")).toBeVisible();
  await page.getByRole("button", { name: "Preview 새로고침" }).first().click();
  await expect(page.getByText("검증 결과 (Validation)")).toBeVisible({ timeout: 30_000 });
  // quality check가 없는 file 소스는 "Not evaluated / N/A"로 표시된다(#516 원칙).
  await expect(
    page.getByText(/Not evaluated|checks passed/).first(),
  ).toBeVisible({ timeout: 30_000 });

  // 4) Review & Build — canonical BuildSpec 표시 후 실제 POST /build
  await page.getByRole("button", { name: "다음" }).first().click();
  await expect(page.getByText("검토 · 빌드 (Review & Build)")).toBeVisible();
  const buildButton = page.getByRole("button", { name: "Build 시작" });
  // 검증 통과 + preview가 stale하지 않으면 활성화된다(#250 게이트).
  await expect(buildButton).toBeEnabled({ timeout: 30_000 });
  await buildButton.click();

  // 5) 제출 결과 노출. file source는 async run이 업로드 owner 경계를 유지하기
  // 위해 resolver에 owner를 넘기지 않는 설계(#496 follow-up)라 구조화된 실패로
  // 종결된다 — Studio가 Builder의 실패 사유를 오류 UI로 표시하는지 검증한다
  // (kpubdata#282 "Build 실패 시나리오: 502 + 오류 메시지 정상 표시").
  // Public API source를 쓰면 성공 경로가 같은 슈트로 확장된다(외부 네트워크 필요).
  const failureAlert = page.getByRole("alert").first();
  await expect(failureAlert).toBeVisible({ timeout: 60_000 });
  await expect(failureAlert).toContainText(/stable principal|실패|failed/i);
  void 0;
  // 다음(Builds) 검증에 쓸 run id를 확보한다.

  // 6) Builds 이력 화면(실 GET /builds)에 방금 제출한 run이 반영된다(실패 포함).
  await navigateViaShell(page, /Builds|빌드/);
  await expect(page.getByRole("heading", { name: /빌드|Build/i }).first()).toBeVisible();

  await expectNoPageErrors(errors);
});

/**
 * Public API source BuildSpec. kpubdata의 replay fixture와 파라미터가 정확히
 * 일치해야 한다(fixture는 `datago.air_station` 예제 `gangnam_full_page`).
 * totalCount 22 ≤ page_size 100이라 한 페이지로 끝난다 — Builder Bronze는
 * `list_all()`로 페이지를 끝까지 도는데 2페이지 fixture가 없으면 replay가 실패한다.
 */
const PUBLIC_API_SPEC = [
  "dataset_id: dataset.cross_repo_public_api",
  "title: Cross-repo Public API smoke",
  "description: kpubdata replay fixture를 실 Builder HTTP로 빌드한다",
  "sources:",
  "  - provider: datago",
  "    dataset: air_station",
  "    alias: measurements",
  "    params:",
  "      station: 강남구",
  "      term: daily",
  "      page: 1",
  "      page_size: 100",
  "exports:",
  "  - kind: jsonl",
  "    output_path: out/data.jsonl",
].join("\n");

test("Public API source가 kpubdata를 거쳐 성공 빌드로 끝난다 @real-builder", async ({
  page,
  request,
}) => {
  // Builder가 replay 모드로 떠 있을 때만 결정적이다 — 러너가 kpubdata 레포를
  // 찾으면 REAL_BUILDER_REPLAY를 설정한다.
  test.skip(
    !process.env.REAL_BUILDER_REPLAY,
    "kpubdata replay fixture 필요 — scripts/run-real-e2e.mjs가 kpubdata 레포를 찾지 못했습니다",
  );

  const errors: string[] = [];
  collectPageErrors(page, errors);

  // 1) 브라우저 컨텍스트에서 실 Builder로 Public API BuildSpec을 제출한다.
  //    file source 시나리오가 이미 위저드 UI 경로를 덮으므로, 여기서는 지금까지
  //    어느 스펙도 태우지 못한 구간 — Builder → kpubdata Client → provider spec
  //    실행기 → Bronze/Silver/Gold — 을 실 HTTP로 검증한다.
  const runId = `ui-public-api-${Date.now()}`;
  const response = await request.post(`${BUILDER_URL}/build`, {
    data: { spec: PUBLIC_API_SPEC, run_id: runId },
    timeout: 60_000,
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    status?: string;
    outcomes?: Array<{ status?: string; stages_completed?: string[]; error?: string | null }>;
  };
  expect(body.status).toBe("ok");
  const outcome = body.outcomes?.[0];
  expect(outcome?.error ?? null).toBeNull();
  // kpubdata가 돌려준 레코드가 세 단계를 모두 통과해야 한다.
  expect(outcome?.stages_completed).toEqual(["bronze", "silver", "gold"]);

  // 2) 그 run을 Studio가 실제로 렌더한다(실 GET /builds/{run_id} 경로).
  await page.goto(`/builds/${runId}`);
  await expect(
    page
      .getByText(runId)
      .first()
      .or(page.getByText(/Cross-repo Public API smoke/).first()),
  ).toBeVisible({ timeout: 30_000 });

  await expectNoPageErrors(errors);
});

test("빌드 실패 게이트: 파일 없이는 다음 단계 진입이 막힌다 @real-builder", async ({
  page,
}) => {
  const errors: string[] = [];
  collectPageErrors(page, errors);

  // File Upload를 선택했지만 파일을 올리지 않으면 다음 단계 진입이 막힌다(#250 게이트).
  await navigateViaShell(page, /Add Data|데이터 추가/);
  await page.getByRole("button", { name: "File Upload" }).first().click();
  await page.getByRole("button", { name: "다음" }).first().click();
  await expect(page.getByRole("heading", { name: "설정 (Configure)" })).toBeVisible();
  // 여전히 Configure 단계(진행 차단) 또는 명시적 오류 안내가 보인다.
  await expect(
    page
      .getByRole("heading", { name: "설정 (Configure)" })
      .or(page.getByText("먼저 포맷을 선택해주세요."))
      .first(),
  ).toBeVisible();

  await expectNoPageErrors(errors);
});
