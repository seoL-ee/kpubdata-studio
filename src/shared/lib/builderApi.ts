import { i18n } from "@/shared/i18n";
/**
 * Builder HTTP API 클라이언트 (#29).
 *
 * kpubdata-builder service(`service/app.py`)가 실제로 제공하는 엔드포인트
 * (`/version`, `/validate`, `/preview`, `/build`, `/artifacts/{run_id}`)를 감싼다.
 * Builder API 계약(API_CONTRACT.md / builder #209)의 와이어 형태에 맞춰 요청/응답
 * 타입을 정의하고, 비정상 응답은 구조화된 `ApiError`로 던진다.
 *
 * 라이브 Builder 없이도 Studio가 동작하도록, 기본값은 mock이며 실제 호출은
 * `VITE_USE_REAL_BUILDER=true`일 때만 활성화된다(각 feature 모듈에서 분기).
 *
 * 주의: validate/preview/build는 Builder가 BuildSpec YAML(snake_case)을 기대하므로,
 * Studio BuildSpec(camelCase) → Builder 스펙 매핑(#37)이 선행되어야 완전히 연결된다.
 * 이 모듈은 그 매핑이 끝난 스펙 텍스트를 받는 저수준 계약 계층이다.
 *
 * 런타임 타입 검증 (#158, #103):
 * - 모든 응답은 Zod 스키마로 런타임 검증된다.
 * - as T 캐스팅 대신 zod.parse()를 사용하여 타입 안정성을 보장한다.
 */
import { API_BASE } from "@/shared/config/env";
import * as schemas from "./builderApi.schema";
import { z } from "zod";

/**
 * Studio의 현재 통합 표면(async build job + cooperative cancel + manifest
 * status/partial + provider credential + monitoring + publish)이 요구하는 **최소**
 * Builder API 버전이다. exact contract pin이 아니다 — Builder ADR 0013에 따라
 * Studio는 "같은 major, server >= 이 최소값"이면 호환으로 간주하고, 더 높은
 * additive minor/patch(1.19~1.21 등)는 그대로 허용한다.
 *
 * cancellation(POST /builds/{id}/cancel)과 manifest status/partial 필드는 Builder
 * 1.18.0에서 도입됐고 Studio가 실제로 이 둘을 사용하므로, 통합 표면의 최소값은
 * 1.18.0이다. 1.19~1.21에 추가된 미사용 endpoint는 이 최소값에 반영하지 않으며
 * Studio에 별도로 구현하지도 않는다.
 */
export const MIN_BUILDER_API_VERSION = "1.18.0";

/** `major.minor.patch` 세 부분으로 파싱한다. 형식이 어긋나면 null(fail-closed 신호). */
function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Builder가 보고한 `api_version`이 Studio 통합 표면과 호환되는지 판정한다 (ADR 0013).
 *
 * 규칙:
 * - server major == required major (major가 다르면 breaking — 2.0.0은 비호환)
 * - server >= required (같은 major 안에서 minor/patch가 최소값 이상)
 * - 더 높은 additive minor/patch는 호환 (1.21.0 OK)
 * - 파싱 불가/형식 오류는 fail-closed로 비호환 처리
 *
 * @param serverVersion - GET /version 응답의 `api_version`.
 * @param requiredVersion - 요구 최소 버전(기본 MIN_BUILDER_API_VERSION).
 */
export function isBuilderApiCompatible(
  serverVersion: string | undefined | null,
  requiredVersion: string = MIN_BUILDER_API_VERSION,
): boolean {
  if (!serverVersion) return false;
  const server = parseSemver(serverVersion);
  const required = parseSemver(requiredVersion);
  if (!server || !required) return false;
  if (server[0] !== required[0]) return false;
  for (let i = 0; i < 3; i++) {
    if (server[i] > required[i]) return true;
    if (server[i] < required[i]) return false;
  }
  return true;
}

/** 실제 Builder 호출 활성화 여부(미설정 시 mock 사용). */
export function isRealBuilderEnabled(): boolean {
  return import.meta.env.VITE_USE_REAL_BUILDER === "true";
}

/** Builder가 반환한 비정상 응답을 표현하는 구조화 에러. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** 자동 타임아웃(ms). 미지정 시 DEFAULT_TIMEOUT_MS. 0 이하이면 타임아웃 비활성화. */
  timeoutMs?: number;
  /** 네트워크 오류·5xx 발생 시 추가 재시도 횟수(지수 백오프). 미지정 시 DEFAULT_RETRIES. */
  retries?: number;
  /** 인증 헤더 생략 (/healthz 등 무인증 엔드포인트, #186). */
  skipAuth?: boolean;
}

