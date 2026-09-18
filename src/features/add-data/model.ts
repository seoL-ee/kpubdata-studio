/**
 * Add Data Workbench(#250) 상태 모델.
 *
 * Source → Configure → Preview & Validate → Review & Build 4단계가 공유하는 draft
 * 형태와, 그 draft를 실제 제출 가능한 canonical `BuildSpec`으로 매핑하는 순수 함수를
 * 담는다. `NewBuildPage`의 `toBuildSpec`/`toFormValues`와 같은 역할이지만, Add Data는
 * kind(public_api/file/url)에 따라 서로 다른 필드 집합을 다뤄야 해서 별도로 둔다 —
 * 매핑 결과(`BuildSpec`)와 최종 제출 직렬화(`serializeSpec`/`toBuilderSpec`)는
 * `features/build-spec/specMapping.ts`를 그대로 재사용한다(#250 amendment 1).
 */
import { parseSourceParams } from "@/features/build-spec/paramsInput";
import { identityFromUrl } from "@/features/add-data/identity";
import { endpointHasRedactedSecret, redactUrlEndpoint, urlHasUserinfo } from "@/features/add-data/urlRedaction";
import { jsonValueHasRedactedSecret, redactSourceParamsObject, sourceParamsHasRedactedSecret } from "@/features/add-data/paramsRedaction";
import { buildSpecSchema } from "@/shared/lib/schemas";
import type { BuildSpec, JsonValue, SourceFormat, SourceKind, SourceRef } from "@/shared/lib/types";
import { i18n } from "@/shared/i18n";

/** 이 파일의 문구는 모두 `addData.model.*` 아래에 있다(#350). */
const t = (key: string): string => i18n.t(`addData.model.${key}`);

export interface PublicApiDraft {
  provider: string;
  dataset: string;
  /** JSON textarea 원문. `parseSourceParams`로 검증한다(NewBuildPage와 동일 로직 재사용). */
  sourceParams: string;
}

export interface FileDraft {
  /** 업로드 성공 후 Builder가 발급한 upload_id. 업로드 전에는 null. */
  uploadId: string | null;
  format: SourceFormat | null;
  encoding: string;
  /** 표시 전용 원본 파일명(Builder 응답의 original_filename을 그대로 보존). */
  filename: string | null;
  sizeBytes: number | null;
}

export interface UrlDraft {
  endpoint: string;
  /** url source의 format은 선택(csv/json/jsonl) — 생략하면 Builder가 Content-Type로 추론. */
  format: Extract<SourceFormat, "csv" | "json" | "jsonl"> | null;
}

export type PreviewSampleMode = "first" | "random";
export type PreviewLimit = 5 | 10 | 20;
export type PreviewColumnView = "key" | "all";

export interface AddDataDraft {
  /** YAML에서 읽은 canonical spec. GUI projection과 별도로 보존한다. */
  canonicalBase?: BuildSpec;
  /** Source 단계에서 아직 선택하지 않았으면 null. */
  sourceKind: SourceKind | null;
  publicApi: PublicApiDraft;
  file: FileDraft;
  url: UrlDraft;
  datasetId: string;
  title: string;
  description: string;
  /**
   * 사용자가 고급 설정(Dataset metadata)에서 해당 필드를 직접 수정했는지(#250 amendment 2).
   * true면 provider/dataset/파일/endpoint가 바뀌어도 자동 생성값이 더 이상 덮어쓰지 않는다
   * — `identity.ts`가 만드는 값은 어디까지나 기본값이고, 사용자가 고른 값이 항상 이긴다.
   */
  datasetIdTouched: boolean;
  titleTouched: boolean;
  descriptionTouched: boolean;
  exportFormats: string[];
  outputPath: string;
  previewLimit: PreviewLimit;
  previewSampleMode: PreviewSampleMode;
  previewColumns: PreviewColumnView;
}

export const INITIAL_DRAFT: AddDataDraft = {
  canonicalBase: undefined,
  sourceKind: null,
  publicApi: { provider: "", dataset: "", sourceParams: "{}" },
  file: { uploadId: null, format: null, encoding: "utf-8", filename: null, sizeBytes: null },
  url: { endpoint: "", format: null },
  datasetId: "",
  title: "",
  description: "",
  datasetIdTouched: false,
  titleTouched: false,
  descriptionTouched: false,
  exportFormats: ["jsonl"],
  outputPath: "",
  previewLimit: 5,
  previewSampleMode: "first",
  previewColumns: "key",
};

export interface BuildSpecResult {
  spec?: BuildSpec;
  error?: string;
}

