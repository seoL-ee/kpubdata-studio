/**
 * Builds / Runs master-detail 화면 (`/builds`, `/builds?run=<id>`, 레거시 `/builds/:buildId`, #255).
 *
 * 상단 KPI → Run 목록(master) → 선택 Run 상세(Pipeline/Stage Progress, Quality, Failure
 * evidence, Artifacts/Dataset navigation) 구조로 Builder 상태를 있는 그대로 보여준다.
 * Studio는 Builder가 반환한 값을 재계산하거나 추측하지 않는다(#246 원칙).
 *
 * 이 파일은 **화면 조립만** 담당한다(#379). 조각은 `features/runs` 아래에 있다 —
 * 목록/상세 패널과 파이프라인은 `components/`, URL 문맥·stage detail·비동기 상태는
 * 각각 `buildContext.ts`/`stageDetails.ts`/`asyncState.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";

import { getBuildQuality, listBuildStages } from "@/features/datasets/api";
import { computeBuildKpi, matchesSearch, matchesStatusFilter, type RunStatusFilter } from "@/features/runs/model";
import { isTerminalBuilderStatus, listBuilds } from "@/features/runs/api";
import { getBuildSpecSnapshot } from "@/features/runs/api/runDetail";
import { useAsync, type AsyncState } from "@/features/runs/asyncState";
import { normalizeBuildContextSearch } from "@/features/runs/buildContext";
import { KpiRow } from "@/features/runs/components/KpiRow";
import { RunDetailPanel } from "@/features/runs/components/RunDetailPanel";
import { RunListPanel } from "@/features/runs/components/RunListPanel";
import { useSelectedRunPolling } from "@/features/runs/useSelectedRunPolling";
import { useRunEvents } from "@/features/runs/useRunEvents";
import type {
  BuildQualityResponse,
  BuildSpecSnapshotResponse,
  RunStagesResponse,
} from "@/shared/lib/builderApi";
import { isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type { BuildListItem } from "@/shared/lib/types";
import { Card, EmptyState, PageHeader, TermHelp } from "@/shared/ui";

/** `/builds` 요청 scope. Builder에 전체 count가 없으므로 KPI는 반드시 이 값 안에서만 계산한다. */
const LIST_LIMIT = 100;

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