/**
 * Builder 요청에 붙일 Bearer 토큰을 제공하는 provider (#186).
 * null을 반환하면 해당 요청에 Authorization 헤더를 붙이지 않는다 —
 * mock 모드·미로그인 상태에서 빈 헤더가 나가는 것을 방지한다.
 *
 * OIDC 연동에서는 provider가 요청 직전 `keycloak.updateToken()`으로 만료 임박 토큰을
 * 갱신하므로 Promise를 반환할 수 있다 — apiFetch는 값을 await한 뒤 헤더를 붙인다.
 */
export type AuthTokenProvider = () => string | null | Promise<string | null>;

// Studio는 서버가 없는 정적 SPA라 토큰을 메모리(zustand 스토어)에만 보관한다 (#187 예정).
// apiFetch는 주입받은 provider를 통해 그 토큰을 읽는다 — 전역을 직접 참조하면 테스트가 어렵다.
let authTokenProvider: AuthTokenProvider | null = null;

/**
 * Builder 요청에 붙일 Bearer 토큰 provider를 등록한다 (#186).
 * provider를 null로(또는 해제) 두면 인증 헤더가 나가지 않아, 미로그인/mock 모드에서
 * 기존 요청 형태와 완전히 동일하게 동작한다(회귀 없음).
 */
export function setAuthTokenProvider(provider: AuthTokenProvider | null): void {
  authTokenProvider = provider;
}

export type AuthErrorCallback = () => void;

let authErrorCallback: AuthErrorCallback | null = null;

export function setAuthErrorCallback(cb: AuthErrorCallback | null): void {
  authErrorCallback = cb;
}

/** 자동 타임아웃 기본값(ms). Builder /build는 외부 API를 호출해 느릴 수 있어 넉넉히 잡는다. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 네트워크 오류·5xx에 대한 기본 재시도 횟수(최초 시도 외 추가 횟수). */
export const DEFAULT_RETRIES = 2;

/** 타임아웃으로 요청이 중단됐는지 식별하는 ApiError 상태값. */
const TIMEOUT_STATUS = 408;

/** 재시도 사이 지수 백오프 지연(ms)을 만든다. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 사용자 취소 signal과 타임아웃 signal을 결합해, 둘 중 먼저 발화하는 쪽이 요청을 중단하게 한다.
 *
 * @param signal - 호출자가 넘긴 취소 signal(선택).
 * @param timeoutMs - 자동 타임아웃(ms). 0 이하이면 타임아웃 없이 signal만 사용한다.
 * @returns 결합된 signal과, 타임아웃 타이머를 해제하는 cleanup 함수.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs <= 0) return { signal, cleanup: () => {} };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
  const cleanup = () => clearTimeout(timer);

  if (!signal) return { signal: controller.signal, cleanup };
  if (signal.aborted) {
    cleanup();
    return { signal, cleanup: () => {} };
  }
  // 사용자 취소가 발생하면 타임아웃 컨트롤러도 함께 중단해 fetch를 즉시 끊는다.
  signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return { signal: controller.signal, cleanup };
}

/** 타임아웃 때문에 발생한 abort인지 판별한다(사용자 취소와 구분). */
function isTimeoutAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "TimeoutError";
}

