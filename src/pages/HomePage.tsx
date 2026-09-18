/**
 * Studio 홈 대시보드 화면 - 신규 사용자/기존 사용자 상태 분기.
 *
 * Issue #248: Home을 신규 사용자·기존 사용자 상태로 구현한다.
 *
 * 신규 사용자 여부는 dataset/build 존재 여부로 판단한다.
 * - 신규 사용자: 환영 메시지, Kubi 자연어 hero(topbar KubiSearchInput과 동일한 seed 흐름 재사용),
 *   공공데이터 탐색, 데이터 바로 가져오기
 * - 기존 사용자: 실제 KPI (DATASETS, BUILD SUCCESS, VALIDATION WARN, RUNNING), 최근 데이터셋, 최근 Build stage 요약, 품질 경고/실패 Build
 *
 * Phase2 UI polish: "예시 데이터셋을 곧 만나보실 수 있습니다" placeholder 섹션은 제거했다 —
 * 실제 예시 데이터셋이 없는 상태에서 서비스가 미완성인 인상을 줬다. 같은 CTA는 이미
 * "공공데이터 탐색 → /discover" 카드가 담당한다.
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAssistConfig } from "@/features/assistant/config";
import { listBuilds } from "@/features/runs/api";
import { getSuggestedQuestions } from "@/features/kubi/suggestedQuestions";
import { useKubiStore } from "@/features/kubi/useKubiSession";
import { FirstRunTour, resetFirstRunTour } from "@/features/onboarding/FirstRunTour";
import { useAuthStore } from "@/features/auth/store";
import { builderApi, isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type { BuildQualityResponse, QualityCheckResult } from "@/shared/lib/builderApi.schema";
import type { BuildListItem } from "@/shared/lib/types";
import {
  Button,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Skeleton,
  HelpTooltip,
} from "@/shared/ui";

interface DashboardStats {
  datasetCount: number | null;
  buildSuccess: number | null;
  qualityWarn: number | null;
  running: number | null;
}

/**
 * 각 KPI aggregate는 독립적인 API 경계다 — 하나가 실패해도 나머지 KPI 값과
 * Recent Builds는 영향받지 않는다. "loading"은 skeleton, "unavailable"은
 * "확인 불가"(임의 숫자 합성 없음)로 렌더된다.
 */
type KpiPhase = "loading" | "ready" | "unavailable";

interface KpiPhases {
  /** DATASETS — GET /datasets의 authoritative `total` (Builder 1.22.0). */
  datasets: KpiPhase;
  /** SUCCEEDED (24H) + RUNNING — GET /monitoring/* 공유 경계. */
  monitoring: KpiPhase;
  /** QUALITY WARN (24H) — GET /quality/summary (Builder 1.22.0). */
  quality: KpiPhase;
}

/**
 * DATASETS KPI + 신규 사용자 판정을 위한 authoritative dataset total만 독립적으로
 * 조회한다 — monitoring/quality 경계는 건드리지 않는다.
 *
 * 1.21.0 이하 Builder는 `total`을 보내지 않으므로 그때는 items.length/limit로
 * 대체하지 않고 "확인 불가"(kpi.datasets="unavailable", datasetCount=null)로 둔다.
 * 호출부는 이 상태를 "dataset 없음"으로 오해하지 않는다.
 */
function loadDatasetTotal(
  isActive: () => boolean,
  setStats: Dispatch<SetStateAction<DashboardStats>>,
  setKpi: Dispatch<SetStateAction<KpiPhases>>,
): void {
  builderApi
    .listDatasets(1)
    .then((res) => {
      if (!isActive()) return;
      setStats((prev) => ({ ...prev, datasetCount: res.total ?? null }));
      setKpi((prev) => ({ ...prev, datasets: res.total === undefined ? "unavailable" : "ready" }));
    })
    .catch(() => {
      if (!isActive()) return;
      setStats((prev) => ({ ...prev, datasetCount: null }));
      setKpi((prev) => ({ ...prev, datasets: "unavailable" }));
    });
}

/**
 * 실연동 모드에서 Home KPI 3개 경계를 각각 독립적으로 로드한다.
 *
 * 세 요청은 서로를, 그리고 이미 커밋된 Recent Builds를 절대 block하지 않는다.
 * 한 aggregate가 실패/미지원이면 해당 KPI만 "확인 불가"가 되고 값을 지어내지 않는다.
 */
