/**
 * Run stage detail 조회와 그 표현 헬퍼 (#379로 BuildsPage에서 분리).
 */
import { useEffect, useState } from "react";

import { getBuildStageDetail } from "@/features/datasets/api";
import { DATASET_STAGES } from "@/features/datasets/model";
import { firstFailedStage } from "@/features/runs/model";
import type { AsyncState } from "@/features/runs/asyncState";
import type {
  RunStageEntry,
  RunStagesResponse,
  StageDetailResponse,
} from "@/shared/lib/builderApi";

/**
 * Pipeline / Stage Progress 시각화(#255 후속 보완 §6).
 *
 * Bronze/Silver/Gold만 정본 Stage로 취급한다 — Source/Output은 그 자체로는 Stage 상태가
 * 아니라 문맥/endpoint 표현이며, Validate·Artifact 같은 새 Stage를 만들지 않는다.
 */
export type StageName = (typeof DATASET_STAGES)[number];

export type StageDetailEntry =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: StageDetailResponse }
  | { status: "error" };

export function stageDetailKey(sourceKey: string, stage: StageName): string {
  return `${sourceKey}:${stage}`;
}

/** entry가 실제로 요청한 stage의 detail을 담고 있을 때만 그 타입으로 좁혀서 돌려준다. */
export function pickStageDetail<S extends StageName>(
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
export function useStageDetails(runId: string, stagesState: AsyncState<RunStagesResponse>): Record<string, StageDetailEntry> {
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
export function isUnreachedStage(source: RunStageEntry, stage: StageName): boolean {
  const failedAt = firstFailedStage(source);
  if (!failedAt || source[stage].status !== "not_run") return false;
  return DATASET_STAGES.indexOf(stage) > DATASET_STAGES.indexOf(failedAt);
}

export function formatRecordCount(
  value: number | null,
  t: (key: string) => string,
): string {
  return value === null ? "N/A" : `${value.toLocaleString("ko-KR")}${t("builds.data.rowsUnit")}`;
}
