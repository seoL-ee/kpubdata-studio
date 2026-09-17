/**
 * 빌드 결과 미리보기 API 진입점 (#93).
 *
 * 실연동 모드(`VITE_USE_REAL_BUILDER=true`)면 Builder `/preview`를 호출하고, 아니면
 * UI 개발/검증용 결정적 mock 데이터를 반환한다. Builder가 반환한 소스별 샘플 행과 스키마를
 * UI가 바로 사용할 수 있는 `{ rows, schema }` 형태로 변환한다(runs/api의 실연동 분기 패턴과 동일).
 */
import { i18n } from "@/shared/i18n";
import { serializeSpec } from "@/features/build-spec/specMapping";
import {
  builderApi,
  isRealBuilderEnabled,
  type PreviewResponse,
} from "@/shared/lib/builderApi";
import type { BuildSpec } from "@/shared/lib/types";

export interface PreviewSourceFailure {
  sourceKey: string;
  error: string;
}

export class PreviewSourceFailureError extends Error {
  constructor(readonly failures: PreviewSourceFailure[]) {
    super(i18n.t("preview.allSourcesFailed", { failures: formatFailures(failures) }));
    this.name = "PreviewSourceFailureError";
  }
}

/** 미리보기 결과(샘플 행 배열과 컬럼명→타입 스키마 맵). */
export interface PreviewResult {
  rows: Record<string, unknown>[];
  schema: Record<string, string>;
  warnings: PreviewSourceFailure[];
}

/** mock 모드에서 보여줄 결정적 샘플 행. */
const MOCK_ROWS: Record<string, unknown>[] = [
  { region: "서울", value: 42, measured_at: "2026-06-21T09:00:00Z" },
  { region: "부산", value: 37, measured_at: "2026-06-21T09:00:00Z" },
  { region: "대구", value: 51, measured_at: "2026-06-21T09:00:00Z" },
];

/** mock 모드에서 보여줄 결정적 컬럼 스키마. */
const MOCK_SCHEMA: Record<string, string> = {
  region: "string",
  value: "int64",
  measured_at: "string",
};

function formatFailures(failures: readonly PreviewSourceFailure[]): string {
  return failures.map((failure) => `${failure.sourceKey}: ${failure.error}`).join("; ");
}

function sourceFailure(source: PreviewResponse["previews"][number]): PreviewSourceFailure {
  return {
    sourceKey: source.source_key,
    error: source.error ?? i18n.t("preview.unknownSourceError"),
  };
}

/**
 * Builder /preview 응답을 UI가 쓰는 `{ rows, schema }`로 변환한다.
 *
 * /preview는 소스별 배열(`previews`)을 반환한다. 미리보기 화면은 단일 표를 보여주므로
 * 첫 번째 성공 소스를 대표로 사용한다(소스가 없으면 빈 결과).
 *
 * @param response - Builder /preview 응답.
 * @returns 대표 소스의 샘플 행과 컬럼명→타입 스키마.
 */
function transformPreviewResponse(response: PreviewResponse): PreviewResult {
  const source = response.previews.find((preview) => preview.status === "ok");
  if (!source) {
    const failures = response.previews.map(sourceFailure);
    if (failures.length > 0) throw new PreviewSourceFailureError(failures);
    return { rows: [], schema: {}, warnings: [] };
  }

  const warnings = response.previews
    .filter((preview) => preview.status === "failed")
    .map(sourceFailure);

  const schema: Record<string, string> = {};
  for (const column of source.schema) {
    schema[column.name] = column.dtype;
  }
  return { rows: source.sample, schema, warnings };
}

/**
 * 현재 빌드 스펙으로 미리보기 데이터를 요청한다.
 *
 * @param spec - 미리보기를 생성할 대상 빌드 스펙.
 * @param signal - 취소용 AbortSignal(선택).
 * @returns 샘플 행 배열과 컬럼 스키마 맵.
 */
export async function previewBuild(spec: BuildSpec, signal?: AbortSignal): Promise<PreviewResult> {
  if (!isRealBuilderEnabled()) {
    return { rows: MOCK_ROWS, schema: MOCK_SCHEMA, warnings: [] };
  }

  const response = await builderApi.preview(serializeSpec(spec), undefined, signal);
  return transformPreviewResponse(response);
}

/**
 * 현재 빌드 스펙으로 Builder `/preview`의 전체 응답(소스별 statistics/quality_results/
 * diff 포함)을 요청한다 (#497, #250). `previewBuild`는 단일 대표 소스를 `{rows,schema}`로
 * 평탄화하지만, Add Data Workbench의 Preview & Validation/Diff 화면은 소스별 원본
 * 응답 전체(diff_available/sample_mode/quality_results 등)가 그대로 필요해 별도로 둔다.
 *
 * mock 모드에서는 네트워크를 타지 않고 결정적 mock 응답을 반환한다.
 *
 * @param spec - 미리보기를 생성할 대상 빌드 스펙.
 * @param options - limit(1~1000, 기본 5)/sample_mode(first|random)/seed.
 * @param signal - 취소용 AbortSignal(선택).
 * @returns Builder `/preview`의 원본(Zod 검증된) 응답.
 */
export async function previewBuildDetailed(
  spec: BuildSpec,
  options?: { limit?: number; sample_mode?: "first" | "random"; seed?: number },
  signal?: AbortSignal,
): Promise<PreviewResponse> {
  if (!isRealBuilderEnabled()) {
    return {
      dataset_id: spec.datasetId,
      previews: [
        {
          source_key: spec.sources[0]?.alias || spec.sources[0]?.dataset || "source",
          status: "ok",
          error: null,
          schema: [
            { name: "region", dtype: "string", nullable: false, unique_count: 3 },
            { name: "value", dtype: "int64", nullable: true, unique_count: 3 },
          ],
          sample: MOCK_ROWS,
          total_rows: MOCK_ROWS.length,
          statistics: { row_count: MOCK_ROWS.length, null_counts: { region: 0, value: 0 }, duplicate_rate: 0 },
          quality_results: [],
          source_sample: MOCK_ROWS,
          sample_mode: options?.sample_mode ?? "first",
          diff_available: false,
          diffs: [],
          transform_summary: null,
          diff_truncated: false,
        },
      ],
    };
  }

  return builderApi.preview(serializeSpec(spec), options, signal);
}