function loadRealKpis(
  isActive: () => boolean,
  setStats: Dispatch<SetStateAction<DashboardStats>>,
  setKpi: Dispatch<SetStateAction<KpiPhases>>,
): void {
  // (1) DATASETS — dataset total.
  loadDatasetTotal(isActive, setStats, setKpi);

  // (2) SUCCEEDED (24H) + RUNNING — monitoring. 각 endpoint 실패는 그 값만 null로.
  void Promise.all([
    builderApi.getMonitoringBuilds().catch(() => null),
    builderApi.getMonitoringSummary().catch(() => null),
  ]).then(([monitoring, summary]) => {
    if (!isActive()) return;
    const monitoredSuccess =
      monitoring?.availability === "available"
        ? monitoring.buckets.reduce((sum, bucket) => sum + bucket.success, 0)
        : null;
    setStats((prev) => ({
      ...prev,
      buildSuccess: monitoredSuccess,
      // GET /builds의 real 계약은 terminal summary만 제공하므로 active 수로 해석하지 않는다.
      running: summary?.queue.running ?? null,
    }));
    setKpi((prev) => ({ ...prev, monitoring: "ready" }));
  });

  // (3) QUALITY WARN (24H) — quality summary. 미지원(1.21.0 이하 → 404)/실패면 "확인 불가".
  builderApi
    .getQualitySummary()
    .then((res) => {
      if (!isActive()) return;
      setStats((prev) => ({
        ...prev,
        qualityWarn: res.availability === "available" ? res.warn_runs : null,
      }));
      setKpi((prev) => ({ ...prev, quality: "ready" }));
    })
    .catch(() => {
      if (!isActive()) return;
      setStats((prev) => ({ ...prev, qualityWarn: null }));
      setKpi((prev) => ({ ...prev, quality: "unavailable" }));
    });
}

/**
 * 신규 사용자 여부를 판단한다.
 *
 * 신규 사용자는 "빌드도 dataset도 없음"이 실제로 확인됐을 때만 확정한다. 빈 build
 * 목록만으로는 부족하다 — dataset은 있는데 아직 build를 돌리지 않은 사용자를 신규로
 * 오판할 수 있기 때문이다. real 모드에서는 Builder GET /datasets의 authoritative
 * `total`(1.22.0)을 함께 확인하고, total이 unavailable(구버전 Builder / 404·5xx)이면
 * 신규로 추측하지 않고 기존 대시보드를 보여준다(DATASETS만 "확인 불가").
 */
