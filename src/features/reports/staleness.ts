/**
 * 저장된 Report의 기준 dataset/run이 여전히 유효한지 판정한다 (#258 §8).
 *
 * Report를 다시 열 때 기준 evidence를 "가능한 범위에서" 재확인하되, 결과가 무엇이든
 * 저장된 Report 내용을 지우거나 최신 run으로 자동 교체하지 않는다 — 이 모듈은 상태
 * 판정만 하고, 실제로 무엇을 보여줄지는 호출부(UI)가 결정한다.
 *
 * 네 가지 상태만 구분한다:
 * - CURRENT: 기준 run이 이 dataset의 최신 run과 같다(재확인 가능, 최신).
 * - STALE: 기준 run은 여전히 접근 가능하지만 더 최신 run이 생겼다.
 * - ORPHAN: dataset의 run 목록 조회는 성공했지만 기준 run이 더 이상 그 목록에 없다
 *   (삭제되었거나 접근 권한을 잃음).
 * - UNAVAILABLE: run 목록 자체를 조회하지 못해 위 셋 중 무엇인지 판정할 수 없다.
 */
import { i18n } from "@/shared/i18n";
import { getDataset, listDatasetRuns } from "@/features/datasets/api";
import type { EvidenceRunStatus } from "./types";

export interface EvidenceStalenessResult {
  status: EvidenceRunStatus;
  /** 판정 시점 dataset의 최신 run(확인 가능했을 때만). */
  latestRunId?: string;
  /** STALE/ORPHAN/UNAVAILABLE일 때 사람이 읽는 사유. */
  reason?: string;
  checkedAt: string;
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : i18n.t("reports.staleness.lookupFailed") };
  }
}

/**
 * @param datasetId - Report가 고정한 기준 dataset.
 * @param baseRunId - Report가 고정한 기준 run(변경하지 않음).
 * @param signal - 취소 signal.
 */
export async function checkReportEvidenceStatus(
  datasetId: string,
  baseRunId: string,
  signal?: AbortSignal,
): Promise<EvidenceStalenessResult> {
  const checkedAt = new Date().toISOString();
  const [datasetResult, runsResult] = await Promise.all([
    settle(getDataset(datasetId, signal)),
    settle(listDatasetRuns(datasetId, 50, signal)),
  ]);

  if (!runsResult.ok) {
    return {
      status: "unavailable",
      reason: i18n.t("reports.staleness.runsReloadFailed", { reason: runsResult.reason }),
      checkedAt,
    };
  }

  const stillExists = runsResult.value.runs.some((run) => run.run_id === baseRunId);
  if (!stillExists) {
    return {
      status: "orphan",
      reason: i18n.t("reports.staleness.runGone"),
      checkedAt,
    };
  }

  // Builder 응답은 최신 run이 먼저 오는 순서를 유지한다(dataset.latest_run_id와 동일 기준).
  const latestRunId = datasetResult.ok ? datasetResult.value.latest_run_id : runsResult.value.runs[0]?.run_id;

  if (latestRunId && latestRunId !== baseRunId) {
    return { status: "stale", latestRunId, reason: i18n.t("reports.staleness.newerRun", { runId: latestRunId }), checkedAt };
  }

  return { status: "current", latestRunId, checkedAt };
}