/**
 * Builder API에 JSON 요청을 보내고 JSON 응답을 파싱한다.
 *
 * 네트워크 일시 장애와 5xx에는 지수 백오프로 제한 재시도하고(#94), 응답이 없을 경우
 * UI가 무한 대기에 빠지지 않도록 자동 타임아웃을 건다(#94). 호출자 취소 signal은 그대로 존중한다.
 *
 * 런타임 타입 검증 (#158, #103):
 * - 스키마가 제공되면 Zod로 런타임 검증을 수행한다.
 * - 검증 실패 시 ApiError를 던진다.
 *
 * @param path - 선행 슬래시를 포함한 엔드포인트 경로(예: "/version").
 * @param options - 메서드/바디/취소 시그널/타임아웃/재시도.
 * @param schema - 응답을 검증할 Zod 스키마 (선택).
 * @returns 파싱된 응답 본문.
 * @throws ApiError 응답이 2xx가 아니거나 네트워크/파싱/타임아웃/스키마 검증 오류가 발생한 경우.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
  schema?: z.ZodSchema<T>,
): Promise<T> {
  const {
    method = "GET",
    body,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = options;

  let response: Response | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { signal: combined, cleanup } = withTimeout(signal, timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    try {
      if (!options.skipAuth) {
        const token = (await authTokenProvider?.()) ?? null;
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      response = await fetch(`${API_BASE}${path}`, {
        method,
        signal: combined,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      cleanup();
      // 호출자가 명시적으로 취소한 경우엔 재시도하지 않고 그대로 전파한다.
      if (signal?.aborted) throw cause;
      if (isTimeoutAbort(cause)) {
        if (attempt < retries) {
          await delay(500 * 2 ** attempt);
          continue;
        }
        throw new ApiError(TIMEOUT_STATUS, i18n.t("api.timeout"), cause);
      }
      // 네트워크 오류: 남은 재시도가 있으면 백오프 후 다시 시도한다.
      if (attempt < retries) {
        await delay(500 * 2 ** attempt);
        continue;
      }
      throw new ApiError(0, i18n.t("api.connFail"), cause);
    }
    cleanup();

    // 5xx는 일시 장애일 수 있어 제한 재시도한다. 4xx는 즉시 처리(재시도 무의미).
    if (response.status >= 500 && attempt < retries) {
      await delay(500 * 2 ** attempt);
      response = undefined;
      continue;
    }
    break;
  }

  if (!response) {
    throw new ApiError(0, i18n.t("api.connFail"));
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!response.ok) throw new ApiError(response.status, text);
      throw new ApiError(response.status, i18n.t("api.badJson"));
    }
  }

  if (!response.ok) {
    if (response.status === 401 && authErrorCallback) {
      authErrorCallback();
    }
    const message = formatApiErrorMessage(response.status, parsed);
    throw new ApiError(response.status, message, parsed);
  }

  // Zod 스키마로 런타임 타입 검증 (#158, #103)
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // 스키마 불일치 시 사용자에게 표시 가능한 명시적 에러 (#159)
      const errorDetails = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `\`${issue.path.join(".")}\`` : i18n.t("api.schemaDefault");
        const message = issue.message || i18n.t("api.schemaIssueDefault");
        return `${path}: ${message}`;
      }).join(", ");

      throw new ApiError(
        500,
        i18n.t("api.schemaMismatch", { details: errorDetails }),
        parsed,
      );
    }
    return result.data;
  }

  // 스키마가 없는 경우 (하위 호환): as T 캐스팅만 수행
  return parsed as T;
}

/**
 * Builder의 비정상 응답 본문에서 사람이 읽을 메시지를 추출한다.
 *
 * 우선순위(하위 호환 유지):
 *   1) 최상위 `error` 필드(있으면 그대로 사용 — builder PR이 추가 중).
 *   2) `outcomes[].error` — 실패한 소스별 사유(join). /build 502의 실제 와이어 형태.
 *
 * @param parsed - 파싱된 응답 본문(unknown).
 * @returns 추출한 메시지 또는 undefined.
 */
export function extractErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as { error?: unknown; outcomes?: unknown };

  if (record.error != null && record.error !== "") {
    return String(record.error);
  }

  if (Array.isArray(record.outcomes)) {
    const reasons = record.outcomes
      .map((outcome) =>
        outcome && typeof outcome === "object" && "error" in outcome
          ? (outcome as { error?: unknown }).error
          : undefined,
      )
      .filter((reason): reason is string => typeof reason === "string" && reason.length > 0);
    if (reasons.length > 0) return reasons.join("; ");
  }

  return undefined;
}

/**
 * HTTP 상태 코드와 응답 본문을 사용자에게 표시 가능한 에러 메시지로 변환합니다 (#159).
 *
 * @param status - HTTP 상태 코드
 * @param parsed - 파싱된 응답 본문
 * @returns 사용자에게 표시할 수 있는 명시적인 에러 메시지
 */
export function formatApiErrorMessage(status: number, parsed: unknown): string {
  // 먼저 구조화된 에러 메시지 추출 시도
  const extracted = extractErrorMessage(parsed);
  if (extracted) return extracted;

  // 상태 코드별 기본 메시지
  const statusMessages: Record<number, string> = {
    400: i18n.t("api.http.400"),
    401: i18n.t("api.http.401"),
    403: i18n.t("api.http.403"),
    404: i18n.t("api.http.404"),
    405: "Method Not Allowed",
    408: i18n.t("api.http.408"),
    429: i18n.t("api.http.429"),
    500: i18n.t("api.http.500"),
    502: i18n.t("api.http.502"),
    503: i18n.t("api.http.503"),
    504: "Gateway Timeout",
  };

  const baseMessage = statusMessages[status] ?? i18n.t("api.http.fallback", { status });

  // 응답에 추가 정보가 있는 경우 덧붙임
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (record.run_id) {
      return i18n.t("api.ctx.build", { base: baseMessage, id: record.run_id });
    }
    if (record.dataset_id) {
      return i18n.t("api.ctx.dataset", { base: baseMessage, id: record.dataset_id });
    }
    if (record.source_key) {
      return i18n.t("api.ctx.source", { base: baseMessage, id: record.source_key });
    }
  }

  return baseMessage;
}