export function HomePage() {
  const realBuilder = isRealBuilderEnabled();
  const userId = useAuthStore((state) => state.userId);
  const [builds, setBuilds] = useState<BuildListItem[]>([]);
  const [buildsState, setBuildsState] = useState<"loading" | "error" | "success">("loading");
  const [stats, setStats] = useState<DashboardStats>({
    datasetCount: null,
    buildSuccess: null,
    qualityWarn: null,
    running: null,
  });
  const [kpi, setKpi] = useState<KpiPhases>({
    datasets: "loading",
    monitoring: "loading",
    quality: "loading",
  });
  const [recentQuality, setRecentQuality] = useState<RecentQualityState>({
    phase: "loading",
    alerts: [],
  });

  useEffect(() => {
    let active = true;

    // real Builder의 aggregate는 Recent Builds와 독립적인 API 경계다. /builds의
    // 성공 여부나 빈 목록 여부와 무관하게 즉시 시작한다.
    if (realBuilder) {
      loadRealKpis(() => active, setStats, setKpi);
    }

    // Recent Builds는 KPI 요청과 완전히 독립이다 — 받는 즉시 커밋하고, 실패하면
    // KPI와 무관하게 그 섹션만 에러 상태로 둔다.
    listBuilds()
      .then((list) => {
        if (!active) return;
        setBuilds(list);
        setBuildsState("success");

        // real 모드 aggregate는 effect 시작 시 이미 독립적으로 요청했다. 빈 build는
        // 신규 사용자 판정의 한 근거일 뿐, monitoring/quality를 unavailable로 만들지 않는다.
        if (list.length === 0) {
          if (!realBuilder) {
            setKpi({ datasets: "unavailable", monitoring: "unavailable", quality: "unavailable" });
          }
          return;
        }

        if (realBuilder) {
          return;
        }

        // mock/demo: 기존 demo 의미 유지 — mock 목록에서 직접 계산한다. 여기는
        // 애초에 mock 모드이므로 real 실패를 mock 숫자로 대체하는 경로가 아니다.
        const succeeded = list.filter((b) => b.status === "succeeded").length;
        const running = list.filter(
          (b) => b.status === "running" || b.status === "queued",
        ).length;
        setStats({ datasetCount: null, buildSuccess: succeeded, qualityWarn: null, running });
        setKpi({ datasets: "unavailable", monitoring: "ready", quality: "unavailable" });
      })
      .catch(() => {
        if (!active) return;
        setBuildsState("error");
        // real aggregate는 /builds 오류와 독립적으로 계속 진행한다. mock/demo의
        // 기존 동작만 유지해, 근거 없는 KPI를 표시하지 않는다.
        if (!realBuilder) {
          setKpi({ datasets: "unavailable", monitoring: "unavailable", quality: "unavailable" });
        }
      });

    return () => {
      active = false;
    };
  }, [realBuilder]);

  const recentBuilds = useMemo(
    () =>
      [...builds]
        .sort((a, b) => {
          const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
          const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
          return bTime - aTime;
        })
        .slice(0, 5),
    [builds],
  );

  useEffect(() => {
    const controller = new AbortController();
    if (buildsState === "loading") {
      setRecentQuality({ phase: "loading", alerts: [] });
      return () => controller.abort();
    }
    if (!realBuilder || buildsState === "error" || recentBuilds.length === 0) {
      setRecentQuality({ phase: "unavailable", alerts: [] });
      return () => controller.abort();
    }

    // Quality 결과는 manifest에서 조회한다(GET /builds/{run_id}/quality). manifest가 있는
    // 것은 성공적으로 완료된 Run뿐이므로, queued/running/취소된 Run에 getBuildQuality를
    // 호출하면 항상 404다 — canonical 대상인 succeeded Run만 조회한다.
    const qualityRuns = recentBuilds.filter((run) => run.status === "succeeded");
    if (qualityRuns.length === 0) {
      setRecentQuality({ phase: "ready", alerts: [], incomplete: false });
      return () => controller.abort();
    }

    setRecentQuality({ phase: "loading", alerts: [] });
    void Promise.allSettled(
      qualityRuns.map((run) => builderApi.getBuildQuality(run.id, controller.signal)),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const alerts: QualityAlert[] = [];
      let incomplete = false;
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          incomplete = true;
          return;
        }
        if (result.value.availability !== "available") incomplete = true;
        alerts.push(...qualityAlertsForRun(qualityRuns[index], result.value));
      });
      setRecentQuality({ phase: "ready", alerts: alerts.slice(0, 5), incomplete });
    });

    return () => controller.abort();
  }, [buildsState, realBuilder, recentBuilds]);

  // real 모드: 빌드 0개 + dataset total 조회 성공(kpi.datasets="ready") + total===0
  // 이 모두 충족될 때만 신규 사용자로 확정한다. total이 unavailable이면 빈 build만으로
  // 추측하지 않는다. mock/demo 모드에는 dataset aggregate 권위가 없으므로 기존
  // build 기반 판정을 그대로 유지한다.
  const datasetsConfirmedEmpty = kpi.datasets === "ready" && stats.datasetCount === 0;
  const isNew =
    buildsState === "success" &&
    builds.length === 0 &&
    (realBuilder ? datasetsConfirmedEmpty : true);

  return (
    <main className="flex flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      {isNew ? (
        <EmptyWorkspaceHome userId={userId} />
      ) : (
        <ExistingUserHome
          userId={userId}
          stats={stats}
          recentBuilds={recentBuilds}
          buildsState={buildsState}
          kpi={kpi}
          recentQuality={recentQuality}
        />
      )}
    </main>
  );
}

