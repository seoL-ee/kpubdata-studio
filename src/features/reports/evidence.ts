/**
 * Report 기준 Builder evidence 조회 (#258).
 *
 * `features/kubi/evidence.ts`(#256)와 같은 패턴을 따른다 — 여러 Builder 엔드포인트를
 * 병렬/순차로 호출하되, 하나가 실패해도 나머지는 그대로 쓴다("부분 실패 허용", #258 §5).
 * 새 Builder 엔드포인트를 만들지 않고 `features/datasets/api`(#256/#253/#254가 이미
 * 검증한 client)만 재사용한다.
 *
 * Output(산출물) evidence는 실연동 모드에서만 조회한다 — mock 모드의 `getBuildManifest`는
 * run_id와 무관한 별도 데모 카탈로그(`shared/lib/demoDatasets.ts`)로 폴백하기 때문에,
 * 그대로 쓰면 이 dataset/run과 상관없는 파일 목록을 evidence처럼 보여주게 된다(#258 §4 —
 * 없는 정보를 추측해서 만들지 않는다).
 */
import {
  getBuildQuality,
  getBuildStageDetail,
  getDataset,
  listBuildStages,
  listDatasetRuns,
} from "@/features/datasets/api";
import { getBuildManifest } from "@/features/artifacts/api";
import { isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type {
  BuildQualityResponse,
  DatasetDetailResponse,
  DatasetRunSummary,
  RunStagesResponse,
  StageDetailResponse,
} from "@/shared/lib/builderApi";
import type { ReportEvidenceRef } from "./types";

/** silver StageDetailResponse의 schema 배열 원소 타입(별도 export 타입이 없어 판별 유니온에서 추출). */
type SilverColumnInfo = Extract<StageDetailResponse, { stage: "silver" }>["schema"][number];

type Settled<T> = { ok: true; value: T } | { ok: false; reason: string };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : "조회에 실패했습니다." };
  }
}

export interface ReportSourceSchema {
  sourceKey: string;
  /** silver schema를 온전히 얻었으면 "silver", gold column 이름만 얻었으면 "gold_names_only" */
  origin: "silver" | "gold_names_only" | "unavailable";
  columns: SilverColumnInfo[];
  /** gold_names_only일 때만 채워지는, dtype 정보가 없는 컬럼 이름 목록 */
  columnNamesOnly?: string[];
  reason?: string;
}

export interface ReportOutputEvidence {
  files: string[];
}

export interface ReportEvidenceBundle {
  fetchedAt: string;
  datasetId: string;
  runId: string;
  dataset: Settled<DatasetDetailResponse>;
  /** listDatasetRuns 응답에서 runId와 일치하는 항목(spec_digest/시각 등). run 자체가 삭제/접근불가면 실패로 표시. */
  run: Settled<DatasetRunSummary>;
  stages: Settled<RunStagesResponse>;
  quality: Settled<BuildQualityResponse>;
  schemas: Record<string, ReportSourceSchema>;
  output: Settled<ReportOutputEvidence>;
}

async function fetchSourceSchema(runId: string, sourceKey: string, signal?: AbortSignal): Promise<ReportSourceSchema> {
  const silver = await settle(getBuildStageDetail(runId, "silver", sourceKey, 1, signal));
  if (silver.ok && silver.value.stage === "silver" && silver.value.available && silver.value.schema.length > 0) {
    return { sourceKey, origin: "silver", columns: silver.value.schema };
  }

  const gold = await settle(getBuildStageDetail(runId, "gold", sourceKey, 1, signal));
  if (gold.ok && gold.value.stage === "gold" && gold.value.available && gold.value.columns.length > 0) {
    return { sourceKey, origin: "gold_names_only", columns: [], columnNamesOnly: gold.value.columns };
  }

  const reason = !silver.ok && !gold.ok
    ? "silver/gold schema 조회에 모두 실패했습니다."
    : "이 source는 아직 schema를 만들 수 있는 stage까지 진행되지 않았습니다.";
  return { sourceKey, origin: "unavailable", columns: [], reason };
}

/**
 * 기준 dataset/run에 대한 evidence를 한 번에 모은다.
 *
 * @param datasetId - Report의 기준 dataset.
 * @param runId - Report가 고정한 기준 run(baseRunId). 최신 run으로 자동 대체하지 않는다.
 * @param signal - 취소 signal.
 */
export async function fetchReportEvidence(
  datasetId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ReportEvidenceBundle> {
  const [datasetResult, runsResult, stagesResult, qualityResult] = await Promise.all([
    settle(getDataset(datasetId, signal)),
    settle(listDatasetRuns(datasetId, 50, signal)),
    settle(listBuildStages(runId, signal)),
    settle(getBuildQuality(runId, signal)),
  ]);

  const runResult: Settled<DatasetRunSummary> = runsResult.ok
    ? (() => {
        const match = runsResult.value.runs.find((run) => run.run_id === runId);
        return match ? { ok: true, value: match } : { ok: false, reason: "이 dataset의 run 목록에서 기준 run을 찾을 수 없습니다(삭제되었거나 접근할 수 없음)." };
      })()
    : { ok: false, reason: runsResult.reason };

  const sourceKeys = stagesResult.ok
    ? stagesResult.value.sources.map((s) => s.source_key)
    : datasetResult.ok
      ? Object.keys(datasetResult.value.stages)
      : [];

  const schemaEntries = await Promise.all(
    sourceKeys.map(async (sourceKey) => [sourceKey, await fetchSourceSchema(runId, sourceKey, signal)] as const),
  );
  const schemas: Record<string, ReportSourceSchema> = Object.fromEntries(schemaEntries);

  const output: Settled<ReportOutputEvidence> = isRealBuilderEnabled()
    ? await settle(getBuildManifest(runId, signal).then((manifest) => ({ files: manifest.outputs ?? [] })))
    : { ok: false, reason: "mock/demo 모드에서는 이 run에 실제로 대응하는 output evidence를 제공하지 않습니다." };

  return {
    fetchedAt: new Date().toISOString(),
    datasetId,
    runId,
    dataset: datasetResult,
    run: runResult,
    stages: stagesResult,
    quality: qualityResult,
    schemas,
    output,
  };
}

/** evidence bundle에서 실제로 확인된 조각만 안정적 참조 목록으로 만든다(확인 못한 항목은 포함하지 않음). */
export function buildEvidenceRefs(evidence: ReportEvidenceBundle): ReportEvidenceRef[] {
  const refs: ReportEvidenceRef[] = [];
  if (evidence.dataset.ok) {
    refs.push({ kind: "dataset", id: evidence.datasetId, label: evidence.dataset.value.title });
  }
  if (evidence.run.ok) {
    refs.push({ kind: "run", id: evidence.runId, label: `Run ${evidence.runId}` });
  }
  if (evidence.quality.ok) {
    refs.push({ kind: "quality", id: evidence.runId, label: "Quality" });
  }
  for (const [sourceKey, schema] of Object.entries(evidence.schemas)) {
    if (schema.origin !== "unavailable") refs.push({ kind: "schema", id: sourceKey, label: `Schema · ${sourceKey}` });
  }
  if (evidence.stages.ok) {
    for (const source of evidence.stages.value.sources) {
      refs.push({ kind: "stage", id: source.source_key, label: `Stage · ${source.source_key}` });
    }
  }
  if (evidence.output.ok) {
    refs.push({ kind: "output", id: evidence.runId, label: "Output" });
  }
  return refs;
}
