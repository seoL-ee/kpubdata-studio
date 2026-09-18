/**
 * Builds / Runs master-detail 화면 (`/builds`, `/builds?run=<id>`, 레거시 `/builds/:buildId`, #255).
 *
 * 상단 KPI → Run 목록(master) → 선택 Run 상세(Pipeline/Stage Progress, Quality, Failure
 * evidence, Artifacts/Dataset navigation) 구조로 Builder 상태를 있는 그대로 보여준다.
 * Studio는 Builder가 반환한 값을 재계산하거나 추측하지 않는다(#246 원칙).
 *
 * 데이터 표면별로 독립된 상태를 유지한다 — Quality/Artifact/BuildSpec snapshot 중 하나가
 * 실패해도 Run 기본 정보와 Stage Progress는 계속 보여야 한다(#255 §8/§13).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import { getBuildQuality, getBuildStageDetail, listBuildStages } from "@/features/datasets/api";
import { DATASET_STAGES, formatDateTime } from "@/features/datasets/model";
import { StageBadge } from "@/features/datasets/components/StageBadge";
import { QualityBadge, QualityStateBadge } from "@/features/quality/QualityBadge";
import {
  flattenQualityResults,
  flattenSchemaDrift,
  formatQualityValue,
  overallQualityState,
  summarizeChecksPassed,
  warnOrFailResults,
} from "@/features/quality/model";
import {
  classifyRunApiError,
  collectFailureEvidence,
  computeBuildKpi,
  failQualityResults,
  failedRunEvents,
  firstFailedStage,
  matchesSearch,
  matchesStatusFilter,
  summarizeMultiSourceOutcome,
  type RunStatusFilter,
} from "@/features/runs/model";
import { isTerminalBuilderStatus, listBuilds } from "@/features/runs/api";
import { getBuildSpecSnapshot } from "@/features/runs/api/runDetail";
import { useSelectedRunPolling } from "@/features/runs/useSelectedRunPolling";
import { useRunEvents, type RunEventsState } from "@/features/runs/useRunEvents";
import { EventTimeline } from "@/features/runs/components/EventTimeline";
import { KubiRunAnalysis } from "@/features/runs/components/KubiRunAnalysis";
import { useKubiStore } from "@/features/kubi/useKubiSession";
import { useAssistConfig } from "@/features/assistant/config";
import { Trans, useTranslation } from "react-i18next";
import { useUIStore } from "@/shared/hooks/useUIStore";
import { isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type {
  BuildQualityResponse,
  BuildSpecSnapshotResponse,
  RunStageEntry,
  RunStagesResponse,
  StageDetailResponse,
} from "@/shared/lib/builderApi";
import type { BuildListItem, BuildRunStatus } from "@/shared/lib/types";
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  SkeletonTable,
  Skeleton,
  StatusBadge,
  StageLegend,
  TermHelp,
  TextInput,
} from "@/shared/ui";

/** `/builds` 요청 scope. Builder에 전체 count가 없으므로 KPI는 반드시 이 값 안에서만 계산한다. */
const LIST_LIMIT = 100;

export type AsyncState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: T }
  | { status: "error"; error: string; notFound?: boolean; permissionDenied?: boolean };

function buildStatusFilters(t: (key: string) => string): { value: RunStatusFilter; label: string }[] {
  return [
    { value: "all", label: t("builds.statusFilter.all") },
    { value: "succeeded", label: t("builds.statusFilter.succeeded") },
    { value: "failed", label: t("builds.statusFilter.failed") },
    { value: "running", label: t("builds.statusFilter.running") },
    { value: "queued", label: t("builds.statusFilter.queued") },
    { value: "cancelled", label: t("builds.statusFilter.cancelled") },
  ];
}

function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  errorMessage: string,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "loaded", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const kind = classifyRunApiError(cause);
        setState({
          status: "error",
          error: cause instanceof Error ? cause.message : errorMessage,
          notFound: kind === "not_found",
          permissionDenied: kind === "permission_denied",
        });
      });
    return () => controller.abort();
  }, deps);

  return state;
}

/** Builder 응답이 loaded인 surface만 사용해 Builds의 Kubi context query를 정규화한다. */
export function normalizeBuildContextSearch(
  searchParams: URLSearchParams,
  specState: AsyncState<BuildSpecSnapshotResponse>,
  stagesState: AsyncState<RunStagesResponse>,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);

  if (specState.status === "loaded") {
    const datasetId = extractDatasetId(specState.data.spec);
    if (datasetId) next.set("dataset", datasetId);
    else next.delete("dataset");
  }

  if (stagesState.status === "loaded") {
    const sources = stagesState.data.sources;
    const failureEvidence = collectFailureEvidence(sources);
    const requestedStage = next.get("stage");
    const selectedSource = next.get("source");
    const selectedSourceEntry = selectedSource
      ? sources.find((source) => source.source_key === selectedSource)
      : sources.length === 1
        ? sources[0]
        : undefined;
    const requestedStageAvailable =
      (requestedStage === "bronze" || requestedStage === "silver" || requestedStage === "gold") &&
      Boolean(selectedSourceEntry && selectedSourceEntry[requestedStage].status !== "not_run");
    // 실패가 정확히 하나일 때만 그 failedStage를 안전한 문맥으로 쓰되, 선택된 source가
    // 있으면 반드시 그 source의 실패여야 한다 — 다른 source의 stage를 현재 source에
    // 붙여 불가능한 source/stage 조합(unverified evidence)을 만들지 않는다.
    const failureFallback =
      failureEvidence.length === 1 &&
      (!selectedSource || failureEvidence[0].sourceKey === selectedSource)
        ? failureEvidence[0].failedStage
        : null;
    const stage = requestedStageAvailable ? requestedStage : failureFallback;

    if (stage) next.set("stage", stage);
    else next.delete("stage");

    const sourceKeys = sources.map((source) => source.source_key);
    if (stage && sourceKeys.length === 1) next.set("source", sourceKeys[0]);
    else if (selectedSource && !sourceKeys.includes(selectedSource)) next.delete("source");
  }

  return next;
}