function EmptyWorkspaceHome({ userId }: { userId: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader
        eyebrow={t("home.hero.eyebrow")}
        title={t("home.hero.title")}
        description={t("home.hero.desc")}
        actions={<Button variant="ghost" size="sm" onClick={resetFirstRunTour}>{t("home.hero.tour")}</Button>}
      />

      <WorkflowStrip />

      <section data-tour="start-actions" className="grid gap-6 lg:grid-cols-2">
        <Card variant="elevated" className="flex flex-col items-center justify-center p-10 text-center">
          <h2 className="text-xl font-semibold tracking-tight">{t("home.explore.title")}</h2>
          <p className="mt-3 text-muted-foreground">
            {t("home.explore.desc")}
          </p>
          <LinkButton className="mt-6" variant="secondary" to="/discover">
            {t("home.explore.cta")}
          </LinkButton>
        </Card>

        <Card variant="elevated" className="flex flex-col items-center justify-center p-10 text-center">
          <h2 className="text-xl font-semibold tracking-tight">{t("home.addData.title")}</h2>
          <p className="mt-3 text-muted-foreground">
            {t("home.addData.desc")}
          </p>
          <LinkButton className="mt-6" variant="secondary" to="/add">
            {t("home.addData.cta")}
          </LinkButton>
        </Card>
      </section>
      <div data-tour="kubi-helper"><KubiHero /></div>
      {userId ? <FirstRunTour userId={userId} /> : null}
    </>
  );
}

interface QualityAlert {
  runId: string;
  runTitle: string;
  status: "warn" | "fail";
  detail: string;
}

type RecentQualityState =
  | { phase: "loading"; alerts: [] }
  | { phase: "ready"; alerts: QualityAlert[]; incomplete: boolean }
  | { phase: "unavailable"; alerts: [] };

function qualityAlertsForRun(
  run: BuildListItem,
  response: BuildQualityResponse,
): QualityAlert[] {
  const runTitle = run.title ?? run.id;
  return Object.values(response.quality_results)
    .flat()
    .filter((result): result is QualityCheckResult & { status: "warn" | "fail" } =>
      result.status === "warn" || result.status === "fail",
    )
    .map((result) => ({
      runId: run.id,
      runTitle,
      status: result.status,
      detail: result.detail ?? [result.rule, result.column].filter(Boolean).join(" · "),
    }));
}

/** STEP 번호만 상수다 — 라벨은 언어 전환에 따라와야 하므로 렌더 시점에 해석한다. */
const WORKFLOW_STEP_NUMBERS = ["1", "2", "3", "4"] as const;

/**
 * Home의 전체 작업 흐름 설명. 클릭 가능한 액션 카드가 아니라 workflow 개요이므로
 * hover/button 느낌(그림자 강조, cursor-pointer)과 카드 자체 navigation을 두지
 * 않는다 — 각 STEP에서 실제로 할 일은 아래 "공공데이터 탐색"/"데이터 직접
 * 가져오기" 카드와 사이드바에서 진행한다.
 */
