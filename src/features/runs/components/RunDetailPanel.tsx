/**
 * Builds detail 패널 — 선택한 run 의 Pipeline/Stage Progress, Quality, 실패 증거,
 * Artifacts/Dataset 이동 (#379로 BuildsPage에서 분리).
 *
 * 표면별 상태를 독립으로 들고 있어 하나가 실패해도 나머지를 계속 보여준다(#255 §8/§13).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { formatDateTime } from "@/features/datasets/model";
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
  collectFailureEvidence,
  summarizeMultiSourceOutcome,
  failQualityResults,
  failedRunEvents,
} from "@/features/runs/model";
import type { AsyncState } from "@/features/runs/asyncState";
import { extractDatasetId, mapLiveStatus, normalizeBuildContextSearch } from "@/features/runs/buildContext";
import { useStageDetails } from "@/features/runs/stageDetails";
import { EventTimeline } from "@/features/runs/components/EventTimeline";
import { KubiRunAnalysis } from "@/features/runs/components/KubiRunAnalysis";
import {
  MultiSourceOutcomeBadge,
  SourcePipelineRow,
} from "@/features/runs/components/SourcePipeline";
import type { RunEventsState } from "@/features/runs/useRunEvents";
import { useSelectedRunPolling } from "@/features/runs/useSelectedRunPolling";
import { useKubiStore } from "@/features/kubi/useKubiSession";
import { useUIStore } from "@/shared/hooks/useUIStore";
import { useAssistConfig } from "@/features/assistant/config";
import type {
  BuildQualityResponse,
  BuildSpecSnapshotResponse,
  RunStagesResponse,
} from "@/shared/lib/builderApi";
import type { BuildListItem, BuildRunStatus } from "@/shared/lib/types";
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  Skeleton,
  StageLegend,
  StatusBadge,
} from "@/shared/ui";

export function RunDetailPanel({
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