export function BuildsPage() {
  const { t } = useTranslation();
  const { buildId: legacyRunId } = useParams<{ buildId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [listState, setListState] = useState<AsyncState<BuildListItem[]>>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>("all");

  const loadList = useCallback(() => {
    const controller = new AbortController();
    setListState({ status: "loading" });
    listBuilds(LIST_LIMIT)
      .then((items) => {
        if (!controller.signal.aborted) setListState({ status: "loaded", data: items });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setListState({
          status: "error",
          error: cause instanceof Error ? cause.message : t("builds.errors.loadListFallback"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => loadList(), [loadList]);

  // 새 canonical form은 ?run=. 레거시 /builds/:buildId 딥링크도 같은 context를 연다(#255 §5).
  // 둘 다 있으면 canonical(?run=)이 우선한다.
  const selectedRunId = searchParams.get("run") || legacyRunId || null;

  const selectRun = useCallback(
    (runId: string) => {
      navigate(`/builds?run=${encodeURIComponent(runId)}`);
    },
    [navigate],
  );

  const clearSelection = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("run");
    // dataset/stage는 selected Run에서 파생된 Kubi context 값이다(#255 §2) — run 선택을
    // 지우면 함께 지워 다음 화면에 이전 run의 문맥이 남지 않게 한다.
    next.delete("dataset");
    next.delete("stage");
    next.delete("source");
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const items = listState.status === "loaded" ? listState.data : [];
  const runningAvailable = !isRealBuilderEnabled();
  const kpi = useMemo(() => computeBuildKpi(items, LIST_LIMIT, runningAvailable), [items, runningAvailable]);

  const visible = useMemo(
    () => items.filter((item) => matchesSearch(item, query) && matchesStatusFilter(item, statusFilter)),
    [items, query, statusFilter],
  );

  const selectedListItem = items.find((item) => item.id === selectedRunId) ?? null;
  const outOfListScope = Boolean(selectedRunId) && listState.status === "loaded" && !selectedListItem;
  const hiddenByFilter = Boolean(
    selectedListItem && !visible.some((item) => item.id === selectedListItem.id),
  );

  const stagesState = useAsync<RunStagesResponse>(
    (signal) => (selectedRunId ? listBuildStages(selectedRunId, signal) : Promise.reject(new Error("no run"))),
    [selectedRunId],
    t("builds.errors.loadStage"),
  );
  const qualityState = useAsync<BuildQualityResponse>(
    (signal) => (selectedRunId ? getBuildQuality(selectedRunId, signal) : Promise.reject(new Error("no run"))),
    [selectedRunId],
    t("builds.errors.loadQuality"),
  );
  const specState = useAsync<BuildSpecSnapshotResponse>(
    (signal) => (selectedRunId ? getBuildSpecSnapshot(selectedRunId, signal) : Promise.reject(new Error("no run"))),
    [selectedRunId],
    t("builds.errors.loadSpec"),
  );

  // Selected Run live(job registry) polling은 실제로 상태가 불확실한 경우에만 켠다(#286 후속
  // 보완 §1). mock mode는 builderApi.getBuildJob이 항상 실제 fetch를 시도하는 stub이라
  // succeeded/failed 같은 historical run에서도 매번 실패해 불필요한 "실시간 상태 갱신 실패"
  // 경고가 떴다 — mock mode에서는 목록의 deterministic mock status를 그대로 신뢰하고 live
  // polling 자체를 하지 않는다. real mode에서는 `GET /builds` 목록에 이미 존재하는 run은
  // 그 계약상 완료된(ok/failed) 이력만이므로 이미 terminal이 확정된 상태다 — 목록 로딩이
  // 끝나 그게 확인될 때까지는 조회를 켜지 않는다(단 한 번의 낭비 호출도 만들지 않기 위해
  // listState.status === "loaded"까지 기다린다). 목록 로딩이 끝났는데도 scope 밖(deep-link
  // run)이면 실제로 running/queued/cancelling일 수 있으므로 기존과 동일하게 getBuildJob으로
  // 확인한다.
  const shouldPollLiveStatus =
    Boolean(selectedRunId) && isRealBuilderEnabled() && listState.status === "loaded" && !selectedListItem;
  const live = useSelectedRunPolling(shouldPollLiveStatus ? selectedRunId : null);

  // event polling도 selected Run polling과 같은 "non-terminal이면 계속, terminal이면 멈춤"
  // 정책을 따른다(#255 §3). listItem의 historical 상태는 표시에는 쓰되(RunDetailPanel의
  // runStatus), interval polling을 켜는 판단에는 쓰지 않는다 — 확인된 live job이 실제로
  // non-terminal일 때만 polling을 시작한다(useSelectedRunPolling과 동일한 원칙).
  const eventsPollingEnabled = live.kind === "job" && !isTerminalBuilderStatus(live.job.status);
  const eventsState = useRunEvents(selectedRunId, eventsPollingEnabled);

  // Kubi Run context(#256)는 새 context store 없이, 기존 route resolver(features/kubi/context.ts)가
  // 읽는 `?run=&dataset=&stage=` 쿼리 관례를 그대로 재사용한다(Quality/Dataset Detail과 동일).
  // 이 화면에서 실제로 확인된 값만 반영한다 — failure message를 파싱해 stage를 추측하지 않고,
  // 정확히 하나의 source만 실패했을 때만 그 failedStage를 안전한 문맥으로 취급한다(#255 §2).
  useEffect(() => {
    if (!selectedRunId) return;
    const next = normalizeBuildContextSearch(searchParams, specState, stagesState);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [selectedRunId, specState, stagesState, searchParams, setSearchParams]);

  // Run 자체가 존재하지 않는다고 판정하는 기준: 목록 scope 밖이고, stage 조회도 404다.
  // (stage endpoint는 목록 limit과 무관하게 임의 run_id를 바로 조회할 수 있어 더 신뢰할 수 있는 신호)
  const runNotFound =
    Boolean(selectedRunId) &&
    listState.status === "loaded" &&
    !selectedListItem &&
    stagesState.status === "error" &&
    stagesState.notFound;

  // 목록 scope 밖이라 존재 여부를 판단할 근거(listItem)가 없는데, 그 판단 근거로 쓰던
  // stage 조회마저 403이면 "없다"가 아니라 "조회할 권한이 없다"로 구분한다(#255 P0).
  // 404와 절대 뭉개지 않는다 — 둘 다 "정보를 못 봤다"는 같은 결과가 아니다.
  const runPermissionDenied =
    Boolean(selectedRunId) &&
    listState.status === "loaded" &&
    !selectedListItem &&
    stagesState.status === "error" &&
    stagesState.permissionDenied;

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      {/* App Shell topbar에 이미 전역 "새 빌드 만들기" CTA가 있다(#255 §1) — 여기서는 중복 action을
          추가하지 않는다. */}
      <PageHeader
        eyebrow="Builds / Runs"
        title={t("builds.page.title")}
        description={
          <span>
            <Trans i18nKey="builds.page.desc" components={{ b: <strong /> }} />{" "}
            <TermHelp term="build" /> <TermHelp term="run" />
          </span>
        }
      />

      <KpiRow kpi={kpi} />

      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <RunListPanel
          listState={listState}
          visible={visible}
          query={query}
          onQueryChange={setQuery}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          selectedRunId={selectedRunId}
          onSelect={selectRun}
          onRetry={loadList}
          hiddenByFilter={hiddenByFilter}
        />

        {selectedRunId ? (
          runNotFound ? (
            <Card variant="error" role="alert">
              <p className="font-semibold">{t("builds.run.notFoundTitle", { id: selectedRunId })}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("builds.run.notFoundDesc", { limit: LIST_LIMIT })}
              </p>
              <button
                type="button"
                className="mt-4 text-sm font-medium text-accent-subtle-foreground underline"
                onClick={clearSelection}
              >
                {t("builds.run.clearSelection")}
              </button>
            </Card>
          ) : runPermissionDenied ? (
            <Card variant="error" role="alert">
              <p className="font-semibold">{t("builds.run.forbiddenTitle", { id: selectedRunId })}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("builds.run.forbiddenDesc", { limit: LIST_LIMIT })}
              </p>
              <button
                type="button"
                className="mt-4 text-sm font-medium text-accent-subtle-foreground underline"
                onClick={clearSelection}
              >
                {t("builds.run.clearSelection")}
              </button>
            </Card>
          ) : (
            <RunDetailPanel
              runId={selectedRunId}
              listItem={selectedListItem}
              outOfListScope={outOfListScope}
              stagesState={stagesState}
              qualityState={qualityState}
              specState={specState}
              eventsState={eventsState}
              live={live}
            />
          )
        ) : (
          <Card className="flex min-h-64 items-center justify-center">
            <EmptyState title={t("builds.run.selectPrompt")} description={t("builds.run.selectPromptDesc")} />
          </Card>
        )}
      </div>
    </main>
  );
}

function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

/**
 * Running KPI는 running+queued(+cancelling) 합계를 값으로 유지하되(기존 정책), hint에는
 * 실제 조회 scope에서 센 status별 breakdown만 보여준다 — 값을 추측하지 않는다(#286 후속 보완 §3).
 */
function runningBreakdownHint(
  kpi: ReturnType<typeof computeBuildKpi>,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (kpi.running === 0) return t("builds.kpi.scope");
  const parts: string[] = [];
  if (kpi.runningOnly > 0) parts.push(t("builds.kpi.running", { count: kpi.runningOnly }));
  if (kpi.cancellingOnly > 0) parts.push(t("builds.kpi.cancelling", { count: kpi.cancellingOnly }));
  if (kpi.queuedOnly > 0) parts.push(t("builds.kpi.queued", { count: kpi.queuedOnly }));
  return parts.join(" · ");
}

function KpiRow({ kpi }: { kpi: ReturnType<typeof computeBuildKpi> }) {
  const { t } = useTranslation();
  const scopeHint = t("builds.kpi.scopeHint", {
    count: kpi.scopeCount,
    limit: kpi.scopeLimit,
    more: kpi.scopeCount >= kpi.scopeLimit ? t("builds.kpi.maybeMore") : "",
  });
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <KpiTile label={t("builds.kpi.buildsScope")} value={String(kpi.scopeCount)} hint={scopeHint} />
      <KpiTile label="Success" value={String(kpi.succeeded)} hint={t("builds.kpi.scope")} />
      <KpiTile label="Failed" value={String(kpi.failed)} hint={t("builds.kpi.scope")} />
      <KpiTile
        label="Running"
        value={kpi.runningAvailable ? String(kpi.running) : "N/A"}
        hint={
          kpi.runningAvailable
            ? runningBreakdownHint(kpi, t)
            : t("builds.kpi.completedOnlyHint")
        }
      />
    </div>
  );
}

function RunListPanel({
  listState,
  visible,
  query,
  onQueryChange,
  statusFilter,
  onStatusFilterChange,
  selectedRunId,
  onSelect,
  onRetry,
  hiddenByFilter,
}: {
  listState: AsyncState<BuildListItem[]>;
  visible: BuildListItem[];
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: RunStatusFilter;
  onStatusFilterChange: (value: RunStatusFilter) => void;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onRetry: () => void;
  hiddenByFilter: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <TextInput
          aria-label={t("builds.search.aria")}
          placeholder={t("builds.search.placeholder")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="flex-1"
        />
        <Select
          aria-label={t("builds.search.filterAria")}
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value as RunStatusFilter)}
          className="sm:w-36"
        >
          {buildStatusFilters(t).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      {hiddenByFilter ? (
        <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          {t("builds.search.outOfScope")}
        </p>
      ) : null}

      {listState.status === "loading" ? (
        <SkeletonTable rows={6} />
      ) : listState.status === "error" ? (
        <ErrorState title={t("builds.errors.loadList")} message={listState.error} onRetry={onRetry} />
      ) : visible.length === 0 ? (
        <EmptyState title={t("builds.search.emptyTitle")} description={t("builds.search.emptyDesc")} />
      ) : (
        <ul className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: "70vh" }}>
          {visible.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={item.id === selectedRunId ? "true" : undefined}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                  item.id === selectedRunId
                    ? "border-accent bg-accent-subtle"
                    : "border-transparent hover:border-border hover:bg-muted"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{item.title ?? item.id}</span>
                  <StatusBadge status={item.status} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate font-mono">{item.id}</span>
                  <span>{formatDateTime(item.startedAt)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RunDetailPanel({
  runId,
  listItem,
  outOfListScope,
  stagesState,
  qualityState,
  specState,
  eventsState,
  live,
}: {
  runId: string;
  listItem: BuildListItem | null;
  outOfListScope: boolean;
  stagesState: AsyncState<RunStagesResponse>;
  qualityState: AsyncState<BuildQualityResponse>;
  specState: AsyncState<BuildSpecSnapshotResponse>;
  eventsState: RunEventsState;
  live: ReturnType<typeof useSelectedRunPolling>;
}) {
  const { t } = useTranslation();
  const openKubiDrawer = useUIStore((state) => state.openKubiDrawer);
  const seedKubiQuestion = useKubiStore((state) => state.seedQuestion);
  const { isConfigured } = useAssistConfig();
  const [searchParams] = useSearchParams();

  // "이 Run 분석"은 더 이상 전역 Kubi drawer를 자동으로 열지 않는다(#255 §2) — 대신 이 Run summary
  // 바로 아래에 inline card를 펼친다. Run을 바꾸면 카드를 닫아, 이전 Run의 분석 결과가 새 Run의
  // context에서 유효한 것처럼 보이지 않게 한다(#256 stale-context guard와 같은 원칙).
  const [showKubiAnalysis, setShowKubiAnalysis] = useState(false);
  // "이번 분석 클릭은 접수됐지만 아직 seed하지 않은" 상태. URL context가 canonical해질 때까지
  // 보류한다. 클릭 1회 = 이 flag 1회 set = seed 1회. run이 바뀌면 폐기한다.
  const [analyzePending, setAnalyzePending] = useState(false);

  useEffect(() => {
    setShowKubiAnalysis(false);
    setAnalyzePending(false);
  }, [runId]);

  const analyzeQuestion = t("builds.detail.analyzeQuestion", { id: runId });

  // "context가 canonical하다" = 현재 URL이 이미 normalizeBuildContextSearch의 고정점이다.
  // BuildsPage의 정규화 effect와 정확히 같은 helper·같은 동등성 판정을 재사용한다(로직 복제 금지).
  // spec/stages가 아직 settle되지 않았으면(추가로 dataset/stage/source가 붙을 수 있으므로)
  // 겉보기 no-op이어도 canonical로 보지 않는다. error도 settle로 취급해 영구 대기를 막는다.
  const contextCanonical = useMemo(() => {
    const specSettled = specState.status === "loaded" || specState.status === "error";
    const stagesSettled = stagesState.status === "loaded" || stagesState.status === "error";
    if (!specSettled || !stagesSettled) return false;
    return (
      normalizeBuildContextSearch(searchParams, specState, stagesState).toString() ===
      searchParams.toString()
    );
  }, [searchParams, specState, stagesState]);

  // 보류된 분석 의도는 URL이 canonical해진 뒤에 seed한다. seed 직전에 pending flag를 내려
  // 같은 클릭에 대한 재실행을 막는다(effect가 유일한 seeder다). 다음 "이 Run 분석" 클릭은
  // flag를 다시 set하므로 재분석/에러 후 재시도는 그대로 가능하다 — 중복 방지는 "한 클릭당
  // 한 번"이지 "run 수명 동안 한 번"이 아니다. (seed는 KubiRunAnalysis mount 시 useKubiSession의
  // 기존 pending-seed 소비 effect가 ask()로 실행한다 — 그 경로/atomic consumeSeed는 미변경.)
  useEffect(() => {
    if (!analyzePending || !isConfigured || !contextCanonical) return;
    setAnalyzePending(false);
    seedKubiQuestion(analyzeQuestion);
  }, [analyzePending, isConfigured, contextCanonical, analyzeQuestion, seedKubiQuestion]);

  const sources = stagesState.status === "loaded" ? stagesState.data.sources : [];
  const outcome = stagesState.status === "loaded" ? summarizeMultiSourceOutcome(sources) : "unavailable";
  const failureEvidence = stagesState.status === "loaded" ? collectFailureEvidence(sources) : [];
  const stageDetails = useStageDetails(runId, stagesState);

  // Quality error(요청 실패)와 Builder semantic unavailable(정상 응답, 결과 없음)을 절대 하나로
  // 합치지 않는다(#255 후속 보완 §5). overall state는 정상 응답이 있을 때만 계산하고, error는
  // 아래 렌더링에서 qualityState.status === "error"로 완전히 분리해서 다룬다.
  const qualityStatus = qualityState.status === "loaded" ? overallQualityState(qualityState.data) : undefined;
  const qualityFails = qualityState.status === "loaded" ? failQualityResults(qualityState.data) : [];
  const qualityScopedResults = qualityState.status === "loaded" ? flattenQualityResults(qualityState.data) : [];
  const qualityChecksPassed = qualityState.status === "loaded" ? summarizeChecksPassed(qualityScopedResults) : null;
  const qualityIssues = qualityState.status === "loaded" ? warnOrFailResults(qualityScopedResults) : [];
  const qualityDrift = qualityState.status === "loaded" ? flattenSchemaDrift(qualityState.data) : [];
  const qualityData = qualityState.status === "loaded" ? qualityState.data : null;
  const qualitySourceBreakdown = qualityData
    ? Object.keys(qualityData.quality_results).map((sourceKey) => ({
        sourceKey,
        summary: summarizeChecksPassed(flattenQualityResults(qualityData, sourceKey)),
      }))
    : [];
  const events = eventsState.status === "loaded" ? eventsState.data.events : [];
  const failedEvents = failedRunEvents(events);

  // Quality Center(#254)로 넘어갈 때도 현재 dataset/run 문맥을 잃지 않도록 같은 쿼리 관례를 쓴다.
  const datasetId = specState.status === "loaded" ? extractDatasetId(specState.data.spec) : null;
  const qualityCenterHref = `/quality?${new URLSearchParams({
    ...(datasetId ? { dataset: datasetId } : {}),
    run: runId,
  }).toString()}`;

  // Run 전체 status: registry에 살아있는 job(live)이 있으면 그 값이 가장 최신이다.
  // 없으면(historical) 목록 요약(listItem.status)을 신뢰한다 — 절대 stage 상태를 run status로
  // 뭉개서 재계산하지 않는다(#255 §6 원칙).
  const runStatus: BuildRunStatus | null = live.kind === "job" ? mapLiveStatus(live.job.status) : listItem?.status ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold tracking-tight">{listItem?.title ?? runId}</h2>
          {runStatus ? <StatusBadge status={runStatus} /> : <span className="text-xs text-muted-foreground">{t("builds.detail.statusUnknown")}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{runId}</span>
          {live.kind === "job" && (live.job.status === "queued" || live.job.status === "running" || live.job.status === "cancelling") ? (
            <span className="text-xs text-muted-foreground">{t("builds.detail.refreshing")}</span>
          ) : null}
          {live.kind === "error" ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t("builds.detail.refreshFailed")}
            </span>
          ) : null}
          {live.kind === "permission_denied" ? (
            <span className="text-xs text-red-700 dark:text-red-400">
              {t("builds.detail.refreshForbidden")}
            </span>
          ) : null}
          {outOfListScope ? (
            <span className="text-xs text-muted-foreground">
              {t("builds.detail.outOfScopeDetail")}
            </span>
          ) : null}
          {listItem?.startedAt ? <span className="text-xs text-muted-foreground">{t("builds.detail.startedAt", { time: formatDateTime(listItem.startedAt) })}</span> : null}
          {listItem?.finishedAt ? <span className="text-xs text-muted-foreground">{t("builds.detail.finishedAt", { time: formatDateTime(listItem.finishedAt) })}</span> : null}
        </div>
        <div className="flex flex-wrap gap-3">
          <Link className="text-xs font-medium text-accent-subtle-foreground underline" to={`/builds/${encodeURIComponent(runId)}/edit`}>
            {t("builds.detail.edit")}
          </Link>
          <Link className="text-xs font-medium text-accent-subtle-foreground underline" to={`/builds/${encodeURIComponent(runId)}/run`}>
            {t("builds.detail.run")}
          </Link>
          <Link className="text-xs font-medium text-accent-subtle-foreground underline" to={`/builds/${encodeURIComponent(runId)}/artifacts`}>
            {t("builds.detail.artifacts")}
          </Link>
          <Link className="text-xs font-medium text-accent-subtle-foreground underline" to={`/builds/${encodeURIComponent(runId)}/publish`}>
            {t("builds.detail.publish")}
          </Link>
          <Button
            variant="secondary"
            className="ml-auto"
            onClick={() => {
              // 클릭은 즉시 inline card를 연다.
              setShowKubiAnalysis(true);
              // API Key가 없으면 seed하지 않는다 — pending seed는 항상 useKubiSession의
              // 일반 ask()로 소비되고, ask()는 isConfigured가 아니면 no_key 에러를 만든다
              // (#286 후속 보완). inline card는 그래도 열어 KubiRunAnalysis가 no-key 안내를
              // 보여주게 한다.
              if (!isConfigured) return;
              // 클릭은 "이번 분석 의도"만 접수한다. 실제 seed는 위 effect가 URL이 canonical해진
              // 뒤 1회 실행한다 — canonical이면 사실상 즉시. thin context로 turn이 고정돼 곧바로
              // stale로 빠지는 race를 막고(C1), 재분석/에러 후 재시도는 그대로 가능하다.
              setAnalyzePending(true);
            }}
          >
            {t("builds.detail.analyze")}
          </Button>
        </div>
      </Card>

      {showKubiAnalysis ? (
        <KubiRunAnalysis
          onClose={() => {
            setAnalyzePending(false);
            setShowKubiAnalysis(false);
          }}
          onAskMore={openKubiDrawer}
        />
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Pipeline / Stage Progress</h3>
          {stagesState.status === "loaded" ? <MultiSourceOutcomeBadge outcome={outcome} /> : null}
        </div>
        <div className="mt-3"><StageLegend /></div>
        {stagesState.status === "loading" || stagesState.status === "idle" ? (
          <Skeleton className="mt-4 h-24 w-full" />
        ) : stagesState.status === "error" ? (
          <p className="mt-3 text-sm text-red-700 dark:text-red-300">
            {stagesState.permissionDenied
              ? t("builds.stage.forbidden")
              : stagesState.error}
          </p>
        ) : sources.length === 0 ? (
          <EmptyState title={t("builds.stage.noneTitle")} description={t("builds.stage.noneDesc")} />
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {/* multi-source면 source별로 각자의 pipeline row를 보여준다 — 첫 source를 전체
                대표로 뭉개지 않는다. */}
            {sources.map((source) => (
              <SourcePipelineRow key={source.source_key} source={source} details={stageDetails} />
            ))}
          </div>
        )}
        {qualityState.status === "loaded" && qualityChecksPassed ? (
          // "별도 Validate stage"를 새로 만들지 않고, Silver/Gold 흐름과 이어지는 compact
          // checkpoint로만 Quality를 언급한다(#255 후속 보완 §6). 실제 판정은 아래 Quality
          // 카드가 정본이며, 여기서는 재계산 없이 그 값을 그대로 요약한다.
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Quality checkpoint</span>
            <QualityStateBadge state={qualityStatus ?? "NOT_EVALUATED"} />
            <span>
              {qualityChecksPassed.evaluated === 0
                ? t("builds.stage.noEvaluated")
                : `${qualityChecksPassed.pass}/${qualityChecksPassed.evaluated} PASS · WARN ${qualityChecksPassed.warn} · FAIL ${qualityChecksPassed.fail}`}
            </span>
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Quality</h3>
          <div className="flex items-center gap-2">
            {qualityStatus ? <QualityStateBadge state={qualityStatus} /> : null}
            {qualityState.status === "loaded" ? (
              <span className="text-xs text-muted-foreground">availability: {qualityState.data.availability}</span>
            ) : null}
          </div>
        </div>
        {qualityState.status === "loading" || qualityState.status === "idle" ? (
          <Skeleton className="mt-4 h-16 w-full" />
        ) : qualityState.status === "error" ? (
          // (B) 요청 실패 — Builder의 semantic unavailable(정상 응답)과 절대 같은 상태로 합치지
          // 않는다(#255 후속 보완 §5). UNAVAILABLE badge를 표시하지 않고, 403/404/network·5xx에
          // 맞는 오류 메시지만 보여준다.
          <div className="mt-3">
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">{t("builds.quality.failedTitle")}</p>
            <p className="mt-1 text-sm text-red-700 dark:text-red-300">
              {qualityState.permissionDenied
                ? t("builds.quality.forbidden")
                : qualityState.notFound
                  ? t("builds.quality.notFound")
                  : t("builds.quality.loadError", { error: qualityState.error })}
            </p>
          </div>
        ) : qualityState.data.availability === "unavailable" ? (
          // (A) 정상 응답 + availability=unavailable — Builder가 명시적으로 "결과 없음"이라고
          // 답한 것이지 조회 실패가 아니다.
          <EmptyState title={t("builds.quality.unavailableTitle")} description={t("builds.quality.unavailableDesc")} />
        ) : qualityState.data.evaluated_checks === 0 ? (
          <EmptyState title={t("builds.quality.noChecksTitle")} description={t("builds.quality.noChecksDesc")} />
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {qualityChecksPassed ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium text-emerald-700 dark:text-emerald-400">{qualityChecksPassed.pass} PASS</span>
                <span className="font-medium text-amber-700 dark:text-amber-400">{qualityChecksPassed.warn} WARN</span>
                <span className="font-medium text-red-700 dark:text-red-400">{qualityChecksPassed.fail} FAIL</span>
                <span className="text-xs text-muted-foreground">{t("builds.quality.evaluated", { count: qualityChecksPassed.evaluated })}</span>
              </div>
            ) : null}

            {qualitySourceBreakdown.length > 1 ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold text-muted-foreground">{t("builds.quality.perSource")}</p>
                {qualitySourceBreakdown.map(({ sourceKey, summary }) => (
                  <div key={sourceKey} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-mono">{sourceKey}</span>
                    <span className="text-muted-foreground">
                      {summary.evaluated === 0
                        ? t("builds.quality.noEvalResult")
                        : `${summary.pass}/${summary.evaluated} PASS · WARN ${summary.warn} · FAIL ${summary.fail}`}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {/* PASS 상세 전체 나열은 피하고, WARN/FAIL만 근거(source/category/rule/column/actual/threshold)와
                함께 보여준다(#255 후속 보완 §1). */}
            {qualityIssues.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {qualityIssues.map((result, index) => (
                  <li
                    key={`${result.source_key}-${result.rule}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 text-xs last:border-0"
                  >
                    <span>
                      {result.source_key} · {result.category}/{result.rule}
                      {result.column ? ` · ${result.column}` : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <QualityBadge status={result.status.toUpperCase() as "WARN" | "FAIL"} />
                      <span className="font-mono text-muted-foreground">
                        actual {formatQualityValue(result.rule, result.actual)} / threshold{" "}
                        {formatQualityValue(result.rule, result.threshold)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("builds.quality.noWarnFail")}</p>
            )}

            {qualityDrift.length > 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t("builds.quality.drift", {
                  count: qualityDrift.length,
                  kinds: qualityDrift.map((finding) => finding.kind).join(", "),
                })}
              </p>
            ) : null}

            <Link className="text-xs font-medium text-accent-subtle-foreground underline" to={qualityCenterHref}>
              {t("builds.quality.viewCenter")}
            </Link>
          </div>
        )}
      </Card>

      {failureEvidence.length > 0 || qualityFails.length > 0 ? (
        <Card variant="error">
          <h3 className="text-sm font-semibold">Failure evidence</h3>
          {failureEvidence.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {failureEvidence.map((item) => (
                <li key={item.sourceKey}>
                  <strong>{item.sourceKey}</strong> — failed stage: {item.failedStage ?? "unknown"} · last completed stage:{" "}
                  {item.lastCompletedStage ?? "none"}
                </li>
              ))}
            </ul>
          ) : null}
          {listItem?.status === "failed" && live.kind === "job" && live.job.error ? (
            <p className="mt-2 text-sm">Builder error: {live.job.error}</p>
          ) : null}
          {qualityFails.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 text-sm">
              {qualityFails.map((result, index) => (
                <li key={`${result.source_key}-${result.rule}-${index}`}>
                  FAIL · {result.source_key} · {result.category}/{result.rule}
                  {result.column ? ` · column ${result.column}` : ""} · actual {JSON.stringify(result.actual)} vs threshold{" "}
                  {JSON.stringify(result.threshold)}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <Disclosure
          title={
            <span className="flex flex-1 flex-wrap items-center gap-2">
              Run Events{eventsState.status === "loaded" ? ` (${events.length})` : ""}
              {failedEvents.length > 0 ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/50 dark:text-red-300">
                  {t("builds.events.failedCount", { count: failedEvents.length })}
                </span>
              ) : null}
            </span>
          }
        >
          <p className="text-xs text-muted-foreground">
            {t("builds.events.note")}
          </p>
          {eventsState.status === "loading" || eventsState.status === "idle" ? (
            <Skeleton className="mt-4 h-24 w-full" />
          ) : eventsState.status === "error" ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {eventsState.mockUnsupported
                ? eventsState.error
                : eventsState.notFound
                  ? t("builds.events.notFound")
                  : eventsState.permissionDenied
                    ? t("builds.events.forbidden")
                    : t("builds.events.loadError", { error: eventsState.error })}
            </p>
          ) : (
            <EventTimeline events={events} />
          )}
        </Disclosure>
      </Card>

      <Card>
        <Disclosure title="BuildSpec snapshot">
          {specState.status === "loading" || specState.status === "idle" ? (
            <Skeleton className="h-10 w-full" />
          ) : null}
          {specState.status === "error" ? (
            <p className="text-sm text-muted-foreground">
              {specState.permissionDenied
                ? t("builds.spec.forbidden")
                : specState.error}
            </p>
          ) : specState.status === "loaded" ? (
            <div className="text-sm">
              <p className="text-xs text-muted-foreground">digest: {specState.data.spec_digest}</p>
              {datasetId ? (
                <Link
                  className="mt-2 inline-block text-xs font-medium text-accent-subtle-foreground underline"
                  to={`/datasets/${encodeURIComponent(datasetId)}`}
                >
                  {t("builds.spec.viewDataset", { id: datasetId })}
                </Link>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                {t("builds.spec.note")}
              </p>
            </div>
          ) : null}
        </Disclosure>
      </Card>
    </div>
  );
}

/** BuildSpec snapshot YAML에서 dataset_id만 안전하게 뽑는다. 파싱 실패는 조용히 null로 처리한다(추측 금지). */
function extractDatasetId(specYaml: string): string | null {
  try {
    const parsed = parseYaml(specYaml) as unknown;
    if (parsed && typeof parsed === "object" && "dataset_id" in parsed) {
      const value = (parsed as Record<string, unknown>).dataset_id;
      return typeof value === "string" && value.length > 0 ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Builder job status를 그대로 화면 상태로 쓴다.
 *
 * 예전에는 cancelling을 running으로 합쳐서 보여줬지만, "취소 중"과 "실행 중"은 사용자가 취소
 * 요청을 보냈는지 여부가 다른 별개 상태다 — Builder가 보낸 상태를 다른 상태로 재분류하지
 * 않는다(#255 후속 보완). BuildRunStatus/StatusBadge가 cancelling을 직접 지원한다.
 */
function mapLiveStatus(status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled"): BuildRunStatus {
  return status;
}

function MultiSourceOutcomeBadge({
  outcome,
}: { outcome: ReturnType<typeof summarizeMultiSourceOutcome> }) {
  const { t } = useTranslation();
  if (outcome === "unavailable") return null;
  const meta = {
    all_succeeded: { label: t("builds.outcome.allSucceeded"), className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" },
    partial: { label: t("builds.outcome.partial"), className: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
    all_failed: { label: t("builds.outcome.allFailed"), className: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300" },
  }[outcome];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>{meta.label}</span>;
}

/**
 * Pipeline / Stage Progress 시각화(#255 후속 보완 §6).
 *
 * Bronze/Silver/Gold만 정본 Stage로 취급한다 — Source/Output은 그 자체로는 Stage 상태가
 * 아니라 문맥/endpoint 표현이며, Validate·Artifact 같은 새 Stage를 만들지 않는다.
 */
type StageName = (typeof DATASET_STAGES)[number];

type StageDetailEntry =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: StageDetailResponse }
  | { status: "error" };

function stageDetailKey(sourceKey: string, stage: StageName): string {
  return `${sourceKey}:${stage}`;
}

/** entry가 실제로 요청한 stage의 detail을 담고 있을 때만 그 타입으로 좁혀서 돌려준다. */
function pickStageDetail<S extends StageName>(
  entry: StageDetailEntry | undefined,
  stage: S,
): Extract<StageDetailResponse, { stage: S }> | null {
  if (!entry || entry.status !== "loaded" || entry.data.stage !== stage) return null;
  return entry.data as Extract<StageDetailResponse, { stage: S }>;
}

/**
 * completed && available인 source×stage에 대해서만 stage detail을 조회한다 — 모든
 * source×stage를 무조건 eager-fetch해 요청을 폭증시키지 않는다. bounded concurrency(3)로
 * 조회하고, run이 바뀌면 이전 요청은 abort한다.
 */
function useStageDetails(runId: string, stagesState: AsyncState<RunStagesResponse>): Record<string, StageDetailEntry> {
  const [details, setDetails] = useState<Record<string, StageDetailEntry>>({});

  useEffect(() => {
    setDetails({});
    if (stagesState.status !== "loaded") return;
    const sources = stagesState.data.sources;
    const targets: { sourceKey: string; stage: StageName }[] = [];
    for (const source of sources) {
      for (const stage of DATASET_STAGES) {
        if (source[stage].status === "completed" && source[stage].available) {
          targets.push({ sourceKey: source.source_key, stage });
        }
      }
    }
    if (targets.length === 0) return;

    const controller = new AbortController();
    const concurrency = Math.min(3, targets.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < targets.length) {
        const target = targets[nextIndex++];
        const key = stageDetailKey(target.sourceKey, target.stage);
        setDetails((prev) => ({ ...prev, [key]: { status: "loading" } }));
        try {
          const detail = await getBuildStageDetail(runId, target.stage, target.sourceKey, 5, controller.signal);
          if (controller.signal.aborted) return;
          setDetails((prev) => ({ ...prev, [key]: { status: "loaded", data: detail } }));
        } catch {
          if (controller.signal.aborted) return;
          // detail은 compact 부가 정보일 뿐이다 — 실패해도 Stage summary(status/available)는
          // 이미 확보되어 있으므로 badge 자체는 계속 정상 표시된다.
          setDetails((prev) => ({ ...prev, [key]: { status: "error" } }));
        }
      }
    }

    void Promise.all(Array.from({ length: concurrency }, worker));
    return () => controller.abort();
  }, [runId, stagesState]);

  return details;
}

/** source 안에서, 실제 failed로 기록된 stage 이후에 오는 not_run stage("아직 미도달"). 추측이 아니라 순서 비교다. */
function isUnreachedStage(source: RunStageEntry, stage: StageName): boolean {
  const failedAt = firstFailedStage(source);
  if (!failedAt || source[stage].status !== "not_run") return false;
  return DATASET_STAGES.indexOf(stage) > DATASET_STAGES.indexOf(failedAt);
}

function PipelineArrow() {
  return (
    <span aria-hidden="true" className="self-center px-1 text-muted-foreground">
      →
    </span>
  );
}

function formatRecordCount(
  value: number | null,
  t: (key: string) => string,
): string {
  return value === null ? "N/A" : `${value.toLocaleString("ko-KR")}${t("builds.data.rowsUnit")}`;
}

function BronzeStageBox({ state, detail }: { state: RunStageEntry["bronze"]; detail: StageDetailEntry | undefined }) {
  const { t } = useTranslation();
  const data = pickStageDetail(detail, "bronze");
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Bronze</span>
      <StageBadge status={state.status} />
      {data ? (
        <span className="text-[11px] text-muted-foreground">
          {formatRecordCount(data.record_count, t)}
          {data.fetched_at ? ` · ${formatDateTime(data.fetched_at)}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function SilverStageBox({
  state,
  detail,
}: { state: RunStageEntry["silver"]; detail: StageDetailEntry | undefined }) {
  const { t } = useTranslation();
  const data = pickStageDetail(detail, "silver");
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Silver</span>
      <StageBadge status={state.status} />
      {data ? (
        <span className="text-[11px] text-muted-foreground">
          {formatRecordCount(data.row_count, t)} · {t("builds.data.cols", { count: data.schema.length })}
          {data.validation ? ` · ${data.validation.ok ? t("builds.data.validationOk") : t("builds.data.problems", { count: data.validation.problems.length })}` : ""}
        </span>
      ) : null}
    </div>
  );
}

function GoldStageBox({
  state,
  detail,
}: { state: RunStageEntry["gold"]; detail: StageDetailEntry | undefined }) {
  const { t } = useTranslation();
  const data = pickStageDetail(detail, "gold");
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Gold</span>
      <StageBadge status={state.status} />
      {data ? (
        <span className="text-[11px] text-muted-foreground">
          {formatRecordCount(data.row_count, t)} · {t("builds.data.cols", { count: data.columns.length })}
          {data.splits ? t("builds.data.splits", { count: Object.keys(data.splits).length }) : ""}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Output은 Stage가 아니다 — Gold export가 실제로 확인될 때만 compact하게 보여주고,
 * completed/failed 같은 Stage 상태로 표현하지 않는다.
 */
function OutputBox({ detail }: { detail: StageDetailEntry | undefined }) {
  const data = pickStageDetail(detail, "gold");
  const exports = data?.exports ?? [];
  return (
    <div className="flex min-w-32 flex-col gap-1 rounded-md border border-dashed border-border p-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Output</span>
      <span className="text-xs text-muted-foreground">
        {exports.length > 0 ? exports.map((item) => item.kind).join(" · ") : "—"}
      </span>
    </div>
  );
}

function SourcePipelineRow({ source, details }: { source: RunStageEntry; details: Record<string, StageDetailEntry> }) {
  const { t } = useTranslation();
  const unreached: Record<StageName, boolean> = {
    bronze: isUnreachedStage(source, "bronze"),
    silver: isUnreachedStage(source, "silver"),
    gold: isUnreachedStage(source, "gold"),
  };
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source</span>
        <span className="font-mono text-xs">{source.source_key}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-1">
        <div className={source.bronze.status === "failed" ? "rounded-md ring-2 ring-red-400 dark:ring-red-500" : undefined}>
          <BronzeStageBox state={source.bronze} detail={details[stageDetailKey(source.source_key, "bronze")]} />
          {unreached.bronze ? <p className="mt-1 text-[11px] text-muted-foreground">{t("builds.data.unreached")}</p> : null}
        </div>
        <PipelineArrow />
        <div className={source.silver.status === "failed" ? "rounded-md ring-2 ring-red-400 dark:ring-red-500" : undefined}>
          <SilverStageBox state={source.silver} detail={details[stageDetailKey(source.source_key, "silver")]} />
          {unreached.silver ? <p className="mt-1 text-[11px] text-muted-foreground">{t("builds.data.unreached")}</p> : null}
        </div>
        <PipelineArrow />
        <div className={source.gold.status === "failed" ? "rounded-md ring-2 ring-red-400 dark:ring-red-500" : undefined}>
          <GoldStageBox state={source.gold} detail={details[stageDetailKey(source.source_key, "gold")]} />
          {unreached.gold ? <p className="mt-1 text-[11px] text-muted-foreground">{t("builds.data.unreached")}</p> : null}
        </div>
        <PipelineArrow />
        <OutputBox detail={details[stageDetailKey(source.source_key, "gold")]} />
      </div>
    </div>
  );
}