/** GET /builds 응답의 단일 빌드 요약(builder contract BuildSummary 기준). */
export interface BuildSummary {
  /** 빌드 실행 식별자 */
  run_id: string;
  /**
   * 빌드 상태. Builder canonical BuildSummary 어휘는 "ok" | "failed" | "cancelled"이다
   * (취소된 run은 failed가 아니라 cancelled로 온다 — 이력/KPI에서 구분해야 한다).
   */
  status: "ok" | "failed" | "cancelled";
  /** 빌드 시작 시각(ISO 8601, null, 또는 생략됨) */
  started_at?: string | null;
  /** 빌드 완료 시각(ISO 8601, null, 또는 생략됨) */
  finished_at?: string | null;
}

/** GET /builds 응답 와이어 형태(builder contract BuildsResponse 기준). */
export interface BuildsResponse {
  builds: BuildSummary[];
}

// --- 응답 타입 (Zod 스키마에서 추출) ---

export type BuildJob = schemas.BuildJob;
export type VersionResponse = schemas.VersionResponse;
export type ValidateResponse = schemas.ValidateResponse;
export type BuildOutcome = schemas.BuildOutcome;
export type BuildResponse = schemas.BuildResponse;
export type ArtifactsResponse = schemas.ArtifactsResponse;
export type PreviewColumn = schemas.PreviewColumn;
export type PreviewSource = schemas.PreviewSource;
export type PreviewResponse = schemas.PreviewResponse;
export type CatalogQuerySupport = schemas.CatalogQuerySupport;
export type CatalogRequestParameter = schemas.CatalogRequestParameter;
export type CatalogApplication = schemas.CatalogApplication;
export type CatalogDataset = schemas.CatalogDataset;
export type CatalogProvider = schemas.CatalogProvider;
export type CatalogResponse = schemas.CatalogResponse;
export type ProviderTestResponse = schemas.ProviderTestResponse;
export type UploadMetadata = schemas.UploadMetadata;
export type ProviderSummary = schemas.ProviderSummary;
export type ProvidersResponse = schemas.ProvidersResponse;
export type ProviderCredentialResponse = schemas.ProviderCredentialResponse;
export type PreviewDiffItem = schemas.PreviewDiffItem;
export type PreviewTransformSummary = schemas.PreviewTransformSummary;
export type StageStatus = schemas.StageStatus;
export type DatasetSourceRef = schemas.DatasetSourceRef;
export type SourceStageStatus = schemas.SourceStageStatus;
export type DatasetSummary = schemas.DatasetSummary;
export type DatasetDetailResponse = schemas.DatasetDetailResponse;
export type DatasetsResponse = schemas.DatasetsResponse;
export type DatasetRunSummary = schemas.DatasetRunSummary;
export type DatasetRunsResponse = schemas.DatasetRunsResponse;
export type RunStageEntry = schemas.RunStageEntry;
export type RunStagesResponse = schemas.RunStagesResponse;
export type StageDetailResponse = schemas.StageDetailResponse;
export type QualityCheckResult = schemas.QualityCheckResult;
export type SchemaDriftFinding = schemas.SchemaDriftFinding;
export type BuildQualityResponse = schemas.BuildQualityResponse;
export type DatasetQualityHistoryEntry = schemas.DatasetQualityHistoryEntry;
export type DatasetQualityHistoryResponse = schemas.DatasetQualityHistoryResponse;
export type QualitySummaryResponse = schemas.QualitySummaryResponse;
export type QueryStage = schemas.QueryStage;
export type QueryRequest = schemas.QueryRequest;
export type QueryResponse = schemas.QueryResponse;
export type QueryErrorCode = schemas.QueryErrorCode;
export type PublishTarget = schemas.PublishTarget;
export type PublishIssue = schemas.PublishIssue;
export type PublishReadinessResponse = schemas.PublishReadinessResponse;
export type PublishHuggingFaceOptions = schemas.PublishHuggingFaceOptions;
export type PublishRequest = schemas.PublishRequest;
export type PublishResponse = schemas.PublishResponse;
export type PublishErrorCode = schemas.PublishErrorCode;
export type PublishErrorResponse = schemas.PublishErrorResponse;
export type PublishBlockedResponse = schemas.PublishBlockedResponse;
export type BuildSpecSnapshotResponse = schemas.BuildSpecSnapshotResponse;
export type BuildEventName = schemas.BuildEventName;
export type BuildEventStatus = schemas.BuildEventStatus;
export type BuildEventStageName = schemas.BuildEventStageName;
export type BuildEvent = schemas.BuildEvent;
export type BuildEventsResponse = schemas.BuildEventsResponse;

