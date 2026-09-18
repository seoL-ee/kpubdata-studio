import { i18n } from "@/shared/i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  getBuildQuality,
  getBuildStageDetail,
  getDataset,
  listBuildStages,
  listDatasetRuns,
} from "@/features/datasets/api";
import { StageBadge } from "@/features/datasets/components/StageBadge";
import {
  DATASET_STAGES,
  formatDateTime,
  highestCompletedStage,
  type DatasetStage,
} from "@/features/datasets/model";
import { QualityBadge } from "@/features/quality/QualityBadge";
import { qualityResultsForSource, summarizeQuality } from "@/features/quality/model";
import { KubiContent } from "@/features/kubi/KubiContent";
import type {
  BuildQualityResponse,
  DatasetDetailResponse,
  DatasetRunSummary,
  RunStagesResponse,
  StageDetailResponse,
} from "@/shared/lib/builderApi";
import { Button, Card, EmptyState, ErrorState, LinkButton, PageHeader, Skeleton, StageLegend } from "@/shared/ui";

type DetailTab = "overview" | "schema" | "preview" | "quality" | "builds" | "ai";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "schema", label: "Schema" },
  { id: "preview", label: "Preview" },
  { id: "quality", label: "Quality" },
  { id: "builds", label: "Builds" },
  { id: "ai", label: "AI" },
];

interface CoreState {
  status: "loading" | "loaded" | "error";
  dataset?: DatasetDetailResponse;
  runs?: DatasetRunSummary[];
  error?: string;
}

interface AsyncState<T> {
  status: "idle" | "loading" | "loaded" | "error";
  data?: T;
  error?: string;
}

const selectClassName =
  "h-9 rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Definition({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm text-foreground">{children}</dd></div>;
}

/** Bronze/Silver/Gold의 일반적인 stage 역할(이 데이터셋의 실제 이력을 서술하는 것이 아니다). */
/** 라벨이 아니라 키만 담는다 — 모듈 상수에 문장을 넣으면 언어가 import 시점에 굳는다(#350). */
const STAGE_EXPLAINER_KEY: Record<DatasetStage, string> = {
  bronze: "datasetDetail.stageBronze",
  silver: "datasetDetail.stageSilver",
  gold: "datasetDetail.stageGold",
};