interface CandidateResult {
  /**
   * 현재 GUI 값 + canonicalBase 보존 필드를 병합한 best-effort BuildSpec. sentinel이
   * 남아 있어도(= `error`가 함께 있어도) 존재할 수 있다 — YAML 에디터가 sentinel을
   * 실제 값으로 바꿔 붙여넣을 자리를 보여주려면 candidate 자체는 사라지면 안 된다
   * (#283 후속 리뷰 §3).
   */
  candidate?: BuildSpec;
  /** candidate를 Builder에 제출 가능한 spec으로 취급하면 안 되는 이유(있다면). */
  error?: string;
}

/**
 * draft의 GUI 값(현재 소스 kind별 입력 + canonicalBase 보존 필드)으로 candidate
 * BuildSpec을 만든다. sentinel(REDACTED) fail-closed 판정과 스키마 검증은 호출부
 * (`buildSpecFromDraft`)에서 별도로 수행한다 — 이 함수 자체는 "제출 가능 여부"가
 * 아니라 "지금 화면에 무엇을 보여줄 수 있는가"를 계산한다.
 */
function buildCandidateFromDraft(draft: AddDataDraft): CandidateResult {
  if (!draft.sourceKind) {
    return { error: t("sourceRequired") };
  }
  if (draft.exportFormats.length === 0) {
    return { error: t("exportRequired") };
  }
  if (!draft.datasetId || !draft.title || !draft.description) {
    return { error: t("metadataRequired") };
  }

  let source;
  // sentinel이 남아 있다는 사실은 기록만 해두고(sentinelError) source 자체는 계속
  // 만든다 — candidate가 있어야 YAML 에디터가 sentinel이 박힌 canonical spec을
  // 보여주고, 사용자가 그 자리를 실제 값으로 고칠 수 있다.
  let sentinelError: string | undefined;
  if (draft.sourceKind === "public_api") {
    if (!draft.publicApi.provider || !draft.publicApi.dataset) {
      return { error: t("providerDatasetRequired") };
    }
    // 저장된 초안을 복원했는데 sourceParams의 secret 값이 이미 sentinel로 지워져
    // 있으면 fail-closed — placeholder를 실제 파라미터처럼 Builder에 제출하지 않는다
    // (#283 후속 리뷰 §1). 사용자가 값을 다시 입력해야 Preview/Build가 가능하다.
    if (sourceParamsHasRedactedSecret(draft.publicApi.sourceParams)) {
      sentinelError = t("paramsRedacted");
    }
    const parsedParams = parseSourceParams(draft.publicApi.sourceParams);
    if (parsedParams.error) return { error: parsedParams.error };
    source = {
      provider: draft.publicApi.provider,
      dataset: draft.publicApi.dataset,
      params: parsedParams.data ?? {},
    };
  } else if (draft.sourceKind === "file") {
    if (!draft.file.uploadId || !draft.file.format) {
      return { error: t("uploadRequired") };
    }
    source = {
      kind: "file" as const,
      uploadId: draft.file.uploadId,
      format: draft.file.format,
      encoding: draft.file.encoding,
      params: {},
    };
  } else {
    if (!draft.url.endpoint) {
      return { error: t("endpointRequired") };
    }
    // 저장된 초안을 복원했는데 endpoint의 secret query parameter가 이미 REDACTED로
    // 지워져 있으면 fail-closed — placeholder를 실제 endpoint/credential처럼 Builder에
    // 제출하지 않는다(Epic #246). 사용자가 값을 다시 입력해야 Preview/Build가 가능하다.
    if (endpointHasRedactedSecret(draft.url.endpoint)) {
      sentinelError = t("urlRedacted");
    }
    // URL Auth(userinfo credential)는 계약에 없는 기능이다(#283 후속 리뷰 §4) —
    // `user:pass@host` 형태는 조용히 지원하는 대신 항상 오류로 막는다.
    if (urlHasUserinfo(draft.url.endpoint)) {
      return {
        error: t("urlUserInfo"),
      };
    }
    if (!/^https:\/\//i.test(draft.url.endpoint)) {
      return { error: "https:// 로 시작하는 URL만 지원합니다." };
    }
    source = {
      kind: "url" as const,
      endpoint: draft.url.endpoint,
      method: "GET" as const,
      ...(draft.url.format ? { format: draft.url.format } : {}),
      params: {},
    };
  }

  const base = draft.canonicalBase;
  const baseSource = base?.sources[0];
  const samePrimary = baseSource && (
    draft.sourceKind === (baseSource.kind ?? "public_api") &&
    (draft.sourceKind === "public_api"
      ? baseSource.provider === draft.publicApi.provider && baseSource.dataset === draft.publicApi.dataset
      : draft.sourceKind === "file"
        ? baseSource.uploadId === draft.file.uploadId
        // URL identity SSOT(hostname+path)와 동일 기준을 재사용한다 — query/userinfo/
        // fragment만 바뀌어도 identity.ts가 이미 같은 source로 취급하므로(#283 후속
        // 리뷰 §5), 여기서도 endpoint 원문 비교 대신 identityFromUrl().datasetId로
        // 비교해 alias/schema 같은 보존 필드를 잃지 않게 한다.
        : !!baseSource.endpoint &&
          identityFromUrl(baseSource.endpoint).datasetId !== "" &&
          identityFromUrl(baseSource.endpoint).datasetId === identityFromUrl(draft.url.endpoint).datasetId)
  );
  const projectedSource = source as SourceRef;
  const mergedPrimary: SourceRef = samePrimary ? { ...baseSource, ...projectedSource } : projectedSource;
  // 같은 format의 base export가 여러 개 있을 수 있으므로(#283 후속 리뷰 §7) 매번
  // `.find`로 첫 항목만 재사용하면 두 번째 이후 occurrence가 첫 occurrence의
  // options/output_path를 덮어써 버린다 — 각 base export를 index 기준으로 한 번씩만
  // consume해 occurrence별로 보존한다.
  const usedBaseExportIndices = new Set<number>();
  const exports = draft.exportFormats.map((format) => {
    const preservedIndex = base?.exports.findIndex(
      (item, index) => item.format === format && !usedBaseExportIndices.has(index),
    );
    const preserved = preservedIndex !== undefined && preservedIndex >= 0 ? base?.exports[preservedIndex] : undefined;
    if (preservedIndex !== undefined && preservedIndex >= 0) usedBaseExportIndices.add(preservedIndex);
    return {
      ...(preserved ?? {}),
      format,
      options: {
        ...(preserved?.options ?? {}),
        ...(draft.outputPath ? { outputPath: draft.outputPath } : {}),
      },
    };
  });
  const metadata: Record<string, JsonValue> = {
    ...(base?.metadata ?? {}),
    ...(draft.outputPath ? { outputPath: draft.outputPath } : {}),
  };
  const candidate: BuildSpec = {
    datasetId: draft.datasetId,
    title: draft.title,
    description: draft.description,
    sources: [mergedPrimary, ...(base?.sources.slice(1) ?? [])],
    exports,
    metadata,
    ...(base?.extra ? { extra: base.extra } : {}),
  };

  return sentinelError ? { candidate, error: sentinelError } : { candidate };
}

