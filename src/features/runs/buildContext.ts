/**
 * Builds 화면의 URL 문맥(run/dataset/source/stage) 정규화 (#379로 BuildsPage에서 분리).
 *
 * Builder 응답이 loaded인 표면만 근거로 삼는다 — 아직 모르는 값을 추측해 URL에 쓰지 않는다.
 */
import { parse as parseYaml } from "yaml";

import { collectFailureEvidence, type RunStatusFilter } from "@/features/runs/model";
import type { AsyncState } from "@/features/runs/asyncState";
import type { BuildSpecSnapshotResponse, RunStagesResponse } from "@/shared/lib/builderApi";
import type { BuildRunStatus } from "@/shared/lib/types";

export function buildStatusFilters(t: (key: string) => string): { value: RunStatusFilter; label: string }[] {
  return [
    { value: "all", label: t("builds.statusFilter.all") },
    { value: "succeeded", label: t("builds.statusFilter.succeeded") },
    { value: "failed", label: t("builds.statusFilter.failed") },
    { value: "running", label: t("builds.statusFilter.running") },
    { value: "queued", label: t("builds.statusFilter.queued") },
    { value: "cancelled", label: t("builds.statusFilter.cancelled") },
  ];
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



/** BuildSpec snapshot YAML에서 dataset_id만 안전하게 뽑는다. 파싱 실패는 조용히 null로 처리한다(추측 금지). */
export function extractDatasetId(specYaml: string): string | null {
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
export function mapLiveStatus(status: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled"): BuildRunStatus {
  return status;
}