export function DatasetDetailPage() {
  const { t } = useTranslation();
  const { datasetId = "" } = useParams<{ datasetId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [core, setCore] = useState<CoreState>({ status: "loading" });
  const [stagesState, setStagesState] = useState<AsyncState<RunStagesResponse>>({ status: "idle" });
  const [qualityState, setQualityState] = useState<AsyncState<BuildQualityResponse>>({ status: "idle" });
  const [stageDetailState, setStageDetailState] = useState<AsyncState<StageDetailResponse>>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    setCore({ status: "loading" });
    Promise.all([getDataset(datasetId, controller.signal), listDatasetRuns(datasetId, 50, controller.signal)])
      .then(([dataset, runs]) => setCore({ status: "loaded", dataset, runs: runs.runs }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setCore({ status: "error", error: cause instanceof Error ? cause.message : i18n.t("datasetDetail.loadError") });
      });
    return () => controller.abort();
  }, [datasetId]);

  const requestedRun = searchParams.get("run");
  const selectedRunId = requestedRun || core.dataset?.latest_run_id || "";
  const invalidRun = Boolean(requestedRun && core.runs && !core.runs.some((run) => run.run_id === requestedRun));

  useEffect(() => {
    if (!selectedRunId || invalidRun) {
      setStagesState({ status: "idle" });
      setQualityState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setStagesState({ status: "loading" });
    setQualityState({ status: "loading" });
    listBuildStages(selectedRunId, controller.signal)
      .then((data) => setStagesState({ status: "loaded", data }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setStagesState({ status: "error", error: cause instanceof Error ? cause.message : i18n.t("datasetDetail.stagesErrorMsg") });
      });
    getBuildQuality(selectedRunId, controller.signal)
      .then((data) => setQualityState({ status: "loaded", data }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setQualityState({ status: "error", error: cause instanceof Error ? cause.message : i18n.t("datasetDetail.qualityErrorMsg") });
      });
    return () => controller.abort();
  }, [selectedRunId, invalidRun]);

  const requestedSource = searchParams.get("source");
  const sourceEntries = stagesState.data?.sources ?? [];
  const invalidSource = Boolean(requestedSource && stagesState.status === "loaded" && !sourceEntries.some((source) => source.source_key === requestedSource));
  const selectedSource = requestedSource || sourceEntries[0]?.source_key || "";
  const sourceStageEntry = sourceEntries.find((source) => source.source_key === selectedSource);
  const requestedStage = searchParams.get("stage");
  const validRequestedStage = DATASET_STAGES.includes(requestedStage as DatasetStage) ? requestedStage as DatasetStage : undefined;
  const selectedStage = validRequestedStage ?? (sourceStageEntry ? highestCompletedStage(sourceStageEntry) : "bronze");

  // 잘못된 stage 파라미터는 URL에서 제거해 UI fallback 상태와 URL을 일치시킨다.
  useEffect(() => {
    if (requestedStage && !validRequestedStage) {
      const next = new URLSearchParams(searchParams);
      next.delete("stage");
      setSearchParams(next);
    }
  }, [requestedStage, validRequestedStage, searchParams, setSearchParams]);

  useEffect(() => {
    if (!selectedRunId || !selectedSource || invalidRun || invalidSource) {
      setStageDetailState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setStageDetailState({ status: "loading" });
    getBuildStageDetail(selectedRunId, selectedStage, selectedSource, 20, controller.signal)
      .then((data) => setStageDetailState({ status: "loaded", data }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setStageDetailState({ status: "error", error: cause instanceof Error ? cause.message : i18n.t("datasetDetail.stageDetailErrorMsg") });
      });
    return () => controller.abort();
  }, [selectedRunId, selectedSource, selectedStage, invalidRun, invalidSource]);

  function updateContext(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next);
  }

  // AI 탭은 Kubi(KubiContent)가 route의 ?run=&source=&stage=로만 문맥을 판단한다(추측 금지 원칙,
  // context.ts 참고) — 그래서 여기서 화면에 이미 계산되어 보이는 selectedRunId/selectedSource/
  // selectedStage를 URL에 명시적으로 반영해줘야, 처음 AI 탭을 열었을 때도 Kubi RUN context bar가
  // 실제로는 알고 있는 latest run을 "—"로 보여주거나 Generated SQL/Result Preview가 비어 보이지
  // 않는다(UI audit #5). source까지 실어야 multi-source run에서 stage evidence가 fail-closed로
  // 빠지지 않는다(#319 후속). 탭 바(button onClick)와 Overview 탭의 Kubi discoverability CTA
  // 모두 이 helper 하나를 공유해 같은 규칙을 두 번 구현하지 않는다.
  function goToTab(tab: DetailTab) {
    updateContext(
      tab === "ai"
        ? { tab: "ai", run: selectedRunId, source: selectedSource || null, stage: selectedStage }
        : { tab: tab === "overview" ? null : tab },
    );
  }

  const tabParam = searchParams.get("tab") as DetailTab | null;
  const selectedTab = TABS.some((tab) => tab.id === tabParam) ? tabParam as DetailTab : "overview";
  const selectedRun = core.runs?.find((run) => run.run_id === selectedRunId);
  const validation = summarizeQuality(qualityState.data, selectedSource);
  const selectedQualityResults = qualityResultsForSource(qualityState.data, selectedSource);
  const selectedDrift = qualityState.data?.schema_drift[selectedSource] ?? [];

  // AI 탭에 직접 진입/새로고침해도 tab click 경로(goToTab("ai"))와 동일한 canonical Kubi
  // context를 만든다. Kubi(KubiContent)는 route의 ?run=&source=&stage=만 문맥으로 읽으므로
  // (context.ts), 화면이 확정한 선택을 URL에 되반영하지 않으면 AI 탭이 dataset 수준
  // evidence만 받는다(#319 후속, QualityPage와 동일 패턴). replace로만 갱신하고, 이미
  // 유효하게 선택된 값·invalid 상태는 건드리지 않아 update loop를 만들지 않는다.
  useEffect(() => {
    if (selectedTab !== "ai" || core.status !== "loaded" || invalidRun || invalidSource) return;
    const next = new URLSearchParams(searchParams);
    let changed = false;
    if (selectedRunId && !requestedRun) {
      next.set("run", selectedRunId);
      changed = true;
    }
    if (stagesState.status === "loaded" && selectedSource) {
      if (!requestedSource) {
        next.set("source", selectedSource);
        changed = true;
      }
      if (!requestedStage) {
        next.set("stage", selectedStage);
        changed = true;
      }
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [
    selectedTab,
    core.status,
    invalidRun,
    invalidSource,
    stagesState.status,
    selectedRunId,
    requestedRun,
    selectedSource,
    requestedSource,
    requestedStage,
    selectedStage,
    searchParams,
    setSearchParams,
  ]);

  // Run 전체 상태("ok"/"failed"/"cancelled")와 선택된 source·stage 상태("completed"/"failed"/
  // "not_run"/"unavailable")는 서로 다른 vocabulary를 쓰는 별개 scope다 — 한 run에 여러 source가
  // 있으면 선택된 source의 stage는 completed/PASS인데 run 전체는 다른 source의 실패로 failed일 수
  // 있다. 이는 모순이 아니라 두 canonical source가 서로 다른 것을 나타내는 것이므로, 값을 숨기거나
  // 억지로 맞추는 대신 두 상태가 갈릴 수 있는 이유를 실제 데이터(다른 source의 stage 실패)로
  // 설명한다.
  const otherFailingSources = useMemo(
    () =>
      sourceEntries
        .filter((source) => source.source_key !== selectedSource)
        .filter((source) => DATASET_STAGES.some((stage) => source[stage].status === "failed"))
        .map((source) => source.source_key),
    [sourceEntries, selectedSource],
  );
  const runStatus = selectedRun?.status ?? core.dataset?.status;
  const runFailedButSelectedStageOk =
    runStatus === "failed" &&
    sourceStageEntry?.[selectedStage].status === "completed" &&
    otherFailingSources.length > 0;

  const summaryRowCount = useMemo(() => {
    const detail = stageDetailState.data;
    if (detail?.stage === "bronze") return detail.record_count;
    if (detail?.stage === "silver" || detail?.stage === "gold") return detail.row_count;
    return null;
  }, [stageDetailState.data]);

  if (core.status === "loading") {
    return <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10"><PageHeader eyebrow="Dataset" title={datasetId} description={t("datasetDetail.loadingDesc")} /><Card><Skeleton className="h-40 w-full" /></Card></main>;
  }

  if (core.status === "error" || !core.dataset || !core.runs) {
    return <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10"><PageHeader eyebrow="Dataset" title={datasetId || t("datasetDetail.fallbackTitle")} /><ErrorState title={t("datasetDetail.loadErrorTitle")} message={core.error} /></main>;
  }

  if (invalidRun) {
    return (
      <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <PageHeader eyebrow="Dataset" title={core.dataset.title} description={core.dataset.dataset_id} />
        <Card variant="error" role="alert"><p className="font-semibold">{t("datasetDetail.invalidRunTitle")}</p><p className="mt-2 text-sm">{t("datasetDetail.invalidRunBody", { run: requestedRun })}</p><Button className="mt-4" variant="secondary" onClick={() => updateContext({ run: null, source: null, stage: null })}>{t("datasetDetail.viewLatest")}</Button></Card>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-5 px-5 py-7 sm:px-8 lg:px-10 lg:py-8">
      <PageHeader
        eyebrow="Dataset"
        title={core.dataset.title}
        description={<><span className="block font-mono text-xs">{core.dataset.dataset_id}</span><span className="mt-1 block">{core.dataset.sources.map((source) => source.provider).join(", ")} · {selectedSource || t("datasetDetail.sourceLoading")} · Build {selectedRunId}{selectedRunId === core.dataset.latest_run_id ? " (latest)" : ""}</span></>}
        actions={<><span title={t("datasetDetail.stageStatusTitle", { source: selectedSource || "—", stage: selectedStage })} className="inline-flex items-center gap-2 rounded-full bg-accent-subtle px-3 py-1 text-xs font-semibold capitalize text-accent-subtle-foreground"><span>{selectedStage}</span><span className="font-normal">{sourceStageEntry?.[selectedStage].status ?? "unavailable"}</span></span><QualityBadge status={validation} /><LinkButton size="sm" to={`/builds/${encodeURIComponent(selectedRunId)}/publish?dataset=${encodeURIComponent(core.dataset.dataset_id)}`}>{t("datasetDetail.publishRun")}</LinkButton></>}
      />

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <label className="min-w-52 flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Run<select aria-label={t("datasetDetail.runSelect")} className={`mt-1 w-full ${selectClassName}`} value={selectedRunId} onChange={(event) => updateContext({ run: event.target.value === core.dataset?.latest_run_id ? null : event.target.value, source: null, stage: null })}>{core.runs.map((run) => <option key={run.run_id} value={run.run_id}>{run.run_id}{run.run_id === core.dataset?.latest_run_id ? " (latest)" : ""}</option>)}</select></label>
        <label className="min-w-52 flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source<select aria-label={t("datasetDetail.sourceSelect")} className={`mt-1 w-full ${selectClassName}`} value={selectedSource} disabled={stagesState.status !== "loaded"} onChange={(event) => updateContext({ source: event.target.value, stage: null })}>{invalidSource && requestedSource ? <option value={requestedSource}>{t("datasetDetail.missingSource", { source: requestedSource })}</option> : null}{sourceEntries.map((source) => <option key={source.source_key} value={source.source_key}>{source.source_key}</option>)}</select></label>
        <label className="min-w-44 flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Stage<select aria-label={t("datasetDetail.stageSelect")} className={`mt-1 w-full ${selectClassName}`} value={selectedStage} disabled={!sourceStageEntry} onChange={(event) => updateContext({ stage: event.target.value })}>{DATASET_STAGES.map((stageName) => <option key={stageName} value={stageName}>{stageName} · {sourceStageEntry?.[stageName].status ?? "unavailable"}</option>)}</select></label>
        <div title={t("datasetDetail.runStatusTitle")} className="flex min-h-9 items-center gap-2 px-2 text-xs text-muted-foreground"><span>{t("datasetDetail.runStatusLabel")}</span><strong className="text-foreground">{runStatus}</strong></div>
      </Card>
      <StageLegend />

      {stagesState.status === "error" ? <Card variant="error" role="alert">{stagesState.error}</Card> : invalidSource ? <Card variant="error" role="alert">{t("datasetDetail.invalidSource", { source: requestedSource })}</Card> : null}
      {runFailedButSelectedStageOk ? (
        <Card variant="error" role="alert">
          <p className="font-semibold">{t("datasetDetail.runFailedTitle", { stage: selectedStage })}</p>
          <p className="mt-1 text-sm">
            {t("datasetDetail.runFailedBody", { sources: otherFailingSources.join(", ") })}
          </p>
        </Card>
      ) : null}

      <div className="border-b border-border" role="tablist" aria-label="Dataset detail tabs">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selectedTab === tab.id}
              onClick={() => goToTab(tab.id)}
              className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium ${selectedTab === tab.id ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <section role="tabpanel" aria-label={TABS.find((tab) => tab.id === selectedTab)?.label}>
        {selectedTab === "overview" ? <OverviewTab dataset={core.dataset} selectedRun={selectedRun} runStatus={runStatus} selectedSource={selectedSource} selectedStage={selectedStage} sourceStages={sourceStageEntry} stageDetail={stageDetailState.data} stageError={stageDetailState.error} rowCount={summaryRowCount} validation={validation} onSelectStage={(stageName) => updateContext({ stage: stageName })} onSelectTab={goToTab} /> : null}
        {selectedTab === "schema" ? <SchemaTab state={stageDetailState} drift={selectedDrift} /> : null}
        {selectedTab === "preview" ? <PreviewTab state={stageDetailState} qualityState={qualityState} qualityStatus={validation} qualityResults={selectedQualityResults} onOpenQuality={() => updateContext({ tab: "quality" })} /> : null}
        {selectedTab === "quality" ? <QualityTab state={qualityState} status={validation} results={selectedQualityResults} drift={selectedDrift} datasetId={datasetId} runId={selectedRunId} source={selectedSource} stage={selectedStage} /> : null}
        {selectedTab === "builds" ? <BuildsTab runs={core.runs} selectedRunId={selectedRunId} /> : null}
        {selectedTab === "ai" ? <KubiContent compact /> : null}
      </section>
    </main>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return <Card className="p-5"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><div className="mt-2 text-2xl font-bold tracking-tight">{value}</div><div className="mt-1 text-xs text-muted-foreground">{sub}</div></Card>;
}

function OverviewTab({ dataset, selectedRun, runStatus, selectedSource, selectedStage, sourceStages, stageDetail, stageError, rowCount, validation, onSelectStage, onSelectTab }: { dataset: DatasetDetailResponse; selectedRun?: DatasetRunSummary; runStatus?: string; selectedSource: string; selectedStage: DatasetStage; sourceStages?: RunStagesResponse["sources"][number]; stageDetail?: StageDetailResponse; stageError?: string; rowCount: number | null; validation: ReturnType<typeof summarizeQuality>; onSelectStage: (stage: DatasetStage) => void; onSelectTab: (tab: DetailTab) => void }) {
  const { t } = useTranslation();
  const columnCount = stageDetail?.stage === "silver" ? stageDetail.schema.length : stageDetail?.stage === "gold" ? stageDetail.columns.length : null;
  const artifactSummary = stageDetail?.stage === "gold" ? stageDetail.exports.map((item) => item.kind).join(", ") || t("datasetDetail.unpublished") : t("datasetDetail.notGoldStage");
  return <div className="space-y-4">
    <DataPassport dataset={dataset} selectedRun={selectedRun} runStatus={runStatus} selectedSource={selectedSource} selectedStage={selectedStage} sourceStages={sourceStages} columnCount={columnCount} artifactSummary={artifactSummary} validation={validation} onSelectTab={onSelectTab} />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Rows" value={rowCount === null ? "—" : rowCount.toLocaleString("ko-KR")} sub={selectedStage} /><MetricCard label="Columns" value={columnCount ?? "—"} sub="Builder stage response" /><MetricCard label="Validation" value={<QualityBadge status={validation} />} sub={selectedSource || t("datasetDetail.noSource")} /><MetricCard label="Updated" value={<span className="text-lg">{formatDateTime(selectedRun?.finished_at ?? selectedRun?.started_at ?? dataset.updated_at)}</span>} sub={`Build ${selectedRun?.run_id ?? dataset.latest_run_id}`} /></div>
    <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]"><Card><h3 className="text-sm font-semibold">Lineage</h3>{sourceStages ? <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"><div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-center text-sm font-semibold">Source<span className="mt-1 block text-xs font-normal text-muted-foreground">{selectedSource}</span></div>{DATASET_STAGES.map((stageName) => <div key={stageName} className="contents"><span aria-hidden="true" className="text-center text-muted-foreground">→</span><button type="button" aria-label={`${stageName} ${sourceStages[stageName].status}`} aria-pressed={selectedStage === stageName} onClick={() => onSelectStage(stageName)} className={`rounded-lg border px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedStage === stageName ? "border-accent bg-accent-subtle" : "border-border bg-card hover:bg-muted"}`}><span className="block text-sm font-semibold capitalize">{stageName}</span><span className="mt-1 block"><StageBadge status={sourceStages[stageName].status} /></span><span className="mt-1 block text-[11px] font-normal text-muted-foreground">{t(STAGE_EXPLAINER_KEY[stageName])}</span></button></div>)}</div> : <Skeleton className="mt-4 h-24 w-full" />}</Card><Card><h3 className="text-sm font-semibold">Stage Detail · <span className="capitalize">{selectedStage}</span></h3>{stageError ? <p className="mt-3 text-sm text-red-700 dark:text-red-300">{stageError}</p> : !stageDetail ? <Skeleton className="mt-4 h-24 w-full" /> : <><dl className="mt-4 space-y-3"><Definition label="Status"><StageBadge status={stageDetail.status} /></Definition><Definition label="Available">{stageDetail.available ? "yes" : "no"}</Definition><Definition label="Provider / Source">{dataset.sources.map((source) => `${source.provider}.${source.dataset}`).join(", ")} · {selectedSource}</Definition><Definition label="Output">{stageDetail.stage === "gold" ? (stageDetail.exports.map((item) => item.kind).join(", ") || t("datasetDetail.outputNone")) : t("datasetDetail.outputNotProvided")}</Definition></dl><div className="mt-4 flex gap-2"><Button variant="secondary" size="sm" onClick={() => onSelectTab("preview")}>Preview</Button><Button variant="secondary" size="sm" onClick={() => onSelectTab("quality")}>{t("datasetDetail.viewQuality")}</Button></div></>}</Card></div>
  </div>;
}

/**
 * Data Passport — "이 dataset이 무엇이고 어디서 왔으며 신뢰 가능한지"를 한눈에 보여주는
 * trust summary(#Phase2 UI polish). 새 backend 데이터를 요구하지 않는다 — 이미 이 페이지가
 * fetch한 값만 재사용한다. 값이 없는 필드는 지어내지 않고 "확인 불가"/"제공되지 않음" 등으로
 * 명확히 표기하거나 생략한다(License는 이 스키마 어디에도 실제 dataset 속성으로 존재하지
 * 않아 — Publish 화면에서 사용자가 입력하는 값일 뿐이므로 — 아예 생략한다).
 *
 * "Run 상태(전체)"와 "선택된 Source·Stage 상태"는 서로 다른 vocabulary(run 전체 집계 vs
 * source/stage 단위)라 값이 갈릴 수 있다(:174-178의 runFailedButSelectedStageOk 참고) — 두
 * 필드를 하나로 합치지 않고 라벨을 분리해 그 scope 차이를 다시 흐리지 않는다.
 */
function DataPassport({ dataset, selectedRun, runStatus, selectedSource, selectedStage, sourceStages, columnCount, artifactSummary, validation, onSelectTab }: { dataset: DatasetDetailResponse; selectedRun?: DatasetRunSummary; runStatus?: string; selectedSource: string; selectedStage: DatasetStage; sourceStages?: RunStagesResponse["sources"][number]; columnCount: number | null; artifactSummary: string; validation: ReturnType<typeof summarizeQuality>; onSelectTab: (tab: DetailTab) => void }) {
  const { t } = useTranslation();
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Data Passport</h3>
        <button type="button" className="text-xs font-medium text-accent-subtle-foreground underline" onClick={() => onSelectTab("ai")}>
          {t("datasetDetail.kubiHint")}
        </button>
      </div>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Definition label="Provider / Source">{dataset.sources.map((source) => `${source.provider}.${source.dataset}`).join(", ") || t("datasetDetail.unavailable")}</Definition>
        <Definition label="Dataset">{dataset.title}<span className="block font-mono text-xs text-muted-foreground">{dataset.dataset_id}</span></Definition>
        <Definition label={t("datasetDetail.runStatusAll")}>{runStatus ?? t("datasetDetail.unavailable")}</Definition>
        <Definition label={t("datasetDetail.selectedStageStatus")}>{sourceStages ? <StageBadge status={sourceStages[selectedStage].status} /> : t("datasetDetail.unavailable")}</Definition>
        <Definition label="Quality"><QualityBadge status={validation} /></Definition>
        <Definition label="Schema">{columnCount === null ? t("datasetDetail.schemaMissing") : `${columnCount} columns`}</Definition>
        <Definition label="BuildSpec digest">{selectedRun?.spec_digest ? <span className="break-all font-mono text-xs">{selectedRun.spec_digest}</span> : t("datasetDetail.unavailable")}</Definition>
        <Definition label="Artifact">{artifactSummary}</Definition>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        {t("datasetDetail.tabsHint", { source: selectedSource || t("datasetDetail.noSource") })}
      </p>
    </Card>
  );
}

function SchemaTab({ state, drift }: { state: AsyncState<StageDetailResponse>; drift: BuildQualityResponse["schema_drift"][string] }) {
  const { t } = useTranslation();
  if (state.status === "loading" || state.status === "idle") return <Card><Skeleton className="h-40 w-full" /></Card>;
  if (state.status === "error" || !state.data) return <Card variant="error" role="alert">{state.error}</Card>;
  const detail = state.data;
  if (detail.stage === "silver" && detail.schema.length > 0) return <Card className="overflow-hidden p-0"><div className="border-b border-border px-5 py-4"><h3 className="text-sm font-semibold">Schema Drift</h3><p className="mt-1 text-xs text-muted-foreground">{t("datasetDetail.schemaSilverNote")}</p></div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground"><tr><th className="px-5 py-3">Column</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Missing</th><th className="px-5 py-3">{t("datasetDetail.changeCol")}</th></tr></thead><tbody>{detail.schema.map((column) => { const finding = drift.find((item) => item.column === column.name); const nullCount = detail.statistics?.null_counts[column.name]; const rowCount = detail.statistics?.row_count; return <tr key={column.name} className="border-b border-border last:border-0"><td className="px-5 py-3 font-medium">{column.name}</td><td className="px-5 py-3">{column.dtype}</td><td className="px-5 py-3">{nullCount !== undefined && rowCount ? `${((nullCount / rowCount) * 100).toFixed(1)}%` : "—"}</td><td className="px-5 py-3">{finding ? <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">{finding.kind}</span> : "—"}</td></tr>; })}</tbody></table></div></Card>;
  if (detail.stage === "gold" && detail.columns.length > 0) return <Card className="overflow-hidden p-0"><div className="border-b border-border px-5 py-4"><h3 className="text-sm font-semibold">Schema Drift</h3><p className="mt-1 text-xs text-muted-foreground">{t("datasetDetail.schemaGoldNote")}</p></div><table className="w-full text-left text-sm"><thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground"><tr><th className="px-5 py-3">Column</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Missing</th><th className="px-5 py-3">{t("datasetDetail.changeCol")}</th></tr></thead><tbody>{detail.columns.map((column) => <tr key={column} className="border-b border-border last:border-0"><td className="px-5 py-3 font-medium">{column}</td><td className="px-5 py-3">—</td><td className="px-5 py-3">—</td><td className="px-5 py-3">{drift.find((item) => item.column === column)?.kind ?? "—"}</td></tr>)}</tbody></table></Card>;
  return <Card><EmptyState title={t("datasetDetail.schemaNone")} description={t("datasetDetail.schemaNoneDesc", { stage: detail.stage })} /></Card>;
}