/**
 * 현재 draft로 소스 하나짜리 canonical BuildSpec을 만든다.
 *
 * @param draft - 현재 Add Data draft.
 * @returns 검증을 통과한 스펙 또는 한국어 오류 메시지.
 */
export function buildSpecFromDraft(draft: AddDataDraft): BuildSpecResult {
  const { candidate, error: candidateError } = buildCandidateFromDraft(draft);
  if (candidateError) return { error: candidateError };
  if (!candidate) return { error: t("specBuildFailed") };

  // 현재 GUI 값 + canonicalBase 보존 필드 + primary source merge를 모두 반영한
  // 최종 candidate에 sentinel이 남아 있는지 검사한다(#283 후속 리뷰 §2). primary
  // source를 사용자가 다시 입력했다면 위 병합에서 canonicalBase의 과거 primary
  // sentinel은 이미 덮어써져 있으므로 여기서 걸리지 않는다 — 반면 sources[1+](trailing)
  // 등 GUI가 편집하지 않는 영역에 sentinel이 남아 있으면 계속 fail-closed로 막는다.
  if (jsonValueHasRedactedSecret(candidate)) {
    return { error: t("unresolvedPlaceholder") };
  }

  const result = buildSpecSchema.safeParse(candidate);
  if (!result.success) {
    return { error: result.error.issues[0]?.message ?? t("specInvalid") };
  }
  return { spec: result.data as BuildSpec };
}

/**
 * YAML 에디터 표시 전용 — 제출 가능 여부(sentinel fail-closed, 스키마 검증)와
 * 무관하게 지금 draft로 보여줄 수 있는 canonical BuildSpec을 만든다(#283 후속
 * 리뷰 §3). sentinel이 남아 있어도 candidate 자체는 반환해, 사용자가 YAML에서
 * sentinel을 실제 값으로 교체해 다시 Apply할 자리를 잃지 않게 한다. Preview/Build
 * 제출에는 절대 쓰지 않는다 — 그쪽은 항상 `buildSpecFromDraft`를 거친다.
 */