function WorkflowStrip() {
  const { t } = useTranslation();
  return (
    <section data-tour="workflow" aria-labelledby="workflow-heading" className="space-y-3">
      <div>
        <h2 id="workflow-heading" className="text-sm font-semibold text-foreground">{t("home.steps.heading")}</h2>
        <p className="text-xs text-muted-foreground">{t("home.steps.note")}</p>
      </div>
      <ol className="grid items-stretch gap-2 sm:grid-cols-2 xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
        {WORKFLOW_STEP_NUMBERS.map((number, index) => (
          <li key={number} className="contents">
            <div className="rounded-xl border border-border bg-card p-4">
              <span className="text-xs font-semibold text-accent-subtle-foreground">STEP {number}</span>
              <h3 className="mt-2 text-sm font-semibold">{t(`home.steps.${number}`)}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(`home.steps.${number}d`)}</p>
            </div>
            {index < WORKFLOW_STEP_NUMBERS.length - 1 ? (
              <span aria-hidden="true" className="hidden items-center justify-center text-muted-foreground xl:flex">→</span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Home의 Kubi 자연어 hero (#Phase2 UI polish, #S-kubi-suggest).
 *
 * 본격적인 Kubi 작업 시작점이므로 drawer가 아니라 `/kubi` 전용 페이지로 이동한다.
 * 새 assistant system을 만들지 않고 기존 seed 메커니즘(`useKubiStore().seedQuestion`)만
 * 재사용한다 — `/kubi`가 mount되면 `useKubiSession`이 pendingSeed를 소비해 답변을
 * 생성한다. 질문 내용은 URL query에 싣지 않는다(seed store로만 전달).
 *
 * `ask()`(useKubiSession.ts)는 seed를 받는 즉시 실행하고 API Key 미설정 시 `no_key`
 * 에러 turn을 만든다. 원치 않는 에러 turn을 피하려고 seed는 `isConfigured`일 때만
 * 남기고, 아니면 seed 없이 `/kubi`로 이동해 그 화면의 API Key 설정 안내를 보여준다.
 */
function KubiHero() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const seedQuestion = useKubiStore((state) => state.seedQuestion);
  const { isConfigured } = useAssistConfig();
  const startQuestions = getSuggestedQuestions({ context: { page: "home" }, turns: [] });

  function ask(question: string) {
    const trimmed = question.trim();
    if (trimmed && isConfigured) seedQuestion(trimmed);
    navigate("/kubi");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    ask(query);
    setQuery("");
  }

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold tracking-tight">{t("home.kubi.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("home.kubi.desc")}
      </p>
      <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="home-kubi-hero">
          {t("home.kubi.try")}
        </label>
        <input
          className="h-11 flex-1 rounded-lg border border-input bg-card px-4 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          id="home-kubi-hero"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("home.kubi.placeholder")}
          type="search"
          value={query}
        />
        <Button type="submit">{t("home.kubi.cta")}</Button>
      </form>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {startQuestions.map((question) => (
          <button
            key={question}
            type="button"
            className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-accent hover:text-foreground"
            onClick={() => ask(question)}
          >
            {question}
          </button>
        ))}
      </div>
      {!isConfigured ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("home.kubi.noKey")}
        </p>
      ) : null}
    </Card>
  );
}

function ExistingUserHome({
  userId,
  stats,
  recentBuilds,
  buildsState,
  kpi,
  recentQuality,
}: {
  userId: string | null;
  stats: DashboardStats;
  recentBuilds: BuildListItem[];
  buildsState: "loading" | "error" | "success";
  kpi: KpiPhases;
  recentQuality: RecentQualityState;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader
        eyebrow={t("home.dashboard.eyebrow")}
        title={t("home.dashboard.title")}
        description={t("home.dashboard.desc")}
        actions={userId ? <Button variant="secondary" onClick={() => resetFirstRunTour(userId)}>{t("home.dashboard.guide")}</Button> : undefined}
      />

      <section data-tour="dashboard-overview"><KpiCards stats={stats} kpi={kpi} /></section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div data-tour="dashboard-builds"><RecentBuildsSection
          recentBuilds={recentBuilds}
          loading={buildsState === "loading"}
          apiState={buildsState}
        /></div>
        <div data-tour="dashboard-quality"><QualitySection state={recentQuality} /></div>
      </section>
      {userId ? <FirstRunTour userId={userId} autoStart={false} variant="dashboard" /> : null}
    </>
  );
}

/**
 * KPI 4칸. 각 칸은 자기 aggregate 경계의 phase만 본다 — 한 aggregate가 실패해도
 * 다른 칸은 정상 값을 유지하고, 전체를 한꺼번에 에러로 덮지 않는다. null 값은
 * KpiCard가 "확인 불가"로 렌더한다(임의 숫자 합성 없음).
 */
/** 날짜 표기는 화면 언어를 따른다. */
function dateLocale(): string {
  return i18n.language?.startsWith("en") ? "en-US" : "ko-KR";
}

function KpiCards({ stats, kpi }: { stats: DashboardStats; kpi: KpiPhases }) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard label="DATASETS" help={t("home.kpi.datasets")} value={stats.datasetCount} loading={kpi.datasets === "loading"} />
      <KpiCard
        label="SUCCEEDED (24H)"
        help={t("home.kpi.succeeded")}
        value={stats.buildSuccess}
        loading={kpi.monitoring === "loading"}
        variant="success"
      />
      <KpiCard
        label="QUALITY WARN (24H)"
        help={t("home.kpi.qualityWarn")}
        value={stats.qualityWarn}
        loading={kpi.quality === "loading"}
        variant="error"
      />
      <KpiCard label="RUNNING" help={t("home.kpi.running")} value={stats.running} loading={kpi.monitoring === "loading"} />
    </section>
  );
}