function PreviewTab({ state, qualityState, qualityStatus, qualityResults, onOpenQuality }: { state: AsyncState<StageDetailResponse>; qualityState: AsyncState<BuildQualityResponse>; qualityStatus: ReturnType<typeof summarizeQuality>; qualityResults: ReturnType<typeof qualityResultsForSource>; onOpenQuality: () => void }) {
  const { t } = useTranslation();
  if (state.status === "loading" || state.status === "idle") return <Card><Skeleton className="h-40 w-full" /></Card>;
  if (state.status === "error" || !state.data) return <Card variant="error" role="alert">{state.error}</Card>;
  if (state.data.stage !== "silver" || state.data.sample.length === 0) return <Card><EmptyState title={t("datasetDetail.previewNone")} description={t("datasetDetail.previewNoneDesc", { stage: state.data.stage })} /></Card>;
  const columns = [...new Set(state.data.sample.flatMap((row) => Object.keys(row)))];
  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]"><Card className="min-w-0 overflow-hidden p-0"><div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4"><div><h3 className="text-sm font-semibold">Sample data</h3><p className="mt-1 text-xs text-muted-foreground">{t("datasetDetail.previewNote")}</p></div><div className="text-xs text-muted-foreground">{state.data.sample.length} rows · {columns.length} columns</div></div><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b border-border bg-muted/40"><tr>{columns.map((column) => <th key={column} className="px-5 py-3 font-semibold">{column}</th>)}</tr></thead><tbody>{state.data.sample.map((row, index) => <tr key={index} className="border-b border-border last:border-0">{columns.map((column) => <td key={column} className="max-w-64 truncate px-5 py-3">{formatJson(row[column])}</td>)}</tr>)}</tbody></table></div></Card><Card><h3 className="text-sm font-semibold">Validation</h3><div className="mt-4 text-2xl font-bold"><QualityBadge status={qualityStatus} /></div><div className="mt-4 space-y-3">{qualityState.status === "error" ? <p className="text-sm text-red-700 dark:text-red-300">{t("datasetDetail.fetchFailed")}</p> : qualityResults.length === 0 ? <p className="text-sm text-muted-foreground">{t("datasetDetail.noEvaluated")}</p> : qualityResults.slice(0, 5).map((result, index) => <div key={`${result.rule}-${index}`} className="flex items-center justify-between gap-3 border-b border-border pb-2 text-sm last:border-0"><span>{result.category}</span><QualityBadge status={result.status.toUpperCase() as "PASS" | "WARN" | "FAIL"} /></div>)}</div><Button className="mt-4 w-full" variant="secondary" onClick={onOpenQuality}>{t("datasetDetail.viewQualityDetail")}</Button></Card></div>;
}

