/** Builder PR #547의 publish HTTP 계약을 Studio 공용 API 계층에 연결한다. */
import {
  ApiError,
  builderApi,
  isRealBuilderEnabled,
  type PublishErrorCode,
  type PublishReadinessResponse,
  type PublishRequest,
  type PublishResponse,
  type PublishTarget,
} from "@/shared/lib/builderApi";
import { i18n } from "@/shared/i18n";
import { MOCK_PUBLISH_READINESS, mockPublishResult } from "./mockData";

/** 이 파일의 문구는 모두 `publish.errors.*` 아래에 있다(#350). */
const t = (key: string): string => i18n.t(`publish.errors.${key}`);

export type {
  PublishIssue,
  PublishReadinessResponse,
  PublishRequest,
  PublishResponse,
  PublishTarget,
} from "@/shared/lib/builderApi";

const HUGGING_FACE_DESTINATION =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function validatePublishDestination(destination: string): string | undefined {
  if (!destination.trim()) return t("destinationRequired");
  if (!HUGGING_FACE_DESTINATION.test(destination)) {
    return t("destinationFormat");
  }
  return undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * 다른 Builder 연동 엔드포인트(getDataset/listBuildStages 등, `features/datasets/api`)와
 * 동일하게 mock/real을 분기한다 — 이전에는 이 분기가 없어 mock 모드에서도 항상 실제
 * Builder 서버로 요청을 보냈고, 로컬/데모 환경(Builder 미기동)에서는 그 요청이 항상 실패해
 * readiness 카드가 사실상 항상 비어 보였다(UI audit #4). Builder가 없는 mock run_id는
 * 값을 지어내지 않고 404로 처리한다.
 */
export async function getPublishReadiness(
  runId: string,
  target: PublishTarget = "huggingface",
  signal?: AbortSignal,
): Promise<PublishReadinessResponse> {
  if (isRealBuilderEnabled()) return builderApi.getPublishReadiness(runId, target, signal);
  throwIfAborted(signal);
  const mock = MOCK_PUBLISH_READINESS[runId];
  if (!mock) throw new ApiError(404, t("readinessNotFound"));
  return mock;
}

export async function publishBuild(
  runId: string,
  request: PublishRequest,
  signal?: AbortSignal,
): Promise<PublishResponse> {
  if (isRealBuilderEnabled()) return builderApi.publishBuild(runId, request, signal);
  throwIfAborted(signal);
  const readiness = MOCK_PUBLISH_READINESS[runId];
  if (!readiness) throw new ApiError(404, t("runNotFound"));
  if (!readiness.ready || readiness.blockers.length > 0) {
    throw new ApiError(409, t("notReady"), { code: "publish_conflict" });
  }
  return mockPublishResult(runId, request.destination, request.options?.private ?? true);
}

export type PublishFailureKind = PublishErrorCode | "forbidden" | "not_found" | "network" | "invalid_request" | "readiness_changed" | "unknown";

export interface PublishFailure {
  kind: PublishFailureKind;
  message: string;
}

function errorCode(cause: ApiError): PublishErrorCode | undefined {
  if (!cause.details || typeof cause.details !== "object") return undefined;
  const code = (cause.details as { code?: unknown }).code;
  if (
    code === "unsupported_target" ||
    code === "publish_in_progress" ||
    code === "publish_state_unknown" ||
    code === "publish_conflict" ||
    code === "publish_failed"
  ) return code;
  return undefined;
}

/** 서버 원문/HTML/secret을 화면에 되비추지 않고 stable status/code만 번역한다. */
export function describePublishFailure(cause: unknown): PublishFailure {
  if (!(cause instanceof ApiError)) {
    return { kind: "unknown", message: t("unknown") };
  }

  const code = errorCode(cause);
  if (code === "publish_in_progress") {
    return { kind: code, message: t("inProgress") };
  }
  if (code === "publish_state_unknown") {
    return { kind: code, message: t("retryBlocked") };
  }
  if (code === "publish_conflict") {
    return { kind: code, message: t("visibilityConflict") };
  }
  if (code === "publish_failed" || cause.status === 502) {
    return { kind: code ?? "unknown", message: t("externalFailed") };
  }
  if (cause.status === 409) return { kind: "readiness_changed", message: t("readinessChanged") };
  if (cause.status === 403) return { kind: "forbidden", message: t("forbidden") };
  if (cause.status === 404) return { kind: "not_found", message: t("notFound") };
  if (cause.status === 0 || cause.status === 408) return { kind: "network", message: t("network") };
  if (cause.status === 400 || code === "unsupported_target") return { kind: code ?? "invalid_request", message: t("invalidRequest") };
  return { kind: "unknown", message: t("incomplete") };
}

export function isSafePublishReference(reference: string): boolean {
  try {
    const url = new URL(reference);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