function KpiCard({
  label,
  help,
  value,
  loading,
  variant = "default",
}: {
  label: string;
  help: string;
  value: number | null;
  loading: boolean;
  variant?: "default" | "success" | "error";
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <Card>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">{label}<HelpTooltip content={help} label={t("home.kpi.definitionLabel", { label })} /></span>
        <Skeleton className="mt-2 h-8 w-16" />
      </Card>
    );
  }

  const colorClass = variant === "success" ? "text-emerald-600 dark:text-emerald-400" :
                     variant === "error" ? "text-red-600 dark:text-red-400" :
                     "text-foreground";

  return (
    <Card className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">{label}<HelpTooltip content={help} label={t("home.kpi.definitionLabel", { label })} /></span>
      <span className={`text-2xl font-semibold tracking-tight ${colorClass}`}>
        {value === null ? t("home.kpi.unavailable") : value}
      </span>
    </Card>
  );
}

function RecentBuildsSection({
  recentBuilds,
  loading,
  apiState,
}: {
  recentBuilds: BuildListItem[];
  loading: boolean;
  apiState: "loading" | "error" | "success";
}) {
  const { t } = useTranslation();
  return (
    <section>
      <PageHeader eyebrow={t("home.recent.eyebrow")} title={t("home.recent.title")} className="mb-4" />
      <Card className="p-0">
        {loading ? (
          <div className="px-6 py-4 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.6fr] items-center gap-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-8 w-12 ml-auto" />
              </div>
            ))}
          </div>
        ) : apiState === "error" ? (
          <EmptyState
            title={t("home.recent.errorTitle")}
            description={t("home.recent.errorDesc")}
          />
        ) : recentBuilds.length === 0 ? (
          <EmptyState
            title={t("home.recent.emptyTitle")}
            description={t("home.recent.emptyDesc")}
            actionLabel={t("home.recent.emptyCta")}
            actionHref="/builds/new"
          />
        ) : (
          <ul>
            {recentBuilds.map((run) => (
              <li
                key={run.id}
                className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.6fr] items-center gap-4 border-b border-border px-6 py-3 text-sm last:border-0"
              >
                <span className="font-medium">{run.title ?? run.id}</span>
                <span className="capitalize text-muted-foreground">{run.status}</span>
                <span className="text-muted-foreground">
                  {run.startedAt ? new Date(run.startedAt).toLocaleString(dateLocale()) : "—"}
                </span>
                <span className="text-right">
                  <LinkButton variant="secondary" size="sm" to={`/builds/${run.id}`}>
                    {t("home.recent.view")}
                  </LinkButton>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function QualitySection({ state }: { state: RecentQualityState }) {
  const { t } = useTranslation();
  return (
    <section>
      <PageHeader eyebrow={t("home.quality.eyebrow")} title={t("home.quality.title")} className="mb-4" />
      <Card className="p-0">
        {state.phase === "loading" ? (
          <div className="space-y-3 px-6 py-5">
            {[1, 2, 3].map((item) => <Skeleton key={item} className="h-8 w-full" />)}
          </div>
        ) : state.phase === "unavailable" || (state.incomplete && state.alerts.length === 0) ? (
          <EmptyState
            title={t("home.quality.unavailableTitle")}
            description={t("home.quality.unavailableDesc")}
          />
        ) : state.alerts.length === 0 ? (
          <EmptyState
            title={t("home.quality.emptyTitle")}
            description={t("home.quality.emptyDesc")}
          />
        ) : (
          <div>
            <div className="px-6 py-4">
              <h3 className="font-semibold">{t("home.quality.needsCheck")}</h3>
              {state.incomplete ? (
                <p className="mt-1 text-xs text-muted-foreground">{t("home.quality.incomplete")}</p>
              ) : null}
            </div>
            <ul className="border-t border-border">
              {state.alerts.map((alert, index) => (
                <li key={`${alert.runId}:${alert.detail}:${index}`} className="border-b border-border last:border-0">
                  {/* WARN/FAIL 항목에서 해당 Run의 Quality context(/builds/:runId, ?run= canonical
                      form과 동일)로 바로 이동한다 — BuildsPage와 Recent Builds가 이미 쓰는 경로다. */}
                  <Link to={`/builds/${encodeURIComponent(alert.runId)}`} className="block px-6 py-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate font-medium">{alert.runTitle}</span>
                      <span className={alert.status === "fail" ? "font-semibold text-red-600 dark:text-red-400" : "font-semibold text-amber-700 dark:text-amber-400"}>
                        {alert.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{alert.detail}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t border-border px-6 py-4">
          <LinkButton variant="secondary" size="sm" to="/quality">{t("home.quality.center")}</LinkButton>
        </div>
      </Card>
    </section>
  );
}