function QualityTab({ state, status, results, drift, datasetId, runId, source, stage }: { state: AsyncState<BuildQualityResponse>; status: ReturnType<typeof summarizeQuality>; results: ReturnType<typeof qualityResultsForSource>; drift: BuildQualityResponse["schema_drift"][string]; datasetId: string; runId: string; source: string; stage: DatasetStage }) {
  const { t } = useTranslation();
  if (state.status === "loading" || state.status === "idle") return <Card><Skeleton className="h-40 w-full" /></Card>;
  if (state.status === "error") return <Card variant="error"><QualityBadge status="N/A" /><p className="mt-3 text-sm">{state.error}</p></Card>;
  const counts = results.reduce((current, result) => ({ ...current, [result.status]: current[result.status] + 1 }), { pass: 0, warn: 0, fail: 0 });
  const qualityCenterHref = `/quality?${new URLSearchParams({ dataset: datasetId, ...(runId ? { run: runId } : {}), ...(source ? { source } : {}), stage }).toString()}`;
  return <div className="space-y-4"><div className="flex justify-end"><Link className="text-xs font-medium text-accent-subtle-foreground underline" to={qualityCenterHref}>{t("datasetDetail.viewInQualityCenter")}</Link></div><div className="grid gap-4 lg:grid-cols-2"><Card><h3 className="text-sm font-semibold">Validation summary</h3><div className="mt-4 flex items-end gap-3"><span className="text-3xl font-bold">{results.length}</span><span className="pb-1 text-sm text-muted-foreground">evaluated checks</span></div><div className="mt-4 flex flex-wrap gap-2"><QualityBadge status={status} /><span className="text-xs text-muted-foreground">PASS {counts.pass} · WARN {counts.warn} · FAIL {counts.fail}</span></div><p className="mt-3 text-xs text-muted-foreground">{t("datasetDetail.qualityNote")}</p></Card><Card><h3 className="text-sm font-semibold">Schema Drift</h3>{drift.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">{t("datasetDetail.noDrift")}</p> : <div className="mt-4 space-y-3">{drift.map((finding, index) => <div key={`${finding.kind}-${index}`} className="flex items-start justify-between gap-3 border-b border-border pb-3 text-sm last:border-0"><div><strong>{finding.kind}</strong><p className="mt-1 text-xs text-muted-foreground">{finding.detail}</p></div><span className="font-mono text-xs">{finding.column ?? "—"}</span></div>)}</div>}</Card></div>{results.length === 0 ? <Card><EmptyState title={t("datasetDetail.noQualityTitle")} description={t("datasetDetail.noQualityDesc")} /></Card> : <Card className="overflow-hidden p-0"><div className="border-b border-border px-5 py-4"><h3 className="text-sm font-semibold">Recent quality issues</h3></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground"><tr><th className="px-4 py-3">Rule</th><th className="px-4 py-3">Result</th><th className="px-4 py-3">Column</th><th className="px-4 py-3">Actual</th><th className="px-4 py-3">Threshold</th></tr></thead><tbody>{results.map((result, index) => <tr key={`${result.rule}-${result.column}-${index}`} className="border-b border-border last:border-0"><td className="px-4 py-3 font-medium">{result.category} · {result.rule}</td><td className="px-4 py-3"><QualityBadge status={result.status.toUpperCase() as "PASS" | "WARN" | "FAIL"} /></td><td className="px-4 py-3">{result.column ?? "—"}</td><td className="px-4 py-3 font-mono text-xs">{formatJson(result.actual)}</td><td className="px-4 py-3 font-mono text-xs">{formatJson(result.threshold)}</td></tr>)}</tbody></table></div></Card>}</div>;
}

function BuildsTab({ runs, selectedRunId }: { runs: DatasetRunSummary[]; selectedRunId: string }) {
  const { t } = useTranslation();
  return <Card className="overflow-hidden p-0"><div className="border-b border-border px-5 py-4"><h3 className="text-sm font-semibold">Recent Builds</h3><p className="mt-1 text-xs text-muted-foreground">{t("datasetDetail.runsNote")}</p></div><div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground"><tr><th className="px-5 py-3">Build</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Updated</th><th className="px-5 py-3"></th></tr></thead><tbody>{runs.map((run) => <tr key={run.run_id} className={`border-b border-border last:border-0 ${run.run_id === selectedRunId ? "bg-accent-subtle" : ""}`}><td className="px-5 py-3 font-mono text-xs">{run.run_id}{run.run_id === selectedRunId ? " · selected" : ""}</td><td className="px-5 py-3">{run.status}</td><td className="px-5 py-3">{formatDateTime(run.finished_at ?? run.started_at)}</td><td className="px-5 py-3 text-right"><Link className="font-medium text-accent-subtle-foreground underline" to={`/builds/${encodeURIComponent(run.run_id)}`}>{t("datasetDetail.view")}</Link></td></tr>)}</tbody></table></div></Card>;
}