export function buildEditableSpecFromDraft(draft: AddDataDraft): BuildSpec | undefined {
  return buildCandidateFromDraft(draft).candidate;
}

/**
 * BuildSpec(YAML 에디터에서 파싱된 결과 등)을 draft에 되반영한다.
 *
 * `buildSpecFromDraft`의 역방향 — YAML 탭에서 소스 kind 자체를 바꿔 붙여넣었을 수도
 * 있으므로 `sources[0].kind` 기준으로 draft의 kind별 bucket을 다시 채운다. Preview/식별
 * 필드(previewLimit 등)처럼 canonical BuildSpec에 없는 draft 전용 값은 그대로 둔다.
 *
 * @param draft - 되반영할 대상 draft.
 * @param spec - YAML 에디터 등에서 얻은 BuildSpec.
 * @returns 소스/식별/출력 필드가 spec 기준으로 갱신된 새 draft.
 */
export function applyBuildSpecToDraft(draft: AddDataDraft, spec: BuildSpec): AddDataDraft {
  const source = spec.sources[0];
  const kind: SourceKind = source?.kind ?? "public_api";

  const next: AddDataDraft = {
    ...draft,
    sourceKind: kind,
    datasetId: spec.datasetId,
    title: spec.title,
    description: spec.description,
    canonicalBase: spec,
    // YAML/canonical BuildSpec 편집은 고급 설정과 동급의 명시적 편집으로 취급한다 —
    // 이후 provider/dataset/파일/URL이 바뀌어도 자동 생성값이 이 값을 덮어쓰지 않는다.
    datasetIdTouched: true,
    titleTouched: true,
    descriptionTouched: true,
    exportFormats: spec.exports.map((e) => e.format),
    outputPath: typeof spec.metadata.outputPath === "string" ? spec.metadata.outputPath : draft.outputPath,
  };

  if (kind === "public_api") {
    next.publicApi = {
      provider: source?.provider ?? "",
      dataset: source?.dataset ?? "",
      sourceParams: source && Object.keys(source.params).length > 0
        ? JSON.stringify(source.params, null, 2)
        : "{}",
    };
  } else if (kind === "file") {
    next.file = {
      uploadId: source?.uploadId ?? null,
      format: source?.format ?? null,
      encoding: source?.encoding ?? "utf-8",
      filename: draft.file.filename,
      sizeBytes: draft.file.sizeBytes,
    };
  } else {
    next.url = {
      endpoint: source?.endpoint ?? "",
      format: (source?.format as UrlDraft["format"]) ?? null,
    };
  }

  return next;
}

/**
 * draft + preview 옵션의 서명(signature)을 만든다.
 *
 * Preview/Validate를 실행한 시점의 서명과 현재 서명이 다르면 "stale preview"로 간주해
 * Build를 막는다(`NewBuildPage`의 `validatedSnapshotRef` 패턴과 동일한 발상, #72).
 * 컬럼 뷰(key/all)·diff 화면 전환처럼 이미 받아온 응답을 다시 그리기만 하는 토글은
 * 새 Preview 호출이 필요 없으므로 서명에서 제외한다.
 */
/**
 * 표시 전용 — canonical BuildSpec에서 url source의 endpoint, public_api source의
 * params를 secret-redacted 버전으로 바꾼 사본을 만든다(PR #283 리뷰 대응, Epic #246,
 * 후속 리뷰 §1). Review 화면의 "실제 제출될 canonical BuildSpec" preview에만 쓰며,
 * 실제 Builder 제출에 쓰이는 spec 객체는 이 함수를 거치지 않고 `buildSpecFromDraft`
 * 결과를 그대로 쓴다.
 */
export function redactBuildSpecForDisplay(spec: BuildSpec): BuildSpec {
  return {
    ...spec,
    sources: spec.sources.map((source) => {
      if (source.kind === "url" && source.endpoint) {
        return { ...source, endpoint: redactUrlEndpoint(source.endpoint).endpoint };
      }
      const { params } = redactSourceParamsObject(source.params ?? {});
      return { ...source, params };
    }),
  };
}

export function draftSignature(draft: AddDataDraft): string {
  const specResult = buildSpecFromDraft(draft);
  return JSON.stringify({
    spec: specResult.spec ?? specResult.error,
    limit: draft.previewLimit,
    sampleMode: draft.previewSampleMode,
  });
}