/** Builder service 엔드포인트를 감싼 클라이언트. */
export const builderApi = {
  /** GET /version — 계약 버전 확인(메타). */
  version: (signal?: AbortSignal) =>
    apiFetch("/version", { signal }, schemas.versionResponseSchema),

  /** POST /validate — BuildSpec YAML 검증. */
  validate: (specYaml: string, signal?: AbortSignal) =>
    apiFetch("/validate", { method: "POST", body: { spec: specYaml }, signal }, schemas.validateResponseSchema),

  /**
   * POST /preview — BuildSpec 기반 샘플 미리보기.
   *
   * `options`는 #497 sampling 계약(limit 1~1000·기본 5, sample_mode first/random,
   * seed)을 그대로 전달한다. 생략하면 기존 client와 동일하게 상위 5행을 반환한다.
   */
  preview: (
    specYaml: string,
    options?: { limit?: number; sample_mode?: "first" | "random"; seed?: number },
    signal?: AbortSignal,
  ) =>
    apiFetch(
      "/preview",
      { method: "POST", body: { spec: specYaml, ...options }, signal },
      schemas.previewResponseSchema,
    ),

  /** POST /build — 빌드 실행. run_id 생략 가능. 비멱등 요청이므로 재시도하지 않는다 (#117). */
  build: (specYaml: string, runId?: string, signal?: AbortSignal) =>
    apiFetch(
      "/build",
      {
        method: "POST",
        body: runId ? { spec: specYaml, run_id: runId } : { spec: specYaml },
        signal,
        retries: 0,
      },
      schemas.buildResponseSchema,
    ),

  /** POST /builds — 비동기 build job 제출 (#245, builder #482/#480). 재시도하지 않는다. */
  submitBuild: (specYaml: string, runId?: string, signal?: AbortSignal) =>
    apiFetch(
      "/builds",
      {
        method: "POST",
        body: runId ? { spec: specYaml, run_id: runId } : { spec: specYaml },
        signal,
        retries: 0,
      },
      schemas.buildJobSchema,
    ),

  /** GET /builds/{run_id} — 비동기 build job 상태 polling (#245, builder #482/#480). */
  getBuildJob: (runId: string, signal?: AbortSignal) =>
    apiFetch(
      `/builds/${encodeURIComponent(runId)}`,
      { signal, retries: 1 },
      schemas.buildJobSchema,
    ),

  /**
   * POST /builds/{run_id}/cancel — 진행 중인 async build job의 협조적 취소 요청
   * (#245, builder #481). queued/running → cancelling/cancelled로 전이한다. 취소는
   * side effect가 있는 비멱등 요청이므로 재시도하지 않는다. 응답은 최신 job 스냅샷이다.
   */
  cancelBuildJob: (runId: string, signal?: AbortSignal) =>
    apiFetch(
      `/builds/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", signal, retries: 0 },
      schemas.buildJobSchema,
    ),

  /** GET /artifacts/{runId} — 실행 산출물 파일 목록. */
  artifacts: (runId: string, signal?: AbortSignal) =>
    apiFetch(`/artifacts/${encodeURIComponent(runId)}`, { signal }, schemas.artifactsResponseSchema),

  /** GET /builds/{runId}/manifest — Builder가 기록한 authoritative manifest 본문. */
  getBuildManifest: (runId: string, signal?: AbortSignal) =>
    apiFetch(
      `/builds/${encodeURIComponent(runId)}/manifest`,
      { signal },
      schemas.buildManifestResponseSchema,
    ),

  /** GET /builds — 빌드 이력 목록(#153, builder #250). */
  listBuilds: (limit?: number, signal?: AbortSignal) => {
    const query = limit !== undefined ? `?limit=${limit}` : "";
    return apiFetch<BuildsResponse>(`/builds${query}`, { signal });
  },

  /** GET /catalog — provider/dataset 카탈로그 (#416, BL2). */
  catalog: (signal?: AbortSignal) =>
    apiFetch("/catalog", { signal }, schemas.catalogResponseSchema),

  /** GET /datasets — 실제 built dataset 목록. `/catalog` 원천 목록과 구분한다. */
  listDatasets: (limit?: number, signal?: AbortSignal) => {
    const query = limit !== undefined ? `?limit=${limit}` : "";
    return apiFetch(`/datasets${query}`, { signal }, schemas.datasetsResponseSchema);
  },

  /** GET /datasets/{dataset_id} — latest accessible run 기준 dataset 상세. */
  getDataset: (datasetId: string, signal?: AbortSignal) =>
    apiFetch(
      `/datasets/${encodeURIComponent(datasetId)}`,
      { signal },
      schemas.datasetDetailResponseSchema,
    ),

  /** GET /datasets/{dataset_id}/runs — dataset의 접근 가능한 run history. */
  listDatasetRuns: (datasetId: string, limit?: number, signal?: AbortSignal) => {
    const query = limit !== undefined ? `?limit=${limit}` : "";
    return apiFetch(
      `/datasets/${encodeURIComponent(datasetId)}/runs${query}`,
      { signal },
      schemas.datasetRunsResponseSchema,
    );
  },

  /** GET /builds/{run_id}/stages — source별 Bronze/Silver/Gold 상태. */
  listBuildStages: (runId: string, signal?: AbortSignal) =>
    apiFetch(
      `/builds/${encodeURIComponent(runId)}/stages`,
      { signal },
      schemas.runStagesResponseSchema,
    ),

  /** GET /builds/{run_id}/stages/{stage} — 선택 source/stage의 안전한 상세. */
  getBuildStageDetail: (
    runId: string,
    stage: schemas.StageDetailResponse["stage"],
    source: string,
    limit?: number,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ source });
    if (limit !== undefined) params.set("limit", String(limit));
    return apiFetch(
      `/builds/${encodeURIComponent(runId)}/stages/${stage}?${params.toString()}`,
      { signal },
      schemas.stageDetailResponseSchema,
    );
  },

  /** GET /builds/{run_id}/quality — run scoped quality와 schema drift. */
  getBuildQuality: (runId: string, signal?: AbortSignal) =>
    apiFetch(
      `/builds/${encodeURIComponent(runId)}/quality`,
      { signal },
      schemas.buildQualityResponseSchema,
    ),

  /** GET /builds/{run_id}/publish/readiness — Builder가 계산한 게시 준비 상태. */
  getPublishReadiness: (
    runId: string,
    target: schemas.PublishTarget,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ target });
    return apiFetch(
      `/builds/${encodeURIComponent(runId)}/publish/readiness?${params.toString()}`,
      { signal, retries: 0 },
      schemas.publishReadinessResponseSchema,
    );
  },

  /** POST /builds/{run_id}/publish — 원격 side effect이므로 클라이언트 자동 재시도 금지. */
  publishBuild: (runId: string, request: schemas.PublishRequest, signal?: AbortSignal) =>
    apiFetch(
      `/builds/${encodeURIComponent(runId)}/publish`,
      { method: "POST", body: request, signal, retries: 0, timeoutMs: 0 },
      schemas.publishResponseSchema,
    ),

  /** GET /datasets/{dataset_id}/quality/history — dataset quality 이력. */
  getDatasetQualityHistory: (datasetId: string, limit?: number, signal?: AbortSignal) => {
    const query = limit !== undefined ? `?limit=${limit}` : "";
    return apiFetch(
      `/datasets/${encodeURIComponent(datasetId)}/quality/history${query}`,
      { signal },
      schemas.datasetQualityHistoryResponseSchema,
    );
  },

  /**
   * POST /query — server-resolved Silver/Gold table에 read-only SQL 실행 (#504, 1.7.0).
   *
   * Bronze는 Builder가 거부한다(Studio도 UI 단에서 선제 차단, `features/kubi/query.ts`).
   * SQL은 사용자가 명시적으로 실행을 선택했을 때만 호출해야 하며, 자동 재시도하지 않는다
   * (429/504가 이미 포화·타임아웃 신호이므로 재시도가 상황을 악화시킬 수 있다).
   */
   query: (request: schemas.QueryRequest, signal?: AbortSignal) =>
     apiFetch(
       "/query",
       { method: "POST", body: request, signal, retries: 0 },
       schemas.queryResponseSchema,
     ),

  /**
   * GET /monitoring/summary — Builder API/Queue/Workers/Artifact Store 시스템
   * 상태 요약 (#516). 개인 데이터는 포함하지 않는다.
   */
  getMonitoringSummary: (signal?: AbortSignal) =>
    apiFetch(
      "/monitoring/summary",
      { signal },
      schemas.monitoringSummaryResponseSchema,
    ),

  /**
   * GET /monitoring/builds — 24시간 시간별 build 통계와 recent runs (#516).
   * ENFORCE_OWNERSHIP에서는 요청 principal이 접근 가능한 run만 집계된다.
   */
  getMonitoringBuilds: (signal?: AbortSignal) =>
    apiFetch(
      "/monitoring/builds?window=24h&bucket=hour",
      { signal },
      schemas.monitoringBuildsResponseSchema,
    ),

  /**
   * GET /quality/summary — 최근 24h cross-run quality aggregate (Builder 1.22.0, #486 후속).
   * Home "QUALITY WARN (24H)" KPI가 이 값을 authoritative하게 읽는다. 1.21.0 이하
   * Builder에서는 404이므로 호출부가 이 KPI만 독립적으로 "확인 불가" 처리한다 —
   * 다른 KPI/Recent Builds는 영향받지 않는다.
   */
  getQualitySummary: (signal?: AbortSignal) =>
    apiFetch(
      "/quality/summary?window=24h",
      { signal },
      schemas.qualitySummaryResponseSchema,
    ),

  /**
   * POST /providers/{provider}/test — 현재 principal credential로 lightweight
   * connection test 실행 (#492). Add Data의 Public API 단계에서 "연결 테스트"
   * 버튼이 호출한다. credential 값 자체는 Studio가 주고받지 않는다 — Builder가
   * 서버에 저장된 credential(또는 무인증 provider)로 직접 검사한다.
   */
  /**
   * GET /providers — 런타임 Provider 목록과 현재 principal의 configured 상태(#492).
   * 응답은 부울 요약만 담는다 — credential 원문은 어디에도 존재하지 않는다.
   */
  listProviders: (signal?: AbortSignal) =>
    apiFetch(
      "/providers",
      { signal },
      schemas.providersResponseSchema,
    ),

  testProviderConnection: (provider: string, signal?: AbortSignal) =>
    apiFetch(
      `/providers/${encodeURIComponent(provider)}/test`,
      { method: "POST", signal, retries: 0 },
      schemas.providerTestResponseSchema,
    ),

  /**
   * GET /providers/{provider}/status — 서버에 저장된 credential(또는 무인증 provider)로
   * 실행하는 lightweight connection 점검 (#259, builder provider credentials API).
   * credential 원문은 주고받지 않는다. 응답 형태는 POST /providers/{provider}/test와 공통이다.
   */
  getProviderStatus: (provider: string, signal?: AbortSignal) =>
    apiFetch(
      `/providers/${encodeURIComponent(provider)}/status`,
      { signal, retries: 1 },
      schemas.providerTestResponseSchema,
    ),

  /**
   * GET /providers/{provider}/credential — 현재 principal이 저장한 credential의
   * 메타데이터(#259, ADR 0012). `{ configured, masked, updated_at }`만 반환하며 raw
   * secret은 포함하지 않는다. GET /providers 요약의 `configured`(effective provider
   * configuration)와 달리 이 `configured`는 "이 사용자가 직접 저장한 credential이
   * 있는지"만 뜻한다.
   */
  getProviderCredential: (provider: string, signal?: AbortSignal) =>
    apiFetch(
      `/providers/${encodeURIComponent(provider)}/credential`,
      { signal, retries: 1 },
      schemas.providerCredentialResponseSchema,
    ),

  /**
   * PUT /providers/{provider}/credential — raw credential 등록/교체 (#259).
   * body는 `{ credential }` 하나뿐이고, 응답에는 원문이 존재하지 않는다(Studio도
   * 저장/로그/echo하지 않는다). 비멱등 side effect이므로 재시도하지 않는다.
   */
  putProviderCredential: (provider: string, credential: string, signal?: AbortSignal) =>
    apiFetch<unknown>(
      `/providers/${encodeURIComponent(provider)}/credential`,
      { method: "PUT", body: { credential }, signal, retries: 0 },
    ),

  /** DELETE /providers/{provider}/credential — 저장된 credential 제거 (#259). */
  deleteProviderCredential: (provider: string, signal?: AbortSignal) =>
    apiFetch<unknown>(
      `/providers/${encodeURIComponent(provider)}/credential`,
      { method: "DELETE", signal, retries: 0 },
    ),

  /**
   * GET /builds/{run_id}/spec — 실행에 사용한 canonical(redaction된) BuildSpec snapshot (#487).
   *
   * legacy run(snapshot 없음)은 404다 — Studio는 이를 "정보 없음"이 아니라
   * "snapshot unavailable"로 구분해서 표시해야 한다.
   */
  getBuildSpecSnapshot: (runId: string, signal?: AbortSignal) =>
    apiFetch(
      `/builds/${encodeURIComponent(runId)}/spec`,
      { signal },
      schemas.buildSpecSnapshotResponseSchema,
    ),

  /**
   * GET /builds/{run_id}/events — append-only structured run event timeline (#496).
   *
   * `tail: true`면 최신 `limit`개를 고르되 반환은 항상 chronological ascending이다.
   */
  getBuildEvents: (
    runId: string,
    options?: { limit?: number; tail?: boolean },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.tail !== undefined) params.set("tail", String(options.tail));
    const query = params.toString();
    return apiFetch(
      `/builds/${encodeURIComponent(runId)}/events${query ? `?${query}` : ""}`,
      { signal },
      schemas.buildEventsResponseSchema,
    );
  },

  // uploadFile은 JSON이 아닌 raw body를 보내야 해서 apiFetch를 쓰지 않는 별도 함수로
  // 아래에 정의한다(함수 선언은 호이스팅되므로 여기서 참조할 수 있다).
  uploadFile,
  // downloadArtifactFile도 응답이 바이너리라 apiFetch를 쓰지 않는 별도 함수다.
  downloadArtifactFile,
};

/**
 * POST /uploads — kind="file" source용 파일 업로드 (#498).
 *
 * 요청 body가 JSON이 아니라 raw bytes(`application/octet-stream`)라 `apiFetch`의
 * JSON-only 경로를 재사용할 수 없다. 인증/재시도/타임아웃 관례는 최대한 맞추되
 * (Bearer 헤더는 authTokenProvider를 그대로 사용), 비멱등 업로드이므로 재시도는
 * 하지 않는다. `format`/`encoding`/`filename`은 query parameter로 보낸다.
 */
export async function uploadFile(
  bytes: Blob | ArrayBuffer,
  options: { format: "csv" | "json" | "jsonl" | "parquet"; encoding?: string; filename?: string },
  signal?: AbortSignal,
): Promise<schemas.UploadMetadata> {
  const params = new URLSearchParams({ format: options.format });
  if (options.encoding) params.set("encoding", options.encoding);
  if (options.filename) params.set("filename", options.filename);

  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  const token = (await authTokenProvider?.()) ?? null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/uploads?${params.toString()}`, {
      method: "POST",
      headers,
      body: bytes,
      signal,
    });
  } catch (cause) {
    throw new ApiError(0, i18n.t("api.connFail"), cause);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.status, i18n.t("api.badJson"));
  }

  if (!response.ok) {
    if (response.status === 401 && authErrorCallback) authErrorCallback();
    throw new ApiError(response.status, formatApiErrorMessage(response.status, parsed), parsed);
  }

  const result = schemas.uploadMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError(500, i18n.t("api.uploadMismatch"), parsed);
  }
  return result.data;
}

