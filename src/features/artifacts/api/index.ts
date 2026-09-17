/**
 * 빌드 결과 아티팩트/manifest 조회 API 진입점.
 *
 * mock 모드에서는 결정적 mock manifest를 반환해 뷰어 UI를 개발/검증할 수 있게 한다.
 * 실연동 모드(`VITE_USE_REAL_BUILDER=true`)에서는 Builder
 * `GET /builds/{run_id}/manifest`의 authoritative manifest 본문을 그대로 반환한다.
 * mock 모드에서만 결정적 fixture manifest를 사용한다.
 */
import { i18n } from "@/shared/i18n";
import { findDemoDataset } from "@/shared/lib/demoDatasets";
import { builderApi, isRealBuilderEnabled } from "@/shared/lib/builderApi";
import type { BuildManifest } from "@/shared/lib/types";

import type { ExportTarget } from "@/shared/lib/types";

/** Builder manifest의 additive field를 API 경계에서만 보존하는 응답 타입. */
export type AuthoritativeBuildManifest =
  | BuildManifest
  | (BuildManifest & Record<string, unknown>);

/**
 * export 형식별 산출물 파일 확장자. specMapping의 output_path 규칙과 동일하게 맞춰
 * (`.../data.<ext>`) mock/실연동 manifest의 파일 목록 표기를 일관되게 유지한다.
 * huggingface는 파일이 아닌 리포지토리 레이아웃이라 데이터 파일을 생성하지 않는다.
 */
const EXPORT_EXTENSION: Record<string, string> = {
  jsonl: "jsonl",
  markdown: "md",
  parquet: "parquet",
  huggingface: "",
};

function exportExtension(target: ExportTarget): string {
  return EXPORT_EXTENSION[target.format] ?? target.format;
}

/**
 * 빌드 ID 기반의 결정적 mock manifest를 만든다(#30, #29 연동 전 임시).
 *
 * @param buildId - 빌드 실행 ID.
 * @returns mock BuildManifest.
 */
function mockManifest(buildId: string): BuildManifest {
  const dataset = findDemoDataset(buildId);
  const sourceKey = `datago.${dataset.providerDataset}`;
  const succeeded = dataset.status === "succeeded";

  return {
    schema_version: "1.0.0",
    build_id: buildId,
    started_at: dataset.startedAt,
    finished_at: dataset.finishedAt, // undefined를 허용
    build_environment: {
      python_version: "3.12.3",
      kpubdata_version: "0.4.0",
      builder_version: "0.4.0",
    },
    inputs: succeeded ? [sourceKey] : undefined,
    inputs_fingerprint: succeeded
      ? `sha256:${dataset.slug.replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`
      : null,
    outputs: succeeded
      ? [
          ...dataset.exports
            .filter((target) => target.format !== "huggingface")
            .map(
              (target) =>
                `artifacts/builds/${buildId}/data.${exportExtension(target)}`,
            ),
          `artifacts/builds/${buildId}/README.md`,
          `artifacts/builds/${buildId}/manifest.json`,
        ]
      : undefined,
    warnings: undefined,
    errors: dataset.errors,
    row_counts: succeeded ? { [sourceKey]: dataset.recordCount } : undefined,
    schema_summaries: succeeded
      ? {
          [sourceKey]: {
            fields: dataset.fields,
            total_fields: dataset.fields.length,
          },
        }
      : undefined,
    provenance: succeeded
      ? [
          {
            provider: "datago",
            dataset: dataset.providerDataset,
            fetched_at: dataset.finishedAt ?? dataset.startedAt,
            record_count: dataset.recordCount,
            data_checksum: `sha256:${dataset.slug.replace(/-/g, "").padEnd(64, "1").slice(0, 64)}`,
            api_version: "unknown",
            params: dataset.params,
          },
        ]
      : undefined,
  };
}

/**
 * 특정 빌드 실행의 manifest 정보를 조회한다.
 *
 * 실연동 모드면 Builder `GET /builds/{run_id}/manifest`의 authoritative 본문을,
 * mock 모드면 결정적 fixture manifest를 반환한다.
 *
 * @param buildId - 조회 대상 빌드 실행 ID.
 * @param signal - 취소용 AbortSignal(선택).
 * @returns 빌드 manifest 정보.
 */
export async function getBuildManifest(
  buildId: string,
  signal?: AbortSignal,
): Promise<AuthoritativeBuildManifest> {
  if (!isRealBuilderEnabled()) {
    return mockManifest(buildId);
  }

  const result = await builderApi.getBuildManifest(buildId, signal);
  return result as AuthoritativeBuildManifest;
}

/**
 * 다운로드 가능한 산출물 파일 목록을 조회한다 — `GET /artifacts/{run_id}`.
 *
 * 이 목록의 각 경로가 **canonical artifact identifier**다: exact run 워크스페이스 기준
 * POSIX 상대 경로이고, output_root/절대경로/OS 구분자를 포함하지 않는다. 다운로드는
 * 반드시 이 값을 써야 한다 — `manifest.outputs`는 filesystem storage 경로(절대경로 +
 * OS 구분자)라 다운로드 식별자로 쓸 수 없다.
 *
 * @returns run 디렉터리 기준 상대 파일 경로 배열.
 */
export async function listArtifactFiles(
  runId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!isRealBuilderEnabled()) {
    // mock 모드: 실제 워크스페이스가 없으므로 결정적 fixture manifest의 output 목록을
    // 그대로 쓴다(이미 상대 POSIX 경로 형태다).
    return mockManifest(runId).outputs ?? [];
  }
  const result = await builderApi.artifacts(runId, signal);
  return result.files;
}

/**
 * 특정 실행의 개별 산출물 파일을 인증된 Builder 요청으로 받아온다.
 *
 * `filePath`는 반드시 `listArtifactFiles`(= `GET /artifacts/{run_id}`)가 준 canonical
 * run-relative POSIX 경로여야 한다 — Studio에서 경로 문자열을 변형하지 않는다.
 * `builderApi.downloadArtifactFile`이 세그먼트별로만 URL 인코딩한다. mock 모드에는
 * 실제 파일이 없으므로 지어내지 않고 명시적으로 지원하지 않음을 알린다.
 */
export async function downloadArtifact(
  runId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  if (!isRealBuilderEnabled()) {
    throw new Error(
      i18n.t("artifacts.mockNoDownload"),
    );
  }
  return builderApi.downloadArtifactFile(runId, filePath, signal);
}

/** Blob을 받아 원래 파일명으로 브라우저 다운로드를 트리거하고 object URL을 정리한다. */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}
