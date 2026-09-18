/**
 * React Router 기반 Studio 라우트 트리를 정의하는 파일.
 *
 * 공통 `Layout` 아래에 홈, 빌드 초안, 검증, 미리보기, 설정 같은 작업실 화면을 배치한다.
 */
import { lazy, Suspense, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { createBrowserRouter } from "react-router-dom";
import { FeatureErrorBoundary, RouteErrorBoundary } from "@/app/ErrorBoundary";
import { Layout } from "@/app/Layout";
import { LoginGate } from "@/features/auth/LoginGate";
import { Skeleton } from "@/shared/ui";

/**
 * 라우트 단위 코드 분할 (#378).
 *
 * 모든 페이지를 정적으로 import 하면 첫 화면 하나를 열려고 Monitoring·Reports·Kubi까지
 * 전부 내려받게 된다(단일 청크 1.14 MB). 각 페이지를 동적 import로 바꿔 라우트를 청크
 * 경계로 삼는다.
 *
 * 페이지는 named export라 `lazy`가 요구하는 default 형태로 감싼다.
 */
const AddDataPage = lazy(() =>
  import("@/pages/AddDataPage").then((m) => ({ default: m.AddDataPage })),
);
const ArtifactsPage = lazy(() =>
  import("@/pages/ArtifactsPage").then((m) => ({ default: m.ArtifactsPage })),
);
const BuildArtifactsPage = lazy(() =>
  import("@/pages/BuildArtifactsPage").then((m) => ({ default: m.BuildArtifactsPage })),
);
const BuildPublishPage = lazy(() =>
  import("@/pages/BuildPublishPage").then((m) => ({ default: m.BuildPublishPage })),
);
const BuildRunPage = lazy(() =>
  import("@/pages/BuildRunPage").then((m) => ({ default: m.BuildRunPage })),
);
const BuildsPage = lazy(() =>
  import("@/pages/BuildsPage").then((m) => ({ default: m.BuildsPage })),
);
const DatasetCatalogPage = lazy(() =>
  import("@/pages/DatasetCatalogPage").then((m) => ({ default: m.DatasetCatalogPage })),
);
const DatasetDetailPage = lazy(() =>
  import("@/pages/DatasetDetailPage").then((m) => ({ default: m.DatasetDetailPage })),
);
const DiscoverPage = lazy(() =>
  import("@/pages/DiscoverPage").then((m) => ({ default: m.DiscoverPage })),
);
const HomePage = lazy(() =>
  import("@/pages/HomePage").then((m) => ({ default: m.HomePage })),
);
const KubiPage = lazy(() =>
  import("@/pages/KubiPage").then((m) => ({ default: m.KubiPage })),
);
const LoginPage = lazy(() =>
  import("@/pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const MonitoringPage = lazy(() =>
  import("@/pages/MonitoringPage").then((m) => ({ default: m.MonitoringPage })),
);
const NewBuildPage = lazy(() =>
  import("@/pages/NewBuildPage").then((m) => ({ default: m.NewBuildPage })),
);
const PreviewPage = lazy(() =>
  import("@/pages/PreviewPage").then((m) => ({ default: m.PreviewPage })),
);
const ProviderPage = lazy(() =>
  import("@/pages/ProviderPage").then((m) => ({ default: m.ProviderPage })),
);
const QualityPage = lazy(() =>
  import("@/pages/QualityPage").then((m) => ({ default: m.QualityPage })),
);
const ReportEditorPage = lazy(() =>
  import("@/pages/ReportEditorPage").then((m) => ({ default: m.ReportEditorPage })),
);
const ReportsPage = lazy(() =>
  import("@/pages/ReportsPage").then((m) => ({ default: m.ReportsPage })),
);
const SettingsPage = lazy(() =>
  import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const SignupPage = lazy(() =>
  import("@/pages/SignupPage").then((m) => ({ default: m.SignupPage })),
);
const ValidatePage = lazy(() =>
  import("@/pages/ValidatePage").then((m) => ({ default: m.ValidatePage })),
);
const WorkspacePage = lazy(() =>
  import("@/pages/WorkspacePage").then((m) => ({ default: m.WorkspacePage })),
);

/**
 * 페이지 청크를 받아오는 동안 보여줄 자리표시자.
 *
 * Skeleton 자체는 aria-hidden이므로, 보조기기에는 `role="status"`의 안내 문구로
 * "로딩 중"을 알린다 — 화면에는 빈 영역만 보이고 스크린리더에는 아무 말도 없는 상태를
 * 만들지 않기 위해서다.
 */
function PageFallback() {
  const { t } = useTranslation();
  return (
    <main
      role="status"
      aria-busy="true"
      className="flex flex-1 flex-col gap-4 px-5 py-8 sm:px-8 lg:px-10 lg:py-10"
    >
      <span className="sr-only">{t("router.loading")}</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-64 w-full" />
    </main>
  );
}

/** 페이지 요소를 Suspense 경계로 감싼다 — 청크가 도착할 때까지 폴백을 보여준다. */
function withSuspense(element: ReactElement): ReactElement {
  return <Suspense fallback={<PageFallback />}>{element}</Suspense>;
}

/**
 * 페이지 요소를 feature 단위 ErrorBoundary로 감싼다 (#97).
 *
 * 한 feature의 렌더 오류가 전역 폴백까지 버블업해 앱 전체(셸 포함)를 빈 화면으로 만들지 않도록,
 * 각 라우트 요소를 해당 영역만 폴백하는 경계로 감싼다. Layout의 `<Outlet />` 안쪽에서 동작하므로
 * 사이드바/헤더는 유지된다.
 *
 * @param feature - 폴백에 노출할 기능 이름.
 * @param element - 보호할 페이지 요소.
 * @returns 경계로 감싼 요소.
 */
/** `feature`는 화면 이름이 아니라 i18n 키다(#350) — 폴백에서 현재 언어로 해석한다. */
function withFeatureBoundary(feature: string, element: ReactElement): ReactElement {
  // Suspense를 경계 *안쪽*에 둔다 — 청크 로드 실패(네트워크 끊김 등)도 해당 feature의
  // 폴백으로 잡히고, 셸 전체가 빈 화면이 되지 않는다.
  return <FeatureErrorBoundary feature={feature}>{withSuspense(element)}</FeatureErrorBoundary>;
}

/**
 * 브라우저 URL과 Studio 페이지 컴포넌트를 연결하는 전역 라우터.
 *
 * @returns 각 경로별 렌더링 규칙을 담은 브라우저 라우터 인스턴스.
 */
export const router = createBrowserRouter([
    // Login/Signup(#263)은 App Shell(사이드바/헤더) 밖의 독립 화면이라 Layout의 children이
    // 아니라 최상위 형제 라우트로 둔다 — 로그인 전 상태에는 아직 보여줄 워크스페이스 셸이 없다.
    {
      path: "/login",
      element: withSuspense(<LoginPage />),
    },
    {
      path: "/signup",
      element: withSuspense(<SignupPage />),
    },
    {
      path: "/",
      element: <LoginGate><Layout /></LoginGate>,
      errorElement: <RouteErrorBoundary />,
      children: [
      {
        index: true,
        element: withFeatureBoundary("router.features.home", <HomePage />),
      },
      // 새 IA(#247)의 WORKSPACE 그룹. Discover는 #249에서 구현됨. Workspace는 아직
      // placeholder이며 #260에서 실제 화면으로 교체된다.
      {
        path: "discover",
        element: withFeatureBoundary("router.features.Discover", <DiscoverPage />),
      },
      {
        path: "workspace",
        element: withFeatureBoundary("router.features.Workspace", <WorkspacePage />),
      },
      // 새 IA의 DATA 그룹. Add Data/Dataset Catalog/Quality는 #250/#253/#254에서 구현된다.
      {
        path: "add",
        element: withFeatureBoundary("router.features.AddData", <AddDataPage />),
      },
      {
        path: "datasets",
        element: withFeatureBoundary("router.features.DatasetCatalog", <DatasetCatalogPage />),
      },
      {
        path: "datasets/:datasetId",
        element: withFeatureBoundary("router.features.datasetDetail", <DatasetDetailPage />),
      },
      {
        path: "builds",
        element: withFeatureBoundary("router.features.builds", <BuildsPage />),
      },
      {
        path: "builds/new",
        element: withFeatureBoundary("router.features.newBuild", <NewBuildPage />),
      },
      {
        path: "quality",
        element: withFeatureBoundary("router.features.Quality", <QualityPage />),
      },
      // Build 단위 중심 라우트 (제안 §3.3): 상세 → 편집/실행/결과물/게시.
      // 레거시 딥링크(#255 §5): /builds/:buildId도 동일한 master-detail(BuildsPage)을
      // 열어 canonical form(/builds?run=)과 같은 context를 보여준다.
      {
        path: "builds/:buildId",
        element: withFeatureBoundary("router.features.buildDetail", <BuildsPage />),
      },
      {
        // 편집은 New Build와 동일한 에디터를 재사용한다.
        path: "builds/:buildId/edit",
        element: withFeatureBoundary("router.features.buildEdit", <NewBuildPage />),
      },
      {
        path: "builds/:buildId/run",
        element: withFeatureBoundary("router.features.buildRun", <BuildRunPage />),
      },
      {
        path: "builds/:buildId/artifacts",
        element: withFeatureBoundary("router.features.artifacts", <BuildArtifactsPage />),
      },
      {
        path: "builds/:buildId/publish",
        element: withFeatureBoundary("router.features.publish", <BuildPublishPage />),
      },
      // 새 IA의 AI 그룹(#256에서 실제 기능 구현). 전역 Kubi drawer는
      // `src/features/kubi/KubiDrawer.tsx`로 Layout 수준에서 별도 mount된다.
      {
        path: "kubi",
        element: withFeatureBoundary("router.features.Kubi", <KubiPage />),
      },
      {
        path: "reports",
        element: withFeatureBoundary("router.features.Reports", <ReportsPage />),
      },
      {
        path: "reports/:reportId",
        element: withFeatureBoundary("router.features.reportEditor", <ReportEditorPage />),
      },
      // 새 IA의 SYSTEM 그룹(#259/#264에서 실제 기능 구현).
      {
        path: "provider",
        element: withFeatureBoundary("router.features.Provider", <ProviderPage />),
      },
      {
        path: "monitoring",
        element: withFeatureBoundary("router.features.Monitoring", <MonitoringPage />),
      },
      // 레거시 단독 라우트: 내비게이션에서는 제거됐지만 딥링크 호환을 위해 유지한다(#247 결정:
      // 새 IA로 리다이렉트하지 않고 그대로 유지 — Validate/Preview/Artifacts는 New Build
      // Wizard 내부 패널로 통합 예정이며, 통합 시점까지는 기존 화면이 fallback 역할을 한다).
      {
        path: "validate",
        element: withFeatureBoundary("router.features.validate", <ValidatePage />),
      },
      {
        path: "preview",
        element: withFeatureBoundary("router.features.preview", <PreviewPage />),
      },
      {
        path: "artifacts",
        element: withFeatureBoundary("router.features.artifacts", <ArtifactsPage />),
      },
      {
        path: "settings",
        element: withFeatureBoundary("router.features.settings", <SettingsPage />),
      },
    ],
  },
  ],
  {
    // GitHub Pages 하위 경로(/kpubdata-studio/)에서도 라우팅이 동작하도록 base를 basename으로 사용한다.
    basename: import.meta.env.BASE_URL.replace(/\/+$/, "") || "/",
  },
);
