# 변경 이력

## v0.4 (Unreleased)

### 추가됨
- **인증 S1-S10**: apiFetch 인증 주입(#186), Google GIS 로그인(#187), 토큰 보관(#188), 만료 처리(#189), 로그인 게이트(#190), Settings 상태(#191), 계약 동기화(#192), 에러 메시지(#193), 오리진 정합(#194), 테스트(#195)
- **BuildSpec 어시스턴트 ST-A1-A10**: AssistProvider + BYOK(#205), 시크릿 스크러빙(#206), 채팅 UI(#207), validate 설명(#208), 카탈로그 조회(#209), 생성+리페어(#210), mock 모드(#211), 테스트(#212), 프라이버시 고지(#213)
- **MSW E2E 테스트 하네스** (#160, #104)
- **zod 스키마 런타임 검증** (#158, #103)
- **API_CONTRACT_VERSION 1.2.0 동기화**
- **계약 적합성 테스트** (contractConformance.test.ts)
- **SpecDiff 컴포넌트**

### 변경됨
- **라우트 코드 분할 (#378)**: `router.tsx` 가 페이지 23개를 모두 정적 import 해서 첫 화면 하나를 열 때 Monitoring·Reports·Kubi 까지 전부 내려받았다(단일 청크 1.23 MB / gzip 359 kB). 각 페이지를 `React.lazy` + 동적 import 로 바꾸고 `withFeatureBoundary` 안쪽에 `Suspense` 를 두어 라우트를 청크 경계로 삼는다 — 청크 로드 실패도 해당 feature 폴백으로 잡혀 셸이 빈 화면이 되지 않는다. 결과: 49개 청크, 진입 청크 424 kB / gzip 132 kB (gzip 기준 63% 감소), Vite 의 500 kB 경고 해소
- **Add Data 3단계 i18n 전환 (#350)**: `ConfigureStep`·`PreviewValidationStep`·`ReviewBuildStep` 의 하드코딩 한글 UI 문자열을 전부 키로 옮겼다(`addData.configure`/`addData.preview`/`addData.review`, ko/en 각 89키 신규). 전환 중 발견한 **모듈 상수 i18n 결함 2건**도 함께 고쳤다 — `CREDENTIAL_PREREQUISITE_MESSAGE` 와 `PREVIEW_SOURCE_STATE_LABEL` 은 모듈 최상위에서 평가돼 import 시점 언어에 문구가 굳어 있었고, 각각 `credentialPrerequisiteMessage()` / `previewSourceStateLabel()` 로 바꿔 렌더 시점에 해석한다
- **느린 폴링 테스트를 가짜 타이머로 압축 (#376)**: `asyncBuildJob.test.ts` 는 terminal 까지 `POLL_INTERVAL_MS`(800ms) 를 케이스마다 실제로 기다렸고(16.9s), `kubiSession.test.tsx` 는 real 모드 evidence 조회가 스텁보다 먼저 일어나 builderApi 의 지수 백오프(500ms+1000ms)를 요청마다 통째로 기다렸다(15.3s). 전자는 `vi.advanceTimersByTimeAsync` 로 대기만 건너뛰고(`waitFor` 는 vitest 가짜 타이머를 인식하지 못해 `settle()` 헬퍼로 대체), 후자는 스텁을 먼저 깔아 결정적으로 만들었다 — 두 파일 16.9s+15.3s → 0.11s+1.66s, 전체 스위트 112.5s → 79.4s
- **커버리지 게이트 (#380)**: `vitest.config.ts` 의 `coverage.thresholds` 로 현재 수준을 회귀 방지선으로 고정한다(statements 84 / branches 75 / functions 85 / lines 86 — 실측 86.54/77.12/87.93/88.65 에서 각 2%p 아래). 계측 대상은 `src/` 애플리케이션 코드만이고 진입점·타입 선언·테스트 파일은 제외한다. `npm run test:coverage` 와 CI 의 전용 `coverage` 잡이 게이트를 담당한다 — Node 20/22 로 두 번 도는 quality 잡에 계측을 얹지 않아 비용은 1배다
- **패키지 메타데이터/툴체인 경고 정리 (#375)**: `package.json` 의 `version` 을 `0.1.0` → `0.4.0` 으로 올려 이 문서의 v0.4 절과 맞추고, `"type": "module"` 을 추가해 Vite 의 `configLoader: 'native'` 경고를 없앤다. `vite.config.ts`/`vitest.config.ts` 의 `path.resolve(__dirname, …)`(CJS 전역)은 `fileURLToPath(new URL("./src", import.meta.url))` 로 바꿔 ESM 그대로 동작하게 했다. 상시로 떠 있던 eslint 경고 2건(`e2e/helpers.ts` 미사용 `test` import, `HomePage.tsx` 미사용 `t`)도 제거 — 경고가 0이어야 새 경고가 묻히지 않는다
- **Home 워크플로 STEP 라벨이 언어 전환을 따라감 (#375)**: `WORKFLOW_STEPS` 가 모듈 최상위에서 `i18n.t()` 로 평가돼 import 시점 언어에 고정돼 있었다. 번호만 상수로 남기고 라벨은 렌더 시점에 해석한다
- API_CONTRACT.md drift 표 갱신 — 모든 오퍼레이션 정합 (#219)
- WORK_PLAN.md를 .github/로 이동 (#222)

## v0.3

빌드 화면 실장, 검증/미리보기.

- Build Detail 화면 (manifest 요약, 파일 목록)
- Build Edit 마법사 (Stepper, React Hook Form)
- Build Run 페이지
- Build Publish 페이지
- Artifacts 뷰어
- 빌드 목록 페이지
- Spec 매핑 계층 (camelCase → snake_case)

## v0.2

아티팩트, 미리보기.

- 아티팩트 미리보기
- 데이터셋 검증 화면
- 검증 결과 표시
- 빌드 결과물 뷰어

## v0.1

초기 구조.

- Vite + React SPA 셸
- React Router 주요 경로
- feature-based 폴더 구조
- Builder API 클라이언트 (apiFetch, ApiError, 재시도)
- Vitest 테스트 환경
- 주요 페이지 골격 (Home, Builds, NewBuild)
- 도메인 타입 정의