/** Content-Disposition 헤더에서 filename을 안전하게 뽑는다(없으면 null). 경로 구분자는 제거한다. */
function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const raw = star?.[1] ?? plain?.[1];
  if (!raw) return null;
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 인코딩되지 않은 값은 그대로 쓴다 */
  }
  // 디렉터리 성분은 버리고 파일명만 남긴다.
  return value.split(/[\\/]/).pop() || null;
}

/**
 * GET /artifacts/{run_id}/{file_path} — 실행 산출물 개별 파일을 인증된 요청으로 받는다.
 *
 * 응답이 JSON이 아니라 바이너리 파일이라 `apiFetch`의 JSON 경로를 쓸 수 없다. Bearer
 * 헤더는 `uploadFile`과 동일하게 `authTokenProvider`를 재사용하고, 401이면 동일한
 * `authErrorCallback`을 호출한다.
 *
 * `filePath`는 반드시 Builder `GET /artifacts/{run_id}` 목록이 준 canonical
 * run-relative POSIX 경로여야 한다(예: "silver/datago.air_quality/table.parquet").
 * manifest.outputs는 output_root 절대경로 + OS 구분자라 여기 넘기면 안 된다.
 * "/" 구분자는 그대로 두고 각 세그먼트만 URL 인코딩한다 — "/"를 "%2F"/"%5C"로 넣거나
 * 경로 의미를 바꾸지 않는다(traversal은 Builder가 decode 후 재검증해 거부한다).
 */
export async function downloadArtifactFile(
  runId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  const encodedPath = filePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const headers: Record<string, string> = {};
  const token = (await authTokenProvider?.()) ?? null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/artifacts/${encodeURIComponent(runId)}/${encodedPath}`, {
      method: "GET",
      headers,
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError(0, i18n.t("api.connFail"), cause);
  }

  if (!response.ok) {
    if (response.status === 401 && authErrorCallback) authErrorCallback();
    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    throw new ApiError(response.status, formatApiErrorMessage(response.status, parsed), parsed);
  }

  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get("Content-Disposition")) ??
    filePath.split("/").pop() ??
    "artifact";
  return { blob, filename };
}
